import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, parse, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { app } from 'electron'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const appRequire = createRequire(join(repoRoot, 'packages', 'app', 'package.json'))

async function main() {
  await app.whenReady()

  const transformersEntry = appRequire.resolve('@huggingface/transformers')
  const transformersRequire = createRequire(transformersEntry)
  const transformers = await import(pathToFileURL(transformersEntry).href)
  assert.equal(typeof transformers.pipeline, 'function')

  const sharpEntry = transformersRequire.resolve('sharp')
  const sharp = transformersRequire('sharp')
  const image = await sharp({
    create: {
      width: 2,
      height: 2,
      channels: 4,
      background: { r: 16, g: 32, b: 48, alpha: 1 },
    },
  }).png().toBuffer({ resolveWithObject: true })
  assert.equal(image.info.width, 2)
  assert.equal(image.info.height, 2)
  assert.ok(image.data.byteLength > 0)

  const onnxEntry = transformersRequire.resolve('onnxruntime-node')
  const onnxRequire = createRequire(onnxEntry)
  const onnx = onnxRequire('onnxruntime-node')
  assert.equal(typeof onnx.InferenceSession?.create, 'function')

  const admZipEntry = onnxRequire.resolve('adm-zip')
  const AdmZip = onnxRequire('adm-zip')
  const archive = new AdmZip()
  archive.addFile('probe.txt', Buffer.from('LittleSheep dependency probe', 'utf8'))
  const reopened = new AdmZip(archive.toBuffer())
  assert.equal(reopened.readAsText('probe.txt'), 'LittleSheep dependency probe')

  const versions = {
    transformers: await packageVersion(transformersEntry, '@huggingface/transformers'),
    sharp: await packageVersion(sharpEntry, 'sharp'),
    onnxruntimeNode: await packageVersion(onnxEntry, 'onnxruntime-node'),
    admZip: await packageVersion(admZipEntry, 'adm-zip'),
  }
  assert.equal(versions.transformers, '4.2.0')
  assert.equal(versions.sharp, '0.35.0')
  assert.equal(versions.admZip, '0.6.0')

  console.log(JSON.stringify({
    check: 'electron-transformers-runtime',
    ok: true,
    versions,
    runtime: { node: process.versions.node, electron: process.versions.electron },
    imageBytes: image.data.byteLength,
  }))
  app.exit(0)
}

async function packageVersion(entryPath, expectedName) {
  const root = parse(entryPath).root
  let current = dirname(entryPath)
  while (current !== root) {
    try {
      const manifest = JSON.parse(await readFile(join(current, 'package.json'), 'utf8'))
      if (manifest.name === expectedName && typeof manifest.version === 'string') return manifest.version
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    current = dirname(current)
  }
  throw new Error(`Unable to locate ${expectedName} package.json from ${entryPath}`)
}

main().catch((error) => {
  console.error(JSON.stringify({
    check: 'electron-transformers-runtime',
    ok: false,
    error: error instanceof Error ? error.stack ?? error.message : String(error),
  }))
  app.exit(1)
})
