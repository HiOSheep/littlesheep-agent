import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import type { RuntimeProvider } from '../shared/runtime-api-contracts'
import {
  archivedProjectDeletionImpact,
  archivedSessionDeletionImpact,
  providerDeletionImpact,
  selectedModelForProvider,
} from './deletion-impact'

function provider(overrides: Partial<RuntimeProvider> = {}): RuntimeProvider {
  return {
    id: 'custom-gw',
    name: '自建网关',
    baseURL: 'https://gateway.example/v1',
    api: 'openai-chat-completions',
    models: [
      { id: 'gw-large', name: 'gw-large', declared: false, reasoningOptions: [] },
      { id: 'gw-small', name: 'gw-small', declared: false, reasoningOptions: [] },
    ],
    headerNames: [],
    envVar: 'LS_PROVIDER_CUSTOM_GW_KEY',
    requiresKey: true,
    hasKey: true,
    builtin: false,
    ...overrides,
  }
}

describe('archive deletion impact', () => {
  it('names the project and the archived conversations removed with it', () => {
    const impact = archivedProjectDeletionImpact({ name: '', path: 'C:\\work\\littlesheep' }, 3)

    expect(impact.objectType).toBe('归档项目记录')
    expect(impact.name).toBe('littlesheep')
    expect(impact.removes.join('\n')).toContain('3 个归档对话')
    expect(impact.removes.join('\n')).toContain('无法恢复')
  })

  it('states that the project folder on disk stays in place', () => {
    const impact = archivedProjectDeletionImpact({ name: 'LS', path: 'C:\\work\\LS' }, 1)

    expect(impact.preserved.join('\n')).toContain('不会删除磁盘上的项目文件夹')
  })

  it('does not claim removed conversations when the project has none', () => {
    const impact = archivedProjectDeletionImpact({ name: 'LS', path: 'C:\\work\\LS' }, 0)

    expect(impact.removes.join('\n')).toContain('当前没有随它一起归档的对话')
    expect(impact.removes.join('\n')).not.toContain('个归档对话')
  })

  it('describes an archived conversation deletion as permanent and scoped to local records', () => {
    const impact = archivedSessionDeletionImpact({ title: '整理缓存验收' })

    expect(impact.name).toBe('整理缓存验收')
    expect(impact.removes.join('\n')).toContain('消息记录和会话摘要')
    expect(impact.removes.join('\n')).toContain('无法恢复')
    expect(impact.preserved.join('\n')).toContain('工作区里的文件')
  })
})

describe('provider deletion impact', () => {
  it('warns when the current model comes from the provider being deleted', () => {
    const impact = providerDeletionImpact(provider(), 'custom-gw/gw-large')

    expect(impact.name).toBe('自建网关')
    expect(impact.removes.join('\n')).toContain('2 个模型条目')
    expect(impact.inUse).toContain('gw-large')
  })

  it('keeps the key and conversation claims out of the deletion scope', () => {
    const impact = providerDeletionImpact(provider(), '')

    expect(impact.inUse).toBeNull()
    expect(impact.preserved.join('\n')).toContain('系统密钥库')
    expect(impact.preserved.join('\n')).toContain('不会删除任何对话记录')
  })

  it('resolves the selected model only for the owning provider', () => {
    const target = provider()
    expect(selectedModelForProvider(target, 'custom-gw/gw-small')).toBe('gw-small')
    expect(selectedModelForProvider(target, 'gw-small')).toBe('gw-small')
    expect(selectedModelForProvider(target, 'other-provider/gw-small')).toBeNull()
    expect(selectedModelForProvider(target, 'custom-gw/unknown')).toBeNull()
    expect(selectedModelForProvider(target, '')).toBeNull()
  })
})

describe('permanent deletion wiring', () => {
  it('opens a confirmation before the archive DELETE and keeps failures in it', async () => {
    const source = await readFile(new URL('./ArchiveManager.tsx', import.meta.url), 'utf8')

    expect(source).toContain('requestProjectDeletion(project, sessions.length)')
    expect(source).toContain('requestSessionDeletion(session)')
    expect(source).toContain('<DangerConfirmDialog')
    expect(source).toContain('if (!pending || deletingRef.current) return')
    expect(source).toContain('setDeleteError((err as Error).message)')
    // The in-flight guard has to be synchronous: two clicks in the same task both read the
    // `deleting` state as false, which is how a double click once submitted two DELETEs
    // (measured in the real window by `verify:deletion-confirmation`).
    expect(source).not.toContain('if (!pending || deleting) return')
    expect(source).toContain('const deletingRef = useRef(false)')
    // The delete API is only reached from the confirmed transaction.
    expect(source.match(/deleteArchivedProject\(/gu)).toHaveLength(1)
    expect(source.match(/deleteArchivedSession\(/gu)).toHaveLength(1)
    expect(source).toContain('function cancelDeletion()')
  })

  it('keeps the restore path free of a confirmation step', async () => {
    const source = await readFile(new URL('./ArchiveManager.tsx', import.meta.url), 'utf8')

    expect(source).toContain('restoreArchivedProject(project.id)')
    expect(source).not.toContain('requestProjectRestore')
  })

  it('confirms provider deletion with the configuration impact', async () => {
    const source = await readFile(new URL('./settings/models.tsx', import.meta.url), 'utf8')

    expect(source).toContain('providerDeletionImpact(provider, runtime?.model ?? \'\')')
    expect(source).toContain('if (!pending || deleting) return')
    expect(source).toContain('<DangerConfirmDialog')
    expect(source.match(/await deleteProvider\(/gu)).toHaveLength(1)
    // Opening the confirmation itself must not delete anything.
    expect(source).not.toContain('await deleteProvider(provider.id)')
  })

  it('keeps the shared confirmation layer keyboard-safe and single-flight', async () => {
    const dialog = await readFile(new URL('./ui/danger-confirm.tsx', import.meta.url), 'utf8')

    expect(dialog).toContain('role="alertdialog"')
    expect(dialog).toContain('aria-modal="true"')
    // Focus, Tab containment, Escape arbitration and focus restore come from the
    // shared modal layer; the cancel action is the deliberate entry point.
    expect(dialog).toContain('useModalSurface(dialogRef')
    expect(dialog).toContain('initialFocusRef: cancelRef')
    expect(dialog).toContain('if (!busy) onCancel()')
    expect(dialog).toContain('disabled={busy}')
    expect(dialog).toContain("busy ? '删除中…' : '永久删除'")
  })
})
