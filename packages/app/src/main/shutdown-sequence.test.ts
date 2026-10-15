import { describe, expect, it, vi } from 'vitest'
import { runShutdownSequence } from './shutdown-sequence.js'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import ts from 'typescript'

describe('runShutdownSequence', () => {
  it('completes its deadline in a real process after all other event-loop handles close', () => {
    const source = readFileSync(new URL('./shutdown-sequence.ts', import.meta.url), 'utf8')
    const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `${code}\nawait runShutdownSequence([{ name: 'pending cleanup', run: () => new Promise(() => {}) }], { stepTimeoutMs: 40 }); process.stdout.write('shutdown-completed');`], { encoding: 'utf8', timeout: 5_000 })
    expect(child.error).toBeUndefined()
    expect(child.status).toBe(0)
    expect(child.stdout).toBe('shutdown-completed')
  })
  it('runs cleanup steps in dependency order', async () => {
    const calls: string[] = []

    await runShutdownSequence([
      { name: 'server', run: () => { calls.push('server') } },
      { name: 'channels', run: () => { calls.push('channels') } },
      { name: 'runner', run: () => { calls.push('runner') } },
    ])

    expect(calls).toEqual(['server', 'channels', 'runner'])
  })

  it('continues after a cleanup step times out', async () => {
    const calls: string[] = []
    const warnings: string[] = []

    await runShutdownSequence([
      { name: 'stuck', run: () => new Promise<void>(() => undefined) },
      { name: 'next', run: () => { calls.push('next') } },
    ], {
      stepTimeoutMs: 10,
      onWarning: (message) => warnings.push(message),
    })

    expect(calls).toEqual(['next'])
    expect(warnings).toEqual([expect.stringContaining('stuck cleanup exceeded 10ms')])
  })

  it('reports failures and continues', async () => {
    const next = vi.fn()
    const warnings: string[] = []

    await runShutdownSequence([
      { name: 'broken', run: () => { throw new Error('boom') } },
      { name: 'next', run: next },
    ], { onWarning: (message) => warnings.push(message) })

    expect(next).toHaveBeenCalledOnce()
    expect(warnings).toEqual(['broken cleanup failed: boom'])
  })
})
