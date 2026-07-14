import { describe, expect, it } from 'vitest'
import { pluginManifestsMatch } from '@littlesheep/plugins'
import { BUILTIN_PLUGIN_SOURCES } from './builtin-plugins.js'

describe('built-in plugin catalog', () => {
  it('uses unique plugin ids and channel contributions', () => {
    const ids = BUILTIN_PLUGIN_SOURCES.map((source) => source.manifest.id)
    const channelTypes = BUILTIN_PLUGIN_SOURCES.flatMap((source) => source.manifest.contributes.channels)

    expect(new Set(ids).size).toBe(ids.length)
    expect(new Set(channelTypes).size).toBe(channelTypes.length)
    expect(channelTypes.sort()).toEqual(['feishu', 'qqbot', 'telegram', 'webhook'])
  })

  it('keeps catalog manifests identical to the dynamically loaded modules', async () => {
    for (const source of BUILTIN_PLUGIN_SOURCES) {
      const plugin = await source.load()
      expect(pluginManifestsMatch(source.manifest, plugin.manifest), source.manifest.id).toBe(true)
    }
  })
})
