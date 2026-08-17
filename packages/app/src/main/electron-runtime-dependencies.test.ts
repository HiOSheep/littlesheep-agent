import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('Electron main-process runtime dependencies', () => {
  it('keeps Transformers.js external and available as an app runtime dependency', async () => {
    const [configSource, packageSource, rootPackageSource, workspaceSource] = await Promise.all([
      readFile(new URL('../../electron.vite.config.ts', import.meta.url), 'utf8'),
      readFile(new URL('../../package.json', import.meta.url), 'utf8'),
      readFile(new URL('../../../../package.json', import.meta.url), 'utf8'),
      readFile(new URL('../../../../pnpm-workspace.yaml', import.meta.url), 'utf8'),
    ])
    const packageJson = JSON.parse(packageSource) as {
      dependencies?: Record<string, string>
    }
    const rootPackageJson = JSON.parse(rootPackageSource) as {
      engines?: Record<string, string>
    }

    expect(configSource).toContain("'@huggingface/transformers'")
    expect(configSource).toContain("'onnxruntime-node'")
    expect(packageJson.dependencies?.['@huggingface/transformers']).toBe('4.2.0')
    expect(rootPackageJson.engines?.node).toBe('>=20.9.0')
    expect(workspaceSource).toMatch(/^\s+adm-zip: 0\.6\.0$/mu)
    expect(workspaceSource).toMatch(/^\s+sharp: 0\.35\.0$/mu)
  })

  it('pins Monaco DOMPurify to the reviewed security floor', async () => {
    const [packageSource, workspaceSource] = await Promise.all([
      readFile(new URL('../../package.json', import.meta.url), 'utf8'),
      readFile(new URL('../../../../pnpm-workspace.yaml', import.meta.url), 'utf8'),
    ])
    const packageJson = JSON.parse(packageSource) as {
      dependencies?: Record<string, string>
    }

    expect(packageJson.dependencies?.['monaco-editor']).toBe('^0.55.1')
    expect(workspaceSource).toMatch(/^\s+dompurify: 3\.4\.13$/mu)
  })
})
