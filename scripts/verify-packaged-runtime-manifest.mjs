import { spawnSync } from 'node:child_process'
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

// node-pty's native loader checks build/Release, build/Debug, then prebuilds/<platform>-<arch>.
// Linux x64 currently installs from source in this workspace, so a valid packaged addon can be
// under build/Release even though no linux-x64 prebuild exists in the npm tarball. Linux uses
// forkpty directly; spawn-helper is only invoked by node-pty's macOS posix_spawn implementation.
const requiredNativePayloads = [
  {
    name: 'node-pty',
    fragments: platform === 'linux'
      ? [`node-pty/prebuilds/${platformArch}/pty.node`, 'node-pty/build/Release/pty.node']
      : [`node-pty/prebuilds/${platformArch}/pty.node`],
  },
  {
    name: 'onnxruntime-node',
    fragments: [`onnxruntime-node/bin/napi-v6/${onnxPlatform}/${arch}/onnxruntime_binding.node`],
  },
  {
    name: 'sharp',
    fragments: [`@img/sharp-${sharpPlatform}-${arch}/lib/sharp-${sharpPlatform}-${arch}-`],
  },
]
const requiredRuntimeSidecars = platform === 'linux'
  ? [{
      name: 'sharp-libvips',
      fragments: [`@img/sharp-libvips-${sharpPlatform}-${arch}/lib/libvips-cpp.so`],
    }]
  : []
function findEntry(entries, fragments) {
  return entries.find((entry) => fragments.some((fragment) => entry.includes(fragment)))
}
const missingNativePayloads = requiredNativePayloads
  .filter(({ fragments }) => !findEntry(nativeEntries, fragments))
  .map(({ name, fragments }) => `${name}: one of ${fragments.join(' or ')}`)
if (missingNativePayloads.length > 0) {
  throw new Error(`Packaged native runtime payloads are missing for ${platform}/${arch}: ${missingNativePayloads.join(', ')}`)
}
const missingRuntimeSidecars = requiredRuntimeSidecars
  .filter(({ fragments }) => !findEntry(entries, fragments))
  .map(({ name, fragments }) => `${name}: one of ${fragments.join(' or ')}`)
if (missingRuntimeSidecars.length > 0) {
  throw new Error(`Packaged native runtime sidecars are missing for ${platform}/${arch}: ${missingRuntimeSidecars.join(', ')}`)
}

const unpackedEntries = await listFiles(unpackedRoot)
const requiredUnpackedRoots = [
  'node_modules/node-pty/',
  'node_modules/onnxruntime-node/',
  'node_modules/@huggingface/transformers/',
  'node_modules/sharp/',
  `node_modules/@img/sharp-${sharpPlatform}-${arch}/`,
  ...(platform === 'linux' ? [`node_modules/@img/sharp-libvips-${sharpPlatform}-${arch}/`] : []),
]
const missingUnpackedRoots = requiredUnpackedRoots
  .filter((root) => !unpackedEntries.some((entry) => entry.startsWith(root)))
if (missingUnpackedRoots.length > 0) {
  throw new Error(`Runtime-loaded packages are not present in app.asar.unpacked: ${missingUnpackedRoots.join(', ')}`)
}
const missingUnpackedNativePayloads = requiredNativePayloads
  .filter(({ fragments }) => !findEntry(unpackedEntries, fragments))
  .map(({ name, fragments }) => `${name}: one of ${fragments.join(' or ')}`)
if (missingUnpackedNativePayloads.length > 0) {
  throw new Error(`Native addons are not present outside app.asar: ${missingUnpackedNativePayloads.join(', ')}`)
}
const missingUnpackedRuntimeSidecars = requiredRuntimeSidecars
  .filter(({ fragments }) => !findEntry(unpackedEntries, fragments))
  .map(({ name, fragments }) => `${name}: one of ${fragments.join(' or ')}`)
if (missingUnpackedRuntimeSidecars.length > 0) {
  throw new Error(`Native runtime sidecars are not present outside app.asar: ${missingUnpackedRuntimeSidecars.join(', ')}`)
}

const forbiddenWindowsPayloads = platform === 'win32' && arch === 'x64'
  ? entries.filter((entry) => /node_modules\/(?:onnxruntime-node\/bin\/napi-v6\/(?:darwin|linux)(?:\/|$)|onnxruntime-node\/bin\/napi-v6\/win32\/arm64(?:\/|$)|node-pty\/prebuilds\/(?:darwin-arm64|darwin-x64|win32-arm64)(?:\/|$)|node-pty\/third_party\/conpty\/[^/]+\/win10-arm64(?:\/|$)|@img\/sharp-(?:darwin|linux|linuxmusl)-|@img\/sharp-win32-arm64|@img\/sharp-libvips-(?:darwin|linux|linuxmusl)-|@img\/sharp-libvips-win32-arm64)/u.test(entry))
  : []
if (forbiddenWindowsPayloads.length > 0) {
  throw new Error(`Windows x64 package contains native slices for other targets: ${forbiddenWindowsPayloads.slice(0, 20).join(', ')}`)
}

let nativeLoadSmoke = { status: 'not-attempted', reason: 'Host platform does not match the requested package target.' }
let sharpImageSmoke = { status: 'not-attempted', reason: 'Host platform does not match the requested package target.' }
if (platform === process.platform && arch === process.arch) {
  const defaultExecutablePath = platform === 'win32'
    ? join(resourcesRoot, '..', 'LittleSheep.exe')
    : platform === 'darwin'
      ? join(resourcesRoot, '..', 'MacOS', 'LittleSheep')
      : join(resourcesRoot, '..', 'LittleSheep')
  const executablePath = resolve(option('executable', defaultExecutablePath))
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
  ]
  if (platform === 'linux') {
    smoke.push(
      "const ptySession = pty.spawn('/bin/sh', ['-i'], { name: 'xterm-256color', cols: 80, rows: 24, cwd: require('node:os').tmpdir(), env: process.env })",
      'let ptyOutput = ""',
      'let ptyCloseSeen = false',
      'ptySession.onData((chunk) => { ptyOutput += chunk })',
      "ptySession.on('close', () => { ptyCloseSeen = true })",
      'ptySession.resize(101, 37)',
      'const ptyExit = await new Promise((resolvePty, rejectPty) => {',
      'const ptyTimer = setTimeout(() => { ptySession.kill(); rejectPty(new Error("Packaged node-pty session timed out.")) }, 10000)',
      'ptySession.onExit((event) => { clearTimeout(ptyTimer); resolvePty(event) })',
      "setTimeout(() => ptySession.write('printf P4_PACKAGED_PTY_OK; stty size; exit' + String.fromCharCode(13)), 300)",
      '})',
      'if (ptyExit.exitCode !== 0 || !ptyOutput.includes("P4_PACKAGED_PTY_OK") || !ptyOutput.includes("37 101") || !ptyCloseSeen) throw new Error(`Packaged Linux PTY behavior failed: ${JSON.stringify({ ptyExit, ptyCloseSeen, ptyOutput })}`)',
      "console.log(JSON.stringify({ sharp: sharp.versions.sharp, onnxruntime: onnx.env.versions.common, nodePty: typeof pty.spawn, linuxPty: { status: 'passed', resizedTo: '101x37', closeObserved: ptyCloseSeen } }))",
    )
  } else {
    smoke.push(
      "const image = await sharp({ create: { width: 1, height: 1, channels: 4, background: { r: 1, g: 2, b: 3, alpha: 1 } } }).png().toBuffer()",
      "if (image.byteLength === 0) throw new Error('Packaged sharp returned an empty image.')",
      "console.log(JSON.stringify({ sharp: sharp.versions.sharp, sharpImageBytes: image.byteLength, onnxruntime: onnx.env.versions.common, nodePty: typeof pty.spawn }))",
    )
  }
  smoke.push(
    '}',
    'run().catch((error) => { console.error(error); process.exitCode = 1 })',
  )

  const childEnvironment = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    LS_PACKAGED_MAIN: mainEntry,
  }
  const childSmoke = spawnSync(executablePath, ['-e', smoke.join(';')], {
    cwd: resourcesRoot,
    env: childEnvironment,
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true,
  })
  if (childSmoke.error) throw childSmoke.error
  if (childSmoke.status !== 0 || childSmoke.signal) {
    throw new Error(`Packaged native module load smoke failed (${childSmoke.signal ?? `exit ${childSmoke.status ?? 'unknown'}`}): ${childSmoke.stderr || childSmoke.stdout || 'no diagnostic output'}`)
  }
  const resultLine = childSmoke.stdout.trim().split(/\r?\n/u).at(-1)
  if (!resultLine) throw new Error('Packaged Electron native module smoke test returned no result.')
  nativeLoadSmoke = { status: 'passed', executablePath, modules: JSON.parse(resultLine) }

  if (platform === 'linux') {
    // sharp warns that Electron's Linux GLib symbols can conflict with its bundled libvips.
    // Keep the operation in its own child so a native crash is reported as a structured failure
    // without hiding the independent ONNX and PTY results above.
    const sharpSmoke = [
      "const { createRequire } = require('node:module')",
      'const requireFromApp = createRequire(process.env.LS_PACKAGED_MAIN)',
      "const sharp = requireFromApp('sharp')",
      "sharp({ create: { width: 1, height: 1, channels: 4, background: { r: 1, g: 2, b: 3, alpha: 1 } } }).png().toBuffer().then((image) => {",
      "if (image.byteLength === 0) throw new Error('Packaged sharp returned an empty image.')",
      "console.log(JSON.stringify({ sharp: sharp.versions.sharp, sharpImageBytes: image.byteLength }))",
      '}).catch((error) => { console.error(error); process.exitCode = 1 })',
    ].join(';')
    const sharpChild = spawnSync(executablePath, ['-e', sharpSmoke], {
      cwd: resourcesRoot,
      env: childEnvironment,
      encoding: 'utf8',
      timeout: 30_000,
      windowsHide: true,
    })
    if (sharpChild.error) {
      sharpImageSmoke = { status: 'failed', error: sharpChild.error.message }
    } else if (sharpChild.status !== 0 || sharpChild.signal) {
      sharpImageSmoke = {
        status: 'failed',
        exitCode: sharpChild.status,
        signal: sharpChild.signal,
        diagnostic: (sharpChild.stderr || sharpChild.stdout || 'no diagnostic output').slice(0, 2_000),
      }
    } else {
      const sharpLine = sharpChild.stdout.trim().split(/\r?\n/u).at(-1)
      if (!sharpLine) throw new Error('Packaged Linux sharp smoke test returned no result.')
      sharpImageSmoke = { status: 'passed', ...JSON.parse(sharpLine) }
    }
  } else {
    sharpImageSmoke = { status: 'passed', reason: 'A one-pixel PNG encode passed in the host-native smoke.' }
  }
}

const smokeFailed = sharpImageSmoke.status === 'failed'
const limitation = platform === 'linux'
  ? 'Linux host smoke exercises native module loading and an interactive PTY session; the sharp smoke only encodes a one-pixel PNG and does not prove larger image workloads.'
  : 'The host-native smoke loads ONNX Runtime and node-pty and performs a one-pixel sharp encode; it does not prove model inference or full image workloads.'
console.log(JSON.stringify({
  check: 'packaged-runtime-manifest',
  status: smokeFailed ? 'failed' : 'passed',
  resourcesRoot,
  platform,
  arch,
  libc: platform === 'linux' ? libc : undefined,
  asarEntries: entries.length,
  nativeEntries: nativeEntries.length,
  unpackedEntries: unpackedEntries.length,
  requiredPackages,
  requiredNativePayloads: requiredNativePayloads.map(({ name, fragments }) => ({
    name,
    acceptedFragments: fragments,
    packagedEntry: findEntry(nativeEntries, fragments),
    unpackedEntry: findEntry(unpackedEntries, fragments),
  })),
  requiredRuntimeSidecars: requiredRuntimeSidecars.map(({ name, fragments }) => ({
    name,
    acceptedFragments: fragments,
    packagedEntry: findEntry(entries, fragments),
    unpackedEntry: findEntry(unpackedEntries, fragments),
  })),
  nodePtyHelper: platform === 'linux'
    ? { status: 'not-required', reason: 'The Linux node-pty backend uses forkpty directly; packaged PTY interaction is exercised by the host-native smoke.' }
    : { status: 'not-checked', reason: 'The Linux-specific forkpty packaging check does not apply to this target.' },
  sharpImageSmoke,
  optionalPdfCanvas: {
    status: hasPackage('@napi-rs/canvas') ? 'present' : 'not-packaged',
    reason: 'PDF.js treats the Node canvas adapter as optional; LS currently extracts PDF text without rendering canvases.',
  },
  nativeLoadSmoke,
  windowsTargetSlicesTrimmed: platform === 'win32' && arch === 'x64',
  limitation,
}, null, 2))
if (smokeFailed) process.exitCode = 1

async function listFiles(root, prefix = '') {
  const output = []
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) output.push(...await listFiles(root, path))
    else if (entry.isFile()) output.push(path.replaceAll('\\', '/'))
  }
  return output
}
