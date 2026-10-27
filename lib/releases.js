const fs = require('fs')
const b4a = require('b4a')
const c = require('compact-encoding')
const ID = require('hypercore-id-encoding')
const semver = require('bare-semver')
const Module = require('bare-module')
const traverse = require('bare-module-traverse')
const { fileURLToPath, pathToFileURL } = require('url-file-url')
const records = require('./release-records')
const materialize = require('./release-assets')
const { error, validatePin, MANIFEST } = records
const publishing = new Map()

exports.validatePin = validatePin
exports.publish = publish
exports.resolve = resolve
exports.prefetch = prefetch
exports.load = load

async function exclusive(bee, fn) {
  const key = ID.encode(bee.key)
  const previous = publishing.get(key) || Promise.resolve()
  let unlock
  const next = new Promise((resolve) => {
    unlock = resolve
  })
  publishing.set(key, next)
  await previous
  try {
    return await fn()
  } finally {
    unlock()
    if (publishing.get(key) === next) publishing.delete(key)
  }
}

async function publish(bee, root, entry, options = {}) {
  await bee.ready()
  if (!bee.core.writable) {
    throw error('ERR_RELEASE_READ_ONLY', 'Cannot publish to a read-only bundle')
  }
  const name = records.packageName(options.name)
  records.version(options.version)
  const version = options.version
  if (!Number.isSafeInteger(options.abi) || options.abi < 1) {
    throw error('ERR_INVALID_RELEASE', 'A positive release ABI is required')
  }
  const abi = options.abi
  if (!root || typeof root.href !== 'string' || root.protocol !== 'file:') {
    throw error('ERR_INVALID_RELEASE', 'Publish root must be a file URL')
  }
  root = new URL(root.href)
  if (!root.pathname.endsWith('/')) root = new URL('./', root)
  const realRoot =
    pathToFileURL(await fs.promises.realpath(fileURLToPath(root))).href.replace(/\/$/, '') + '/'
  async function confined(url) {
    const actual = pathToFileURL(await fs.promises.realpath(fileURLToPath(url))).href
    if (actual !== realRoot.slice(0, -1) && !actual.startsWith(realRoot)) {
      throw error('ERR_INVALID_RELEASE', 'Module or asset is outside publish root: ' + url.href)
    }
  }
  async function readScoped(url) {
    try {
      await confined(url)
    } catch (err) {
      if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return null
      throw err
    }
    return read(url)
  }
  async function readAsset(url) {
    await confined(url)
    return fs.promises.readFile(fileURLToPath(url))
  }
  async function* listScoped(url) {
    try {
      await confined(url)
    } catch (err) {
      if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return
      throw err
    }
    for await (const entry of list(url)) {
      await confined(entry)
      yield entry
    }
  }
  const entryURL = new URL(entry, root)
  const entryPath = relative(root, entryURL)
  const hosts = normalizeHosts(options.hostRequirements || {})
  const hostNames = new Set(hosts.map((host) => host.specifier))
  const files = new Map()
  const assets = new Map()
  const metadata = new Map()
  for (const item of options.assets || []) {
    const asset = typeof item === 'string' ? { path: item } : item
    const path = records.path(asset.path.startsWith('/') ? asset.path : '/' + asset.path)
    const platform = targetPart(asset.platform || '')
    const arch = targetPart(asset.arch || '')
    metadata.set(path, { path, platform, arch })
    assets.set(path, await readAsset(new URL('.' + path, root)))
  }
  function* resolver(imported, parent, opts) {
    if (hostNames.has(imported.specifier)) {
      yield { resolution: new URL('builtin:' + imported.specifier) }
      return
    }
    yield* traverse.resolve.bare(imported, parent, opts)
  }
  const iterator = traverse(
    entryURL,
    { resolve: resolver, ...(options.platforms ? { hosts: options.platforms } : {}) },
    readScoped,
    listScoped
  )[Symbol.asyncIterator]()
  while (true) {
    const next = await iterator.next()
    if (next.done) {
      for (const url of [...(next.value?.assets || []), ...(next.value?.addons || [])]) {
        const path = relative(root, url)
        assets.set(path, await readAsset(url))
        if (!metadata.has(path)) metadata.set(path, { path, platform: '', arch: '' })
      }
      break
    }
    const dependency = next.value
    const path = relative(root, dependency.url)
    files.set(path, {
      source: dependency.source,
      resolutions: JSON.stringify(
        mapResolutions(dependency.imports, (url) =>
          url.startsWith('builtin:') ? url : relative(root, new URL(url))
        )
      )
    })
  }
  // Explicit assets also participate in traversal's resolution map when used by require.asset().
  const manifest = {
    format: 2,
    name,
    version,
    entry: entryPath,
    abi,
    files: [...files.keys()].sort(),
    assets: [...metadata.values()],
    hosts
  }
  if (!files.has(entryPath)) {
    throw error('ERR_INVALID_RELEASE', 'Entry was not included in the module graph')
  }
  return exclusive(bee, async () => {
    const tree = bee._bee
    const versionKey = records.versionKey(name, version)
    const abiKey = records.abiKey(name, abi)
    const snapshot = tree.write()
    await snapshot.lock()
    try {
      if ((await tree.get(versionKey)) || (await tree.get(abiKey))) {
        throw error('ERR_RELEASE_EXISTS', 'Version or ABI already published')
      }
      for (const [path, value] of files) {
        snapshot.tryPut(records.moduleKey(path), c.encode(records.Module, value))
      }
      for (const [path, bytes] of assets) snapshot.tryPut(records.assetKey(path), bytes)
      snapshot.tryPut(MANIFEST, c.encode(records.Manifest, manifest))
      await snapshot.flush()
    } catch (err) {
      await snapshot.close()
      snapshot._unlock()
      throw err
    }
    const pin = validatePin({
      format: 2,
      key: ID.encode(snapshot.root.context.core.key),
      length: snapshot.root.seq + 1,
      name,
      version,
      entry: entryPath,
      abi
    })
    const index = tree.write()
    await index.lock()
    try {
      if ((await tree.get(versionKey)) || (await tree.get(abiKey))) {
        throw error('ERR_RELEASE_EXISTS', 'Version or ABI already published')
      }
      const encoded = c.encode(records.Pin, pin)
      index.tryPut(versionKey, encoded)
      index.tryPut(abiKey, encoded)
      index.tryPut(records.orderedKey(name, version), encoded)
      await index.flush()
    } catch (err) {
      await index.close()
      index._unlock()
      throw err
    }
    return pin
  })
}

async function resolve(bee, query = {}) {
  records.packageName(query.name)
  if ((query.version === undefined) === (query.abi === undefined)) {
    throw error('ERR_INVALID_RELEASE', 'Select exactly one version range or ABI')
  }
  return operation(bee, null, query, async (tree, config) => {
    if (query.abi !== undefined) {
      if (!Number.isSafeInteger(query.abi) || query.abi < 1) {
        throw error('ERR_INVALID_RELEASE', 'Invalid ABI')
      }
      const record = await tree.get(records.abiKey(query.name, query.abi), config)
      if (record) return indexedPin(bee, record, query, false)
    } else {
      if (typeof query.version !== 'string') {
        throw error('ERR_INVALID_RELEASE', 'Version range must be a string')
      }
      let exact = false
      try {
        records.version(query.version)
        exact = true
      } catch {}
      if (exact) {
        const record = await tree.get(records.versionKey(query.name, query.version), config)
        if (record) return indexedPin(bee, record, query, false)
      } else {
        let range
        try {
          range = semver.Range.parse(query.version)
        } catch (cause) {
          throw error('ERR_INVALID_RELEASE', 'Invalid semantic version range', cause)
        }
        const prefix = records.orderedPrefix(query.name)
        for await (const record of tree.createReadStream({
          ...config,
          gte: b4a.from(prefix),
          lt: b4a.from(prefix + '\uffff'),
          reverse: true
        })) {
          const pin = indexedPin(bee, record, query, true)
          if (range.test(semver.Version.parse(pin.version))) return pin
        }
      }
    }
    throw error('ERR_RELEASE_NOT_FOUND', 'No matching published release for ' + query.name)
  })
}

function indexedPin(bee, record, query, ordered) {
  const pin = validatePin(c.decode(records.Pin, record.value))
  const expected = ordered
    ? records.orderedKey(query.name, pin.version)
    : query.abi === undefined
      ? records.versionKey(query.name, query.version)
      : records.abiKey(query.name, query.abi)
  if (
    pin.key !== ID.encode(bee.key) ||
    pin.name !== query.name ||
    !b4a.equals(record.key, expected) ||
    (!ordered && query.abi === undefined && pin.version !== query.version) ||
    (query.abi !== undefined && pin.abi !== query.abi)
  ) {
    throw error('ERR_INVALID_RELEASE', 'Release index disagrees with its publisher or selector')
  }
  return pin
}

async function prefetch(bee, input, options = {}) {
  const pin = validatePin(input)
  await readRelease(bee, pin, options)
  return pin
}

async function readRelease(bee, pin, options) {
  await bee.ready()
  if (ID.encode(bee.key) !== pin.key) {
    throw error('ERR_INVALID_RELEASE', 'Release key does not match this bundle')
  }
  return operation(bee, pin, options, async (tree, config) => {
    const record = await tree.get(MANIFEST, config)
    if (!record) throw error('ERR_INVALID_RELEASE', 'Pinned snapshot has no release manifest')
    const manifest = c.decode(records.Manifest, record.value)
    for (const field of ['format', 'name', 'version', 'entry', 'abi']) {
      if (manifest[field] !== pin[field]) {
        throw error('ERR_INVALID_RELEASE', 'Pin disagrees with release manifest: ' + field)
      }
    }
    const files = new Map()
    for (const path of manifest.files) {
      records.path(path)
      const value = await tree.get(records.moduleKey(path), config)
      if (!value) throw error('ERR_INVALID_RELEASE', 'Missing release module: ' + path)
      const file = c.decode(records.Module, value.value)
      files.set(path, { source: file.source, resolutions: JSON.parse(file.resolutions) })
    }
    const assets = new Map()
    for (const asset of manifest.assets) {
      records.path(asset.path)
      const value = await tree.get(records.assetKey(asset.path), config)
      if (!value) throw error('ERR_INVALID_RELEASE', 'Missing release asset: ' + asset.path)
      assets.set(asset.path, value.value)
    }
    if (!files.has(pin.entry)) throw error('ERR_INVALID_RELEASE', 'Release entry not present')
    return { manifest, files, assets }
  })
}

async function load(bee, input, options = {}) {
  await bee.ready()
  const pin = validatePin(input)
  const { manifest, files, assets } = await readRelease(bee, pin, options)
  const platform = options.platform || {}
  const target = {
    platform: targetPart(platform.platform || Bare.platform),
    arch: targetPart(platform.arch || Bare.arch)
  }
  const builtins = Object.create(null)
  for (const required of manifest.hosts) {
    const provider = options.hostProviders?.[required.specifier]
    let compatible = false
    try {
      compatible =
        provider &&
        semver.satisfies(provider.version, required.version) &&
        (!required.abi || String(provider.abi) === required.abi) &&
        (!required.platform || provider.platform === required.platform) &&
        (!required.arch || provider.arch === required.arch)
    } catch {}
    if (!compatible || !Object.hasOwn(provider, 'exports')) {
      throw error(
        'ERR_HOST_INCOMPATIBLE',
        'Missing or incompatible host provider: ' + required.specifier
      )
    }
    builtins[required.specifier] = provider.exports
  }
  const selected = new Map()
  for (const asset of manifest.assets) {
    if (
      (!asset.platform || asset.platform === target.platform) &&
      (!asset.arch || asset.arch === target.arch)
    ) {
      selected.set(asset.path, assets.get(asset.path))
    }
  }
  const assetURLs = await materialize(pin, selected, options.assetDirectory, target, options.signal)
  const origin = 'bundle://' + pin.key + '-' + pin.length
  const href = (path) => new URL(path, origin).href
  const resolutions = Object.create(null)
  const sources = new Map()
  for (const [path, file] of files) {
    if (!assets.has(path) || selected.has(path)) sources.set(href(path), file.source)
    resolutions[href(path)] = mapResolutions(file.resolutions, (path) => {
      if (path.startsWith('builtin:')) {
        if (!Object.hasOwn(builtins, path.slice(8))) {
          throw error('ERR_HOST_INCOMPATIBLE', 'Undeclared host module')
        }
        return path
      }
      records.path(path)
      if (assets.has(path) && !selected.has(path)) return undefined
      return assetURLs.get(path)?.href || href(path)
    })
  }
  const cachedAssets = new Map([...assetURLs].map(([path, url]) => [url.href, selected.get(path)]))
  const protocol = new Module.Protocol({
    exists(url) {
      return (
        sources.has(url.href) ||
        cachedAssets.has(url.href) ||
        assetURLs.has(decodeURIComponent(url.pathname))
      )
    },
    read(url) {
      return (
        sources.get(url.href) ||
        cachedAssets.get(url.href) ||
        selected.get(decodeURIComponent(url.pathname)) ||
        null
      )
    },
    resolve(url) {
      const path = decodeURIComponent(url.pathname)
      if (assets.has(path) && !selected.has(path)) {
        throw error('ERR_ASSET_UNAVAILABLE', 'Asset is unavailable for this platform: ' + path)
      }
      return assetURLs.get(path) || url
    }
  })
  if (options.signal?.aborted) throw error('ABORT_ERR', 'Release operation aborted')
  return Module.load(new URL(pin.entry, origin), {
    protocol,
    resolutions,
    builtins,
    cache: Object.create(null)
  })
}

async function operation(bee, pin, options, fn) {
  await bee.ready()
  const offline = options.offline ?? bee.offline
  const activeRequests = []
  const config = { wait: !offline, activeRequests }
  const tree = pin
    ? bee._bee.checkout({ key: ID.decode(pin.key), length: pin.length, wait: !offline })
    : bee._bee.snapshot({ wait: !offline })
  const aborted = () => error('ABORT_ERR', 'Release operation aborted')
  const abort = () => bee.core.constructor.destroyRequests(activeRequests, aborted())
  if (options.signal?.aborted) {
    await tree.close()
    throw aborted()
  }
  options.signal?.addEventListener('abort', abort, { once: true })
  try {
    const result = await fn(tree, config)
    if (options.signal?.aborted) throw aborted()
    return result
  } catch (cause) {
    if (options.signal?.aborted) throw aborted()
    if (
      offline &&
      (cause.code === 'BLOCK_NOT_AVAILABLE' ||
        cause.code === 'ERR_BLOCK_NOT_AVAILABLE' ||
        cause.code === 'SNAPSHOT_NOT_AVAILABLE')
    ) {
      throw error('ERR_RELEASE_NOT_CACHED', 'Pinned release is not fully cached', cause)
    }
    throw cause
  } finally {
    options.signal?.removeEventListener('abort', abort)
    bee.core.constructor.destroyRequests(activeRequests)
    await tree.close()
  }
}

function normalizeHosts(hosts) {
  return Object.entries(hosts).map(([specifier, requirement]) => {
    if (
      typeof requirement.version !== 'string' ||
      !specifier ||
      specifier.startsWith('.') ||
      specifier.startsWith('/') ||
      specifier.includes(':')
    ) {
      throw error('ERR_INVALID_RELEASE', 'Invalid host requirement')
    }
    semver.Range.parse(requirement.version)
    return {
      specifier,
      version: requirement.version,
      abi: requirement.abi === undefined ? '' : String(requirement.abi),
      platform: targetPart(requirement.platform || ''),
      arch: targetPart(requirement.arch || '')
    }
  })
}
function targetPart(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]*$/.test(value)) {
    throw error('ERR_INVALID_RELEASE', 'Invalid platform selector')
  }
  return value
}
function relative(root, url) {
  if (url.protocol !== 'file:' || !url.href.startsWith(root.href)) {
    throw error('ERR_INVALID_RELEASE', 'Module or asset is outside publish root: ' + url.href)
  }
  return records.path('/' + decodeURIComponent(url.href.slice(root.href.length)))
}
function mapResolutions(value, map) {
  if (typeof value === 'string') return map(value)
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw error('ERR_INVALID_RELEASE', 'Invalid module resolution map')
  }
  return Object.fromEntries(
    Object.entries(value)
      .map(([key, child]) => [key, mapResolutions(child, map)])
      .filter(([, child]) => child !== undefined)
  )
}
async function read(url) {
  try {
    return await fs.promises.readFile(fileURLToPath(url))
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return null
    throw err
  }
}
async function* list(url) {
  let stat
  try {
    stat = await fs.promises.stat(fileURLToPath(url))
  } catch (err) {
    if (err.code === 'ENOENT') return
    throw err
  }
  if (stat.isFile()) {
    yield url
    return
  }
  const base = url.href.endsWith('/') ? url : new URL(url.href + '/')
  for (const entry of await fs.promises.readdir(fileURLToPath(base), { withFileTypes: true })) {
    const child = new URL(encodeURIComponent(entry.name), base)
    if (entry.isDirectory()) yield* list(child)
    else yield child
  }
}
