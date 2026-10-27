const fs = require('fs')
const { pathToFileURL, fileURLToPath } = require('url-file-url')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { error } = require('./release-records')

module.exports = async function materialize(pin, assets, directory, target, signal) {
  const urls = new Map()
  if (assets.size === 0) return urls
  if (!directory) {
    throw error('ERR_ASSET_DIRECTORY_REQUIRED', 'An assetDirectory is required for release assets')
  }
  const rootPath =
    typeof directory === 'object' && directory !== null
      ? fileURLToPath(new URL(directory.href))
      : directory
  await fs.promises.mkdir(rootPath, { recursive: true })
  const realRoot = await fs.promises.realpath(rootPath)
  const root = pathToFileURL(realRoot + '/')
  const folder = `${pin.key}-${pin.length}-${target.platform}-${target.arch}/`
  const base = new URL(folder, root)
  await ensureDirectory(base, root)
  for (const [path, bytes] of assets) {
    if (signal?.aborted) throw error('ABORT_ERR', 'Release operation aborted')
    const url = new URL('.' + path, base)
    await ensureDirectory(new URL('./', url), root)
    const filename = fileURLToPath(url)
    try {
      const stat = await fs.promises.lstat(filename)
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw error('ERR_ASSET_PATH', 'Asset cache path is not a regular file')
      }
      const existing = await fs.promises.readFile(filename)
      if (b4a.equals(existing, bytes)) {
        urls.set(path, url)
        continue
      }
    } catch (err) {
      if (err.code !== 'ENOENT') throw err
    }
    const temporary = filename + '.' + b4a.toString(crypto.randomBytes(16), 'hex') + '.tmp'
    try {
      await fs.promises.writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 })
      await fs.promises.rename(temporary, filename)
    } finally {
      await fs.promises.unlink(temporary).catch((err) => {
        if (err.code !== 'ENOENT') throw err
      })
    }
    urls.set(path, url)
  }
  return urls
}

async function ensureDirectory(url, root) {
  if (!url.href.startsWith(root.href)) {
    throw error('ERR_ASSET_PATH', 'Asset path escapes cache directory')
  }
  let current = root
  for (const segment of url.href.slice(root.href.length).split('/').filter(Boolean)) {
    current = new URL(segment + '/', current)
    const filename = fileURLToPath(current).replace(/[\\/]$/, '')
    try {
      await fs.promises.mkdir(filename)
    } catch (err) {
      if (err.code !== 'EEXIST') throw err
    }
    const stat = await fs.promises.lstat(filename)
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw error('ERR_ASSET_PATH', 'Asset cache contains a symlink or non-directory')
    }
  }
}
