import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('Windows release packaging', () => {
  it('defines an asar-based x64 Windows package with the external runtime modules unpacked', async () => {
    const config = await readFile(new URL('../../electron-builder.yml', import.meta.url), 'utf8')

    expect(config).toContain('appId: com.littlesheep.desktop')
    expect(config).toContain('productName: LittleSheep')
    expect(config).toContain('asar: true')
    expect(config).toContain('node_modules/node-pty/**')
    expect(config).toContain('node_modules/onnxruntime-node/**')
    expect(config).toContain('node_modules/@huggingface/transformers/**')
    expect(config).toContain('target: nsis')
    expect(config).toContain('- x64')
    expect(config).toContain('littlesheep.ico')
    expect(config).toContain('from: .release-staging/out')
  })

  it('keeps the release command and artifact verifier aligned with packaged asar contents', async () => {
    const [rootPackage, packagingScript, scanner, releaseArtifacts] = await Promise.all([
      readFile(new URL('../../../../package.json', import.meta.url), 'utf8'),
      readFile(new URL('../../../../scripts/package-windows-release.mjs', import.meta.url), 'utf8'),
      readFile(new URL('../../../../scripts/verify-web-release-artifacts.mjs', import.meta.url), 'utf8'),
      readFile(new URL('../../../../scripts/lib/release-artifacts.mjs', import.meta.url), 'utf8'),
    ])
    const packageJson = JSON.parse(rootPackage) as { scripts?: Record<string, string>; devDependencies?: Record<string, string> }

    expect(packageJson.scripts?.['package:win']).toContain('package-windows-release.mjs --dir')
    expect(packageJson.scripts?.['package:win-installer']).toContain('package-windows-release.mjs --installer')
    expect(packageJson.devDependencies?.['electron-builder']).toBe('26.15.3')
    expect(packageJson.devDependencies?.['@electron/asar']).toBe('3.4.1')
    expect(packagingScript).toContain('ensure:app-build')
    expect(packagingScript).toContain("mkdtemp(releaseScratchRootPrefix())")
    // Where that scratch root is: the staged payload and the generated config stay
    // outside the checkout, so an interrupted run leaves no ~1 GiB of bytes that
    // `git status` could see.
    expect(releaseArtifacts).toContain("join(tmpdir(), 'littlesheep-release-packaging-')")
    expect(packagingScript).toContain('releaseLockRoot')
    // The refusal names the lock path as well: one packaging run at a time, and a
    // stale lock is removable by hand.
    expect(packagingScript).toContain('`Another Windows release packaging process is already running (remove ${releaseLockRoot} if it is stale).`')
    expect(packagingScript.indexOf('await mkdir(releaseLockRoot)')).toBeLessThan(
      packagingScript.indexOf("pnpm.cmd run ensure:app-build"),
    )
    expect(packagingScript).toContain('releaseStagingOut')
    expect(packagingScript).toContain('temporaryConfigPath')
    expect(packagingScript).toContain('stagingReference')
    expect(packagingScript).toContain('releaseStagingElectron')
    expect(packagingScript).toContain("createRequire(resolve(appRoot, 'package.json'))")
    expect(packagingScript).toContain('electronDist: ${electronReference}')
    expect(packagingScript).toContain("appRequire('electron')")
    expect(packagingScript).toContain("'--config', temporaryConfigPath")
    expect(packagingScript).toContain('errorOnExist: true')
    expect(packagingScript).toContain("'--win'")
    expect(scanner).toContain("from '@electron/asar'")
    expect(scanner).toContain('extractAll(archive')
    expect(scanner).toContain('collectExtractedFiles')
  })
})
