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
    // 4.3.0 is the version whose graph supplies the fixed adm-zip (via
    // onnxruntime-node 1.30.0) and sharp, so neither needs an override.
    expect(packageJson.dependencies?.['@huggingface/transformers']).toBe('4.3.0')
    expect(packageJson.dependencies?.dompurify).toBe('3.4.13')
    expect(rootPackageJson.engines?.node).toBe('>=20.9.0')
    // Remaining security floors, not preferences: mammoth's declared
    // @xmldom/xmldom range kept resolving a vulnerable build from a stale
    // lockfile. Raising it is a dependency round with its own runtime
    // verification, and the same is true of any new override added here.
    // adm-zip and sharp must stay UNpinned: Transformers 4.3.0 declares ranges
    // that resolve to the fixed versions on their own (verified by the 2026-09-22
    // offline local-embedding run), so re-adding a pin would hide upstream drift.
    const overrides = workspaceSource.split(/^overrides:\s*$/mu)[1] ?? ''
    expect(overrides).toMatch(/^\s+'@xmldom\/xmldom': 0\.8\.15$/mu)
    expect(overrides).not.toMatch(/^\s+adm-zip:/mu)
    expect(overrides).not.toMatch(/^\s+sharp:/mu)
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
