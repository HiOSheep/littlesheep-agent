import { describe, expect, it } from 'vitest'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import { readRendererStyleSource, readRendererStyleSourceFiles } from './style-source-test-utils'
import { ARTIFACT_CARD_VISIBLE_ROWS, MessageArtifactsCard } from './composer/message-artifacts-card'
import { artifactDeltas, lineDeltaFor, mergeArtifactDeltas, toolCallDeltas } from './composer/use-artifact-deltas'
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

describe('artifact counts from the turn itself', () => {
  it('answers from the turn\'s own calls where the workspace is not a repository', () => {
    // The reported card (2026-10-02) came from a workplace with no repository at all, so the Git
    // snapshot had nothing and every row dropped its counts. The turn's own calls carry the same
    // numbers its transcript rows already show, so the card can answer without asking Git.
    const deltas = toolCallDeltas([
      { name: 'write', input: { file_path: 'C:\\ws\\game\\gomoku.html', content: 'a\nb\nc\n' } },
      { name: 'edit', input: { file_path: 'C:\\ws\\game\\index.html', old_string: 'one\ntwo', new_string: 'one\ntwo\nthree' } },
    ])

    // `write` overwrites if the file exists, so its old lines are unknown — null, not zero.
    expect(lineDeltaFor(deltas, 'C:\\WS\\game\\gomoku.html')).toEqual({ additions: 3, deletions: null })
    expect(lineDeltaFor(deltas, 'C:\\ws\\game\\index.html')).toEqual({ additions: 3, deletions: 2 })
  })

  it('lets the snapshot answer first and keeps the turn\'s numbers for the rest', () => {
    const tools = [
      { name: 'write', input: { file_path: 'C:\\ws\\game\\pong.html', content: 'a\nb\n' } },
      { name: 'write', input: { file_path: 'C:\\ws\\game\\notes.txt', content: 'x\n' } },
    ]
    const merged = mergeArtifactDeltas(
      toolCallDeltas(tools),
      artifactDeltas(snapshot([{ path: 'game/pong.html', additions: 400, deletions: 0 }])),
    )

    // Git is the working tree, so it wins where it has the file; the call fills in the rest.
    expect(lineDeltaFor(merged, 'C:\\ws\\game\\pong.html')).toEqual({ additions: 400, deletions: 0 })
    expect(lineDeltaFor(merged, 'C:\\ws\\game\\notes.txt')).toEqual({ additions: 1, deletions: null })
  })

  it('writes the unknown half as -0 and says where that 0 came from', () => {
    // `write` overwrites if the file exists, so its old lines are nobody's count. The pair is still
    // written as `+3 -0` — a lone `+3` leaves the reader wondering whether the turn removed nothing
    // or whether this card just does not say (2026-10-02) — and the label says the 0 is assumed.
    const markup = card([file('gomoku.html')], toolCallDeltas([
      { name: 'write', input: { file_path: 'C:\\ws\\game\\gomoku.html', content: 'a\nb\nc\n' } },
    ]))

    expect(markup).toContain('已产出 1 个文件')
    expect(markup).toContain('line-delta-add">+3</span>')
    expect(markup).toContain('line-delta-remove">-0</span>')
    expect(markup).toContain('aria-label="共新增 3 行，删除 0 行（部分文件写入前的行数未知）"')
    expect(markup).toContain('aria-label="查看 gomoku.html 的审阅：新增 3 行，删除 0 行（写入前的行数未知）"')
  })
})

describe('the chat artifacts card', () => {
  it('passes review and workspace context through the activity turn renderer', async () => {
    const chatView = await readFile(new URL('./app-shell/chat-view.tsx', import.meta.url), 'utf8')
    expect(chatView).toContain('workspaceRoot={artifactsWorkspaceRoot}')
    expect(chatView).toContain('onOpenReview={openReviewInWorkspace}')
  })

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
    // Neutral at rest, and the neutral is a token so a theme can move it.
    expect(rule).toContain('color: var(--muted)')
    // Aiming at the row is enough; the numbers do not have to be hit themselves.
    expect(styles).toContain('.message-artifacts-row:hover .line-delta-add,')
    expect(styles).toContain('.message-artifacts-row:hover .line-delta-remove,')
    expect(styles).toContain('.message-artifacts-row:focus-within .line-delta-add,')
    expect(styles).toContain('.message-artifacts-row-delta:hover .line-delta-add,')
    expect(styles).toContain('.message-artifacts-row-delta:hover .line-delta-remove,')
    expect(styles).toContain('.message-artifacts-row-delta:focus-visible .line-delta-add {')
  })
})

describe('the artifacts card keeps its own line rhythm', () => {
  it('hides the hidden-count line instead of rendering it as another card row', async () => {
    // The card is a grid, so a class with no rule made its screen-reader-only line an
    // ordinary grid item: measured in a live window on 2026-09-28 it rendered as a
    // visible 758.7x21.3 box at a 0.7px inset (against 12.7px for the header icon and
    // 16.7px for a row's path) and added 21.3px to the card's height.
    const files = await readRendererStyleSourceFiles()
    const composer = files.find((file) => file.path === './styles/06-composer.css')?.source ?? ''
    const component = await readFile(new URL('./composer/message-artifacts-card.tsx', import.meta.url), 'utf8')

    const hiddenClass = component.match(/className="([\w-]+)">还有 \{hiddenCount\}/u)?.[1]
    expect(hiddenClass).toBe('visually-hidden')

    const rule = composer.slice(composer.indexOf(`.${hiddenClass} {`))
    expect(composer).toContain(`.${hiddenClass} {`)
    const body = rule.slice(0, rule.indexOf('}'))
    for (const declaration of [
      'position: absolute',
      'width: 1px',
      'height: 1px',
      'overflow: hidden',
      'white-space: nowrap',
      'border: 0',
    ]) {
      expect(body, declaration).toContain(declaration)
    }
    // The parent banned `!important`, and nothing else targets this span.
    expect(body).not.toContain('!important')
  })
})

describe('the artifacts card is a transcript surface, not a floating panel', () => {
  async function cardRule() {
    const files = await readRendererStyleSourceFiles()
    const composer = files.find((file) => file.path === './styles/06-composer.css')?.source ?? ''
    const rule = composer.slice(composer.indexOf('.message-artifacts-card {'))
    return {
      files,
      // Comments carry the reasoning and name the token that was wrong, so the assertions below
      // read declarations only.
      body: rule.slice(0, rule.indexOf('}')).replace(/\/\*[\s\S]*?\*\//g, ''),
    }
  }

  it('keeps a real radius where the window layout flattens the floating-panel token', async () => {
    // `.window-shell` zeroes `--radius-floating-panel` for the edge-to-edge chali layout, so a
    // transcript card that borrowed that token drew square corners: reported 2026-10-01, every
    // corner of this card at 0px against the chat column. The first expectation is the guard —
    // if the window layout ever stops flattening the token, this rule can be revisited instead of
    // silently keeping a radius chosen for a reason that no longer holds.
    const { files, body } = await cardRule()
    const windowLayout = files.find((file) => file.path === './styles/14-window-layout.css')?.source ?? ''

    expect(windowLayout).toContain('--radius-floating-panel: 0px;')
    expect(body).toContain('border-radius: var(--radius-card)')
    expect(body).not.toContain('--radius-floating-panel')
  })

  it('fills one surface step deeper than the surface it read as a light block on', async () => {
    const { body } = await cardRule()

    expect(body).toContain('background: var(--chat-panel-fill)')
    expect(body).not.toContain('background: var(--surface-3)')
  })
})
