import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const rendererRoot = fileURLToPath(new URL('.', import.meta.url))

// The retired wording for a model provider; built from parts so this test file
// does not match its own scan.
const RETIRED_PROVIDER_TERM = `${'提供'}${'方'}`

async function collectSources(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const path = `${directory}${entry.name}${entry.isDirectory() ? '/' : ''}`
    if (entry.isDirectory()) {
      files.push(...await collectSources(path))
      continue
    }
    if (!/\.tsx?$/u.test(entry.name) || /\.test\.tsx?$/u.test(entry.name)) continue
    files.push(path)
  }
  return files
}

async function readSibling(name: string): Promise<string> {
  return readFile(new URL(`./${name}`, import.meta.url), 'utf8')
}

describe('renderer terminology', () => {
  it('uses one word for a model provider across every source file', async () => {
    const sources = await collectSources(rendererRoot)
    const offenders: string[] = []
    for (const path of sources) {
      const source = await readFile(path, 'utf8')
      if (source.includes(RETIRED_PROVIDER_TERM)) offenders.push(path.replace(rendererRoot, ''))
    }

    expect(offenders).toEqual([])
  })

  it('shows the conversation display modes with their Chinese names', async () => {
    // Display density lives on the appearance page (UX-12), not under Agent behaviour.
    const appearance = await readSibling('settings/appearance.tsx')

    expect(appearance).toContain("mode === 'normal' ? '普通' : '紧凑'")
    expect(appearance).not.toContain("'Normal' : 'Compact'")
    // The stored ids stay the runtime contract values.
    expect(appearance).toContain("(['normal', 'compact'] as const)")
  })
})

describe('product copy claims', () => {
  it('does not describe future capability as if it were a plan item', async () => {
    const [home, skills, panel] = await Promise.all([
      readSibling('settings/home.tsx'),
      readSibling('MemorySkills.tsx'),
      readSibling('workspace/panel.tsx'),
    ])

    expect(home).not.toContain('后续功能模块')
    expect(skills).not.toContain('后续可继续接')
    expect(panel).not.toContain('后续承载')
    expect(panel).not.toContain('后续会承载')
    // An unconnected surface says so instead of promising later work.
    expect(panel).toContain('侧边聊天尚未接入')
    expect(skills).toContain('当前版本只能查看内容')
  })

  it('keeps advanced channel configuration out of the primary instruction', async () => {
    const channels = await readSibling('ChannelConnections.tsx')

    expect(channels).toContain('还没有配置外部渠道')
    expect(channels).toContain('这个版本还没有渠道配置界面')
    // The exact key stays available, but behind a disclosure with its location.
    expect(channels).toContain('<details className="feedback-detail">')
    expect(channels).toContain('<code>channels.channels</code>')
    expect(channels).not.toContain('暂未配置外部渠道。可在 config.json 的 channels.channels 中添加。')
  })
})
