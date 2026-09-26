import { describe, expect, it } from 'vitest'
import type { HistoryActivity } from '../../shared/history-activity'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { vi } from 'vitest'
import { TaskCommandRow, formatPillDuration, taskCommandDetail, taskCommands } from './running-pill'

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

describe('titlebar task pill', () => {
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

describe('titlebar task pill rows', () => {
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
})