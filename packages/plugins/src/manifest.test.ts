import { describe, expect, it } from 'vitest'
import { parsePluginManifest, pluginManifestsMatch } from './manifest.js'

const validToolManifest = {
  id: 'test.tool.echo',
  name: 'Echo',
  version: '1.0.0',
  apiVersion: 1,
  description: 'test',
  capabilities: ['tool'],
  permissions: ['tools:register'],
  activationEvents: ['onStartup'],
  contributes: { channels: [], tools: ['test_echo'], skills: [] },
}

describe('plugin manifest', () => {
  it('accepts a reachable and fully declared tool contribution', () => {
    expect(parsePluginManifest(validToolManifest)).toMatchObject(validToolManifest)
  })

  it('rejects capabilities that API v1 does not expose through the host', () => {
    expect(() => parsePluginManifest({
      ...validToolManifest,
      capabilities: ['provider'],
    })).toThrow()
  })

  it('rejects contributions without their registration permission', () => {
    expect(() => parsePluginManifest({
      ...validToolManifest,
      permissions: [],
    })).toThrow(/tools:register/)
  })

  it('accepts owner-controlled skill contributions that activate on startup', () => {
    expect(parsePluginManifest({
      ...validToolManifest,
      id: 'test.skill.planner',
      capabilities: ['skill'],
      permissions: ['skills:register'],
      contributes: { channels: [], tools: [], skills: ['planner'] },
    })).toMatchObject({
      capabilities: ['skill'],
      contributes: { skills: ['planner'] },
    })
  })

  it('rejects skill contributions without ownership permission or startup activation', () => {
    expect(() => parsePluginManifest({
      ...validToolManifest,
      id: 'test.skill.no-permission',
      capabilities: ['skill'],
      permissions: [],
      contributes: { channels: [], tools: [], skills: ['planner'] },
    })).toThrow(/skills:register/)
    expect(() => parsePluginManifest({
      ...validToolManifest,
      id: 'test.skill.lazy',
      capabilities: ['skill'],
      permissions: ['skills:register'],
      activationEvents: ['onChannel:planner'],
      contributes: { channels: [], tools: [], skills: ['planner'] },
    })).toThrow(/activate onStartup/)
  })

  it('rejects unreachable channel activation declarations', () => {
    expect(() => parsePluginManifest({
      ...validToolManifest,
      id: 'test.channel.webhook',
      capabilities: ['channel'],
      permissions: ['channels:register'],
      activationEvents: ['onChannel:telegram'],
      contributes: { channels: ['webhook'], tools: [], skills: [] },
    })).toThrow(/no reachable activation event/)
  })

  it('ignores installation-only main while comparing all runtime declarations', () => {
    const installed = parsePluginManifest({ ...validToolManifest, main: './index.mjs' })
    const runtime = parsePluginManifest(validToolManifest)
    const changedPermission = parsePluginManifest({
      ...validToolManifest,
      permissions: ['tools:register', 'network'],
    })

    expect(pluginManifestsMatch(installed, runtime)).toBe(true)
    expect(pluginManifestsMatch(installed, changedPermission)).toBe(false)
  })
})
