import { describe, expect, it } from 'vitest'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { vi } from 'vitest'
import { readRendererStyleSource } from './style-source-test-utils'
import { ARTIFACT_CARD_VISIBLE_ROWS, MessageArtifactsCard } from './composer/message-artifacts-card'
import { artifactDeltas, lineDeltaFor } from './composer/use-artifact-deltas'
import type { WorkspaceReviewSnapshot } from '../shared/workspace-review-contracts'
import type { WorkspaceArtifactRef } from './workspace/types'

// The test transform uses the classic JSX runtime, so the component needs React in scope.
vi.stubGlobal('React', React)

const styles = await readRendererStyleSource()

const file = (name: string, action: WorkspaceArtifactRef['action'] = 'created'): WorkspaceArtifactRef => ({
  path: `C:\\ws\\game\\${name}`,
  name,
  action,
})

function snapshot(files: Array<{ path: string; additions: number; deletions: number; countAvailable?: boolean; binary?: boolean }>): WorkspaceReviewSnapshot {
  return {
    workspacePath: 'C:\\ws',
    repositoryRoot: 'C:\\ws',
    revision: 'HEAD',
    notice: '',
    files: files.map((entry) => ({
      path: entry.path,
      absolutePath: `C:\\ws\\${entry.path}`,
      status: 'modified' as const,
      additions: entry.additions,
      deletions: entry.deletions,
      countAvailable: entry.countAvailable ?? true,
      staged: false,
      unstaged: true,
      binary: entry.binary ?? false,
    })),
  } as unknown as WorkspaceReviewSnapshot
}

// As an element, not a call: the card keeps expansion state, so it has to be rendered by React.
function card(files: WorkspaceArtifactRef[], deltas = new Map()) {
  return renderToStaticMarkup(React.createElement(MessageArtifactsCard, {
    files,
    deltas,
    onOpenFile: () => undefined,
    onOpenReview: () => undefined,
  }))
}

describe('artifact line deltas', () => {
  it('keys the snapshot by path regardless of separators and case', () => {
    const deltas = artifactDeltas(snapshot([{ path: 'game/pong.html', additions: 12, deletions: 3 }]))
    expect(lineDeltaFor(deltas, 'C:\\WS\\game\\pong.html')).toEqual({ additions: 12, deletions: 3 })
  })

  it('offers no number where Git could not count one', () => {
    const deltas = artifactDeltas(snapshot([
      { path: 'a.bin', additions: 0, deletions: 0, binary: true },
      { path: 'b.txt', additions: 4, deletions: 0, countAvailable: false },
      { path: 'c.txt', additions: 4, deletions: 2 },
    ]))
    expect(lineDeltaFor(deltas, 'C:\\ws\\a.bin')).toBeNull()
    expect(lineDeltaFor(deltas, 'C:\\ws\\b.txt')).toBeNull()
    expect(lineDeltaFor(deltas, 'C:\\ws\\c.txt')).toEqual({ additions: 4, deletions: 2 })
  })
})

describe('the chat artifacts card', () => {
  it('names the turn, its file count and the totals it could count', () => {
    const markup = card(
      [file('pong.html'), file('index.html', 'modified')],
      artifactDeltas(snapshot([
        { path: 'game/pong.html', additions: 12, deletions: 3 },
        { path: 'game/index.html', additions: 5, deletions: 1 },
      ])),
    )
    expect(markup).toContain('已产出 2 个文件')
    expect(markup).toContain('+17')
    expect(markup).toContain('-4')
    expect(markup).toContain('game\\pong.html')
  })

  it('shows the first rows, then a footer that opens the rest', () => {
    const many = Array.from({ length: ARTIFACT_CARD_VISIBLE_ROWS + 3 }, (_, index) => file(`file-${index}.html`))
    const markup = card(many)
    expect(markup).toContain('全部 7 个文件')
    expect(markup).toContain('file-3.html')
    expect(markup).not.toContain('file-4.html')
    expect(markup).toContain('还有 3 个文件未显示')
  })

  it('keeps a row without counts openable, and gives counted rows a review target', () => {
    const markup = card([file('pong.html'), file('other.txt')], artifactDeltas(snapshot([
      { path: 'game/pong.html', additions: 12, deletions: 3 },
    ])))
    // One delta button, for the file Git reported — the other row keeps its single open target.
    expect(markup.match(/message-artifacts-row-delta/g)).toHaveLength(1)
    expect(markup).toContain('aria-label="查看 pong.html 的审阅：新增 12 行，删除 3 行"')
    expect(markup.match(/message-artifacts-row-open/g)).toHaveLength(2)
  })
})

describe('artifact count colours', () => {
  it('stays neutral at rest and colours only on hover or focus', () => {
    const rule = styles.slice(
      styles.indexOf('.line-delta-add,'),
      styles.indexOf('.message-artifacts-row-delta:hover .line-delta-add'),
    )
    expect(rule).toContain('color: var(--muted-2)')
    expect(styles).toContain('.message-artifacts-row-delta:hover .line-delta-add,')
    expect(styles).toContain('.message-artifacts-row-delta:hover .line-delta-remove,')
    expect(styles).toContain('.message-artifacts-row-delta:focus-visible .line-delta-add,')
  })
})
