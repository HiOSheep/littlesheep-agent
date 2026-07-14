import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { discoverLocalPluginSources } from './local-loader.js'

const baseManifest = {
  id: 'test.local.echo',
  name: 'Local echo',
  version: '1.0.0',
  apiVersion: 1,
  description: 'test',
  capabilities: ['tool'],
  permissions: ['tools:register'],
  activationEvents: ['onStartup'],
  contributes: { channels: [], tools: ['local_echo'], skills: [] },
  main: './index.mjs',
}

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ls-plugin-discovery-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function writePlugin(name: string, manifest: unknown, entry = 'throw new Error("must not execute during discovery")') {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'littlesheep.plugin.json'), JSON.stringify(manifest), 'utf8')
  writeFileSync(join(dir, 'index.mjs'), entry, 'utf8')
  return dir
}

describe('local plugin discovery', () => {
  it('discovers a valid manifest without executing its entry module', async () => {
    const dir = writePlugin('echo', baseManifest)

    const result = await discoverLocalPluginSources([root])

    expect(result.diagnostics).toEqual([])
    expect(result.sources).toHaveLength(1)
    expect(result.sources[0]).toMatchObject({
      kind: 'local',
      location: dir,
      manifest: { id: baseManifest.id, main: './index.mjs' },
    })
  })

  it('reports malformed manifests and continues discovering other plugins', async () => {
    writePlugin('invalid', { ...baseManifest, id: 'INVALID ID' })
    writePlugin('valid', { ...baseManifest, id: 'test.local.valid' })

    const result = await discoverLocalPluginSources([root])

    expect(result.sources.map((source) => source.manifest.id)).toEqual(['test.local.valid'])
    expect(result.diagnostics).toHaveLength(1)
    expect(result.diagnostics[0]?.source).toContain('invalid')
  })

  it('rejects absolute and escaping entry paths', async () => {
    writePlugin('absolute', { ...baseManifest, id: 'test.local.absolute', main: join(root, 'outside.mjs') })
    writePlugin('escape', { ...baseManifest, id: 'test.local.escape', main: '../outside.mjs' })

    const result = await discoverLocalPluginSources([root])

    expect(result.sources).toEqual([])
    expect(result.diagnostics.map((item) => item.message)).toEqual(expect.arrayContaining([
      expect.stringContaining('must be relative'),
      expect.stringContaining('escapes the plugin directory'),
    ]))
  })
})
