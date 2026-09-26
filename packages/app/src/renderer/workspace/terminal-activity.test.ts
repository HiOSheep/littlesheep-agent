// UX-30 item 5: the recent-command list must say which Shell a command ran in, and must not
// invent one for records written before that fact existed.
import { expect, it } from 'vitest'
import type { TerminalActivityRecord } from '../../shared/workspace-contracts'
import { terminalActivityMeta, terminalActivityTip } from './terminal-activity'

const base: TerminalActivityRecord = {
  id: 'r1',
  command: 'pnpm test',
  cwd: 'D:\\workplace',
  workspacePath: 'D:\\workplace',
  startedAt: '2026-09-26T08:00:00.000Z',
  endedAt: '2026-09-26T08:00:12.000Z',
  durationMs: 12_000,
  exitCode: 0,
  signal: null,
  timedOut: false,
  truncated: false,
  stdoutPreview: '',
  stderrPreview: '',
}

it('labels the Shell a command ran in and omits it when unknown', () => {
  expect(terminalActivityMeta({ ...base, shell: 'Git Bash' })).toBe('Git Bash · 成功 · 12.0s')
  expect(terminalActivityMeta(base)).toBe('成功 · 12.0s')
  expect(terminalActivityTip({ ...base, shell: 'Git Bash' })).toContain('shell: Git Bash')
  expect(terminalActivityTip(base)).not.toContain('shell:')
})
