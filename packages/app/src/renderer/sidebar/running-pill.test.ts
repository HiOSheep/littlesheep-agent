import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { readRendererStyleSource } from '../style-source-test-utils'
import type { HistoryActivity } from '../../shared/history-activity'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { vi } from 'vitest'
import {
  FINISHED_FOLD_THRESHOLD,
  FINISHED_FOLD_VISIBLE,
  TaskCommandRow,
  foldFinishedCommands,
  formatPillDuration,
  normalizeRenameDraft,
  taskCommandDetail,
  taskCommands,
} from './running-pill'

// The test transform uses the classic JSX runtime, so the component needs React in scope.
vi.stubGlobal('React', React)

const tool = (callId: string, name: string, input: unknown, startedAt?: number, endedAt?: number, ok?: boolean) => ({
  callId, name, input, startedAt, endedAt, ok,
})

const activity = (tools: ReturnType<typeof tool>[], status: HistoryActivity['status'] = 'running'): HistoryActivity => ({
  status,
  instruction: '跑一遍验收',
  startedAt: 1_000,
  steps: [],
  tools,
})

describe('chat task pill', () => {
  it('formats elapsed time the way the pill reads it', () => {
    expect(formatPillDuration(400)).toBe('不足 1 秒')
    expect(formatPillDuration(23_000)).toBe('23 秒')
    expect(formatPillDuration(18 * 60_000)).toBe('18 分钟')
    expect(formatPillDuration(3 * 3_600_000 + 5 * 60_000)).toBe('3 小时 5 分')
    expect(formatPillDuration(null)).toBe('')
  })

  it('reads the command a tool call carries', () => {
    expect(taskCommandDetail({ command: 'pnpm run test' })).toBe('pnpm run test')
    expect(taskCommandDetail({ file_path: 'D:\\a b\\c.ts' })).toBe('D:\\a b\\c.ts')
    expect(taskCommandDetail('裸字符串')).toBe('裸字符串')
    expect(taskCommandDetail({ unrelated: 1 })).toBe('')
    expect(taskCommandDetail(null)).toBe('')
  })

  it('splits one run into what is still going and what ended', () => {
    const commands = taskCommands(activity([
      tool('a', 'exec', { command: 'pnpm run build' }, 1_000, 40_000, true),
      tool('b', 'exec', { command: 'node verify.mjs' }, 45_000, undefined),
      tool('c', 'read', { file_path: 'README.md' }, 46_000, 46_400, false),
    ]), 68_000)

    expect(commands.map((command) => [command.detail, command.running, command.failed])).toEqual([
      ['pnpm run build', false, false],
      ['node verify.mjs', true, false],
      ['README.md', false, true],
    ])
    // A running command is measured against the ticking clock, not against a fixed end.
    expect(commands[1]?.durationMs).toBe(23_000)
    expect(commands[0]?.durationMs).toBe(39_000)
  })

  it('has nothing to show without an activity', () => {
    expect(taskCommands(null, 1_000)).toEqual([])
  })
})

describe('chat task pill rows', () => {
  it('renders a command with its shell, state and duration', () => {
    const [command] = taskCommands(activity([
      tool('a', 'exec', { command: 'pnpm run build' }, 1_000, 40_000, true),
    ]), 68_000)
    const markup = renderToStaticMarkup(TaskCommandRow({ command: command! }))

    expect(markup).toContain('pnpm run build')
    expect(markup).toContain('exec · 完成')
    expect(markup).toContain('39 秒')
    expect(markup).toContain('running-pill-command done')
  })

  it('marks a command that is still running and one that failed', () => {
    const commands = taskCommands(activity([
      tool('a', 'exec', { command: 'sleep 30' }, 60_000, undefined),
      tool('b', 'exec', { command: 'bad command' }, 61_000, 62_000, false),
    ]), 68_000)

    expect(renderToStaticMarkup(TaskCommandRow({ command: commands[0]! }))).toContain('exec · 运行中')
    const failed = renderToStaticMarkup(TaskCommandRow({ command: commands[1]! }))
    expect(failed).toContain('exec · 失败')
    expect(failed).toContain('running-pill-command failed')
  })

  it('offers the stop control only on a running command that can stop', () => {
    const commands = taskCommands(activity([
      tool('a', 'exec', { command: 'sleep 30' }, 60_000, undefined),
      tool('b', 'exec', { command: 'pnpm run build' }, 1_000, 40_000, true),
    ]), 68_000)

    const running = renderToStaticMarkup(TaskCommandRow({ command: commands[0]!, onStop: () => {} }))
    expect(running).toContain('running-pill-command-stop')
    expect(running).toContain('终止运行')
    // A finished command has nothing left to stop, and a row without a stop callback renders none.
    expect(renderToStaticMarkup(TaskCommandRow({ command: commands[1]!, onStop: () => {} }))).not.toContain('running-pill-command-stop')
    expect(renderToStaticMarkup(TaskCommandRow({ command: commands[0]! }))).not.toContain('running-pill-command-stop')
  })
})

describe('chat task pill history fold', () => {
  const finishedRun = (count: number) => taskCommands(activity(
    Array.from({ length: count }, (_, index) =>
      tool(`call-${index}`, 'exec', { command: `step ${index}` }, 1_000 + index * 1_000, 1_500 + index * 1_000, true)),
    'done',
  ), 60_000).filter((command) => !command.running).reverse()

  it('shows a short finished list whole', () => {
    const fold = foldFinishedCommands(finishedRun(FINISHED_FOLD_THRESHOLD))
    expect(fold.foldedCount).toBe(0)
    expect(fold.visible).toHaveLength(FINISHED_FOLD_THRESHOLD)
  })

  it('folds the older commands once the list grows long, keeping the newest visible', () => {
    const finished = finishedRun(FINISHED_FOLD_THRESHOLD + 5)
    const fold = foldFinishedCommands(finished)
    expect(fold.visible).toHaveLength(FINISHED_FOLD_VISIBLE)
    expect(fold.foldedCount).toBe(finished.length - FINISHED_FOLD_VISIBLE)
    // The list is newest-first, so the visible window is the newest few and the fold hides age.
    expect(fold.visible[0]?.id).toBe(finished[0]?.id)
    expect(fold.visible.at(-1)?.id).toBe(finished[FINISHED_FOLD_VISIBLE - 1]?.id)
  })
})

describe('chat task pill rename', () => {
  it('commits only a trimmed, genuinely different name', () => {
    expect(normalizeRenameDraft('  新名字  ', '旧名字')).toBe('新名字')
    expect(normalizeRenameDraft('旧名字', '旧名字')).toBeNull()
    expect(normalizeRenameDraft('   ', '旧名字')).toBeNull()
    expect(normalizeRenameDraft('', '旧名字')).toBeNull()
  })
})/**
 * The bar's surface (2026-10-02, after the reference bar): it is the conversation's heading at the
 * chat column's left edge, it leads with a larger name, it says the name is editable, and the
 * background-task segment is the only thing that widens it. Asserted at the source level, the way
 * the other renderer wiring contracts are, because a node test cannot lay the bar out.
 */
describe('chat task bar surface', () => {
  const source = (path: string) => readFile(new URL(path, import.meta.url), 'utf8')

  it('sits at the column\'s left edge instead of floating in the middle', async () => {
    const styles = await readRendererStyleSource()
    expect(styles).toMatch(/\.running-pill-shell\s*\{[\s\S]*?justify-content:\s*flex-start;[\s\S]*?padding:\s*var\(--task-pill-inset-top\) var\(--chat-content-gutter\) 0 2px;/u)
  })

  it('leads with a larger name and a pencil that opens the rename field', async () => {
    const styles = await readRendererStyleSource()
    const pill = await source('./running-pill.tsx')

    expect(styles).toMatch(/\.running-pill-title\s*\{[\s\S]*?color:\s*var\(--text-strong\);[\s\S]*?font-size:\s*14px;[\s\S]*?font-weight:\s*600;/u)
    expect(styles).toMatch(/\.running-pill-rename\s*\{[\s\S]*?width:\s*18px;[\s\S]*?flex:\s*0 0 18px;/u)
    expect(pill).toContain('<RenameIcon />')
    // The pointer path and the keyboard path both land in the same field.
    expect(pill).toMatch(/className="running-pill-rename"[\s\S]*?setEditing\(true\)/u)
    expect(pill).toContain("if (event.key !== 'F2') return")
    expect(pill).toContain('aria-keyshortcuts="F2"')
  })

  it('widens only for the background-task segment, and that segment carries the chevron', async () => {
    const styles = await readRendererStyleSource()
    const pill = await source('./running-pill.tsx')

    expect(pill).toContain('const taskLabel = `${commands.length} 项执行记录`')
    expect(pill).toContain('{commands.length > 0 && (')
    expect(pill).toContain('<span className="running-pill-chevron" aria-hidden="true" />')
    expect(styles).toMatch(/\.running-pill-tasks\s*\{[\s\S]*?flex:\s*0 0 auto;/u)
    // The state sentence is not a segment any more; it lives in the hover tip.
    expect(pill).not.toContain('running-pill-summary')
  })

  it('keeps only the panel sections that have something in them', async () => {
    const pill = await source('./running-pill.tsx')

    expect(pill).toContain('{commands.length === 0 && <div className="running-pill-empty">这次运行还没有指令记录</div>}')
    expect(pill).toContain('{running.length > 0 && (')
    expect(pill).toContain('{finished.length > 0 && (')
    // The two rows that reported nothing are gone: an empty running count and a line saying so.
    expect(pill).not.toContain('当前没有正在运行的指令')
    expect(pill).not.toContain('这次运行还没有已结束的指令')
  })

  it('opens the panel from the bar\'s own left edge', async () => {
    const pill = await source('./running-pill.tsx')

    expect(pill).toContain('const x = clampNumber(rect.left, 2, Math.max(2, window.innerWidth - panelWidth - edge))')
  })
})