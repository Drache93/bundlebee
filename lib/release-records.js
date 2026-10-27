const b4a = require('b4a')
const ID = require('hypercore-id-encoding')
const semver = require('bare-semver')
const { getEncoding } = require('../schema')

exports.Pin = getEncoding('@bundlebee/release-pin')
exports.Manifest = getEncoding('@bundlebee/release-manifest')
exports.Module = getEncoding('@bundlebee/release-module')
exports.MANIFEST = b4a.from('#v2/release')
exports.moduleKey = (path) => b4a.from('#v2/module' + path)
exports.assetKey = (path) => b4a.from('#v2/asset' + path)
exports.error = error
exports.path = path
exports.version = version
exports.packageName = packageName
exports.validatePin = validatePin
exports.versionKey = (name, value) => b4a.from(prefix(name) + 'exact/' + value)
exports.abiKey = (name, abi) => b4a.from(prefix(name) + 'abi/' + number(abi))
exports.orderedPrefix = (name) => prefix(name) + 'ordered/'
exports.orderedKey = (name, input) => {
  const v = version(input)
  // Lexicographic bytes follow SemVer precedence, including numeric prerelease
  // identifiers and prefix identifiers. Build metadata is only a stable tie-break.
  const pre = v.prerelease.length
    ? '0' +
      v.prerelease
        .map((p) => (/^[0-9]+$/.test(p) ? '0' + number(p.length) + p : '1' + p))
        .join('\0') +
      '\0'
    : '1'
  return b4a.from(
    exports.orderedPrefix(name) +
      [v.major, v.minor, v.patch].map(number).join('.') +
      '/' +
      pre +
      '\0' +
      input
  )
}

function error(code, message, cause) {
  const err = new Error(message, cause ? { cause } : undefined)
  err.code = code
  return err
}
function number(n) {
  if (!Number.isSafeInteger(n) || n < 0) {
    throw error('ERR_INVALID_RELEASE', 'Invalid non-negative integer')
  }
  return n.toString(16).padStart(14, '0')
}
function packageName(name) {
  if (
    typeof name !== 'string' ||
    !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(name)
  ) {
    throw error('ERR_INVALID_RELEASE', 'Invalid package name')
  }
  return name
}
function prefix(name) {
  return '#v2/package/' + encodeURIComponent(packageName(name)) + '/'
}
function version(input) {
  try {
    if (typeof input !== 'string') throw new Error('Expected version string')
    const v = semver.Version.parse(input)
    for (const n of [
      v.major,
      v.minor,
      v.patch,
      ...v.prerelease.filter((p) => typeof p === 'number')
    ]) {
      number(n)
    }
    if (v.toString() !== input) throw new Error('Version must be canonical')
    return v
  } catch (cause) {
    throw error('ERR_INVALID_RELEASE', 'Invalid exact semantic version: ' + input, cause)
  }
}
function path(input) {
  if (
    typeof input !== 'string' ||
    !input.startsWith('/') ||
    input.includes('\\') ||
    /[\0-\x1f%?#:]/.test(input) ||
    input
      .split('/')
      .slice(1)
      .some((s) => !s || s === '.' || s === '..')
  ) {
    throw error('ERR_INVALID_RELEASE', 'Invalid release path: ' + input)
  }
  return input
}
function validatePin(pin) {
  if (!pin || pin.format !== 2) {
    throw error('ERR_INVALID_RELEASE', 'Expected a format 2 release pin')
  }
  let key
  try {
    key = ID.encode(ID.decode(pin.key))
  } catch (cause) {
    throw error('ERR_INVALID_RELEASE', 'Invalid release key', cause)
  }
  if (
    !Number.isSafeInteger(pin.length) ||
    pin.length < 1 ||
    !Number.isSafeInteger(pin.abi) ||
    pin.abi < 1
  ) {
    throw error('ERR_INVALID_RELEASE', 'Release length and ABI must be positive safe integers')
  }
  packageName(pin.name)
  version(pin.version)
  path(pin.entry)
  return {
    format: 2,
    key,
    length: pin.length,
    name: pin.name,
    version: pin.version,
    entry: pin.entry,
    abi: pin.abi
  }
}
