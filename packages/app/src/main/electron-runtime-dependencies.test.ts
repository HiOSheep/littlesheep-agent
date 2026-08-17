import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('Electron main-process runtime dependencies', () => {
  it('keeps Transformers.js external and available as an app runtime dependency', async () => {
    const [configSource, packageSource, workspaceSource] = await Promise.all([
      readFile(new URL('../../electron.vite.config.ts', import.meta.url), 'utf8'),
      readFile(new URL('../../package.json', import.meta.url), 'utf8'),
      readFile(new URL('../../../../pnpm-workspace.yaml', import.meta.url), 'utf8'),
    ])
    const packageJson = JSON.parse(packageSource) as {
      dependencies?: Record<string, string>
    }

    expect(configSource).toContain("'@huggingface/transformers'")
    expect(configSource).toContain("'onnxruntime-node'")
    expect(packageJson.dependencies?.['@huggingface/transformers']).toBe('4.2.0')
    expect(workspaceSource).toMatch(/overrides:\s*\n\s+adm-zip: 0\.6\.0\s*\n\s+sharp: 0\.35\.0/u)
  })
})
