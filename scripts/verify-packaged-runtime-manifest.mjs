import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { listPackage } from '@electron/asar'
import { packagedResourcesPath } from './lib/release-artifacts.mjs'

function option(name, fallback) {
  const prefix = `--${name}=`
  const value = process.argv.slice(2).find((argument) => argument.startsWith(prefix))
  return value === undefined ? fallback : value.slice(prefix.length)
}

const resourcesRoot = resolve(option('resources', packagedResourcesPath()))
const platform = option('platform', 'win32')
const arch = option('arch', 'x64')
const libc = option('libc', 'gnu')
const archivePath = join(resourcesRoot, 'app.asar')
const unpackedRoot = `${archivePath}.unpacked`

if (!existsSync(archivePath)) throw new Error(`Packaged app archive is missing: ${archivePath}`)
if (!existsSync(unpackedRoot)) throw new Error(`Unpacked runtime payload is missing: ${unpackedRoot}`)

const entries = listPackage(archivePath).map((entry) => entry.replaceAll('\\', '/').replace(/^\/+/, ''))
const nativeEntries = entries.filter((entry) => entry.endsWith('.node'))

function hasPackage(name) {
  return entries.some((entry) => entry.endsWith(`/node_modules/${name}/package.json`)
    || entry === `node_modules/${name}/package.json`)
}

function hasNativeEntry(fragment) {
  return nativeEntries.some((entry) => entry.includes(fragment))
}

const platformArch = `${platform}-${arch}`
const onnxPlatform = platform === 'win32' ? 'win32' : platform
const sharpPlatform = platform === 'linux' && libc === 'musl' ? 'linuxmusl' : platform
const requiredPackages = [
  'node-pty',
  '@huggingface/transformers',
  'onnxruntime-node',
  'sharp',
]
const missingPackages = requiredPackages.filter((name) => !hasPackage(name))
if (missingPackages.length > 0) {
  throw new Error(`Packaged runtime dependencies are missing from app.asar: ${missingPackages.join(', ')}`)
}

const requiredNativePayloads = [
  ['node-pty', `node-pty/prebuilds/${platformArch}/pty.node`],
  ['onnxruntime-node', `onnxruntime-node/bin/napi-v6/${onnxPlatform}/${arch}/onnxruntime_binding.node`],
  ['sharp', `@img/sharp-${sharpPlatform}-${arch}/lib/sharp-${sharpPlatform}-${arch}-`],
]
const missingNativePayloads = requiredNativePayloads
  .filter(([, fragment]) => !hasNativeEntry(fragment))
  .map(([name, fragment]) => `${name}: ${fragment}`)
if (missingNativePayloads.length > 0) {
  throw new Error(`Packaged native runtime payloads are missing for ${platform}/${arch}: ${missingNativePayloads.join(', ')}`)
}

const unpackedEntries = await listFiles(unpackedRoot)
const requiredUnpackedRoots = [
  'node_modules/node-pty/',
  'node_modules/onnxruntime-node/',
  'node_modules/@huggingface/transformers/',
  'node_modules/sharp/',
  `node_modules/@img/sharp-${sharpPlatform}-${arch}/`,
]
const missingUnpackedRoots = requiredUnpackedRoots
  .filter((root) => !unpackedEntries.some((entry) => entry.startsWith(root)))
if (missingUnpackedRoots.length > 0) {
  throw new Error(`Runtime-loaded packages are not present in app.asar.unpacked: ${missingUnpackedRoots.join(', ')}`)
}
const missingUnpackedNativePayloads = requiredNativePayloads
  .filter(([, fragment]) => !unpackedEntries.some((entry) => entry.includes(fragment)))
  .map(([name, fragment]) => `${name}: ${fragment}`)
if (missingUnpackedNativePayloads.length > 0) {
  throw new Error(`Native addons are not present outside app.asar: ${missingUnpackedNativePayloads.join(', ')}`)
}

const forbiddenWindowsPayloads = platform === 'win32' && arch === 'x64'
  ? entries.filter((entry) => /node_modules\/(?:onnxruntime-node\/bin\/napi-v6\/(?:darwin|linux)(?:\/|$)|onnxruntime-node\/bin\/napi-v6\/win32\/arm64(?:\/|$)|node-pty\/prebuilds\/(?:darwin-arm64|darwin-x64|win32-arm64)(?:\/|$)|node-pty\/third_party\/conpty\/[^/]+\/win10-arm64(?:\/|$)|@img\/sharp-(?:darwin|linux|linuxmusl)-|@img\/sharp-win32-arm64|@img\/sharp-libvips-(?:darwin|linux|linuxmusl)-|@img\/sharp-libvips-win32-arm64)/u.test(entry))
  : []
if (forbiddenWindowsPayloads.length > 0) {
  throw new Error(`Windows x64 package contains native slices for other targets: ${forbiddenWindowsPayloads.slice(0, 20).join(', ')}`)
}

let nativeLoadSmoke = { status: 'not-attempted', reason: 'Host platform does not match the requested package target.' }
if (platform === process.platform && arch === process.arch) {
  const executablePath = resolve(option('executable', join(resourcesRoot, '..', 'LittleSheep.exe')))
  if (!existsSync(executablePath)) throw new Error(`Packaged Electron executable is missing: ${executablePath}`)
  const mainEntry = join(archivePath, 'out', 'main', 'index.js')
  const smoke = [
    "const { createRequire } = require('node:module')",
    'const run = async () => {',
    'const requireFromApp = createRequire(process.env.LS_PACKAGED_MAIN)',
    "const sharp = requireFromApp('sharp')",
    "const onnx = requireFromApp('onnxruntime-node')",
    "const pty = requireFromApp('node-pty')",
    "if (typeof sharp !== 'function' || typeof onnx.InferenceSession?.create !== 'function' || typeof pty.spawn !== 'function') throw new Error('A packaged native runtime module has an invalid API.')",
    "const image = await sharp({ create: { width: 1, height: 1, channels: 4, background: { r: 1, g: 2, b: 3, alpha: 1 } } }).png().toBuffer()",
    "if (image.byteLength === 0) throw new Error('Packaged sharp returned an empty image.')",
    "console.log(JSON.stringify({ sharp: sharp.versions.sharp, sharpImageBytes: image.byteLength, onnxruntime: onnx.env.versions.common, nodePty: typeof pty.spawn }))",
    '}',
    'run().catch((error) => { console.error(error); process.exitCode = 1 })',
  ].join(';')
  const stdout = execFileSync(executablePath, ['-e', smoke], {
    cwd: resourcesRoot,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      LS_PACKAGED_MAIN: mainEntry,
    },
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true,
  })
  const resultLine = stdout.trim().split(/\r?\n/u).at(-1)
  if (!resultLine) throw new Error('Packaged Electron native module smoke test returned no result.')
  nativeLoadSmoke = { status: 'passed', executablePath, modules: JSON.parse(resultLine) }
}

console.log(JSON.stringify({
  check: 'packaged-runtime-manifest',
  status: 'passed',
  resourcesRoot,
  platform,
  arch,
  libc: platform === 'linux' ? libc : undefined,
  asarEntries: entries.length,
  nativeEntries: nativeEntries.length,
  unpackedEntries: unpackedEntries.length,
  requiredPackages,
  requiredNativePayloads: requiredNativePayloads.map(([name, fragment]) => ({ name, fragment })),
  optionalPdfCanvas: {
    status: hasPackage('@napi-rs/canvas') ? 'present' : 'not-packaged',
    reason: 'PDF.js treats the Node canvas adapter as optional; LS currently extracts PDF text without rendering canvases.',
  },
  nativeLoadSmoke,
  windowsTargetSlicesTrimmed: platform === 'win32' && arch === 'x64',
  limitation: 'The host-native smoke loads ONNX Runtime and node-pty and performs a one-pixel sharp encode; it does not prove model inference, full image workloads, or PTY behavior.',
}, null, 2))

async function listFiles(root, prefix = '') {
  const output = []
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) output.push(...await listFiles(root, path))
    else if (entry.isFile()) output.push(path.replaceAll('\\', '/'))
  }
  return output
}
