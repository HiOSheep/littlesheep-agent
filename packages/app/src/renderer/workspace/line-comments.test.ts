import { readFile } from 'node:fs/promises'
import { readRendererStyleSource } from '../style-source-test-utils'
import { describe, expect, it } from 'vitest'
import {
  didLineCommentGestureDrag,
  resolveLineCommentGesture,
} from './line-comment-gesture'
import {
  LINE_COMMENT_ADD_BUTTON_SIZE,
  mapModelRangeToSource,
  mapSourceRangeToModel,
  resolveLineCommentAddButtonLeft,
} from './line-comments'

describe('workspace line comments', () => {
  it('uses Monaco line events and inline view zones instead of covering later code', async () => {
    const source = await readFile(new URL('./line-comments.tsx', import.meta.url), 'utf8')
    const surface = await readFile(new URL('./line-comment-surface.tsx', import.meta.url), 'utf8')
    const viewZones = await readFile(new URL('./line-comment-view-zones.ts', import.meta.url), 'utf8')
    const styles = await readRendererStyleSource()

    expect(source).toContain('editor.onMouseMove')
    expect(source).toContain('readCommentableLineAtClientPoint')
    expect(source).toContain('browserEvent.clientX')
    expect(source).toContain("editorHost.addEventListener('pointerdown', beginReadOnlyLineGesture, true)")
    expect(source).toContain("window.addEventListener('pointerup', finishReadOnlyLineGesture, true)")
    expect(source).toContain('editor.getTargetAtClientPoint')
    expect(source).toContain('if (!gesture.didDrag) {')
    expect(source).toContain('if (gesture.didDrag) beginComment(range)')
    expect(source).toContain('else toggleComment(range)')
    expect(source).toContain("targetElement?.closest('.workspace-line-comment-add, .workspace-line-comment-overlay-zone')")
    expect(source).not.toContain('pointerEvent.preventDefault()')
    expect(source).toContain('useLineCommentViewZones(editor, zoneSpecs)')
    expect(viewZones).toContain('editor.changeViewZones')
    expect(source).toContain('afterLineNumber: modelEndLine')
    expect(viewZones).toContain('zone.viewZone.onDomNodeTop = (top) => {')
    expect(surface).toContain('workspace-line-comment-add')
    expect(viewZones).toContain('workspace-line-comment-zone')
    expect(source).toContain('workspace-line-comment-overlay-zone')
    expect(source).toContain('comment.endLine === undefined ? {} : { endLine: comment.endLine }')
    expect(styles).toContain('.workspace-line-comment-hover-state')
    expect(styles).toContain('.workspace-line-comment-selected-state')
    expect(styles).toMatch(/\.workspace-line-comment-selected-state\s*\{[\s\S]*?background:\s*rgba\(121, 174, 255, 0\.12\);/s)
    expect(styles).toContain('.workspace-line-comment-zone')
    expect(styles).toContain('.workspace-line-comment-overlay-zone')
    expect(styles).toContain('.workspace-comment-published-margin')
    expect(source).toContain('workspace-line-comment-selected-state')
    expect(source).not.toContain("className: 'workspace-comment-selected-line'")
    expect(source).toContain("marginClassName: 'workspace-comment-published-margin'")
    expect(source).not.toContain('linesDecorationsClassName')
    expect(styles).toContain('.monaco-editor.workspace-monaco-readonly .cursor')
    expect(styles).toMatch(/\.workspace-line-comment-editor-heading strong\s*\{[\s\S]*?font-size:\s*13px;/s)
    expect(surface).toContain('useLayoutEffect(() => {')
    expect(surface).toContain('input.textareaRef.current?.focus()')
  })

  it('resolves deleted-line comments from the full row width', async () => {
    const source = await readFile(new URL('./review-inline-deleted-comments.tsx', import.meta.url), 'utf8')

    expect(source).toContain('readDeletedLineTargetAtClientPoint')
    expect(source).toContain('clientY - editorRect.top')
    expect(source).toContain('target.top + target.height')
  })

  it('opens one line on click and waits until pointer release for multi-line drag selection', () => {
    expect(resolveLineCommentGesture({
      didDrag: false,
      pressedLine: 7,
      releasedLine: 7,
      selection: null,
    })).toEqual({ startLine: 7, endLine: 7 })

    expect(resolveLineCommentGesture({
      didDrag: true,
      pressedLine: 4,
      releasedLine: 8,
      selection: { startLineNumber: 4, endLineNumber: 8, endColumn: 6 },
    })).toEqual({ startLine: 4, endLine: 8 })
  })

  it('does not open a comment for a drag that only selects one line', () => {
    expect(resolveLineCommentGesture({
      didDrag: true,
      pressedLine: 4,
      releasedLine: 4,
      selection: { startLineNumber: 4, endLineNumber: 4, endColumn: 12 },
    })).toBeNull()
  })

  it('excludes Monaco half-open final lines from a dragged range', () => {
    expect(resolveLineCommentGesture({
      didDrag: true,
      pressedLine: 4,
      releasedLine: 8,
      selection: { startLineNumber: 4, endLineNumber: 8, endColumn: 1 },
    })).toEqual({ startLine: 4, endLine: 7 })
  })

  it('uses a movement threshold so a normal click is not misclassified as a drag', () => {
    expect(didLineCommentGestureDrag(100, 100, 102, 102)).toBe(false)
    expect(didLineCommentGestureDrag(100, 100, 104, 100)).toBe(true)
  })

  it('centres the add button between the line number and code content', async () => {
    const layout = {
      lineNumbersLeft: 8,
      lineNumbersWidth: 48,
      decorationsLeft: 56,
      decorationsWidth: 28,
      contentLeft: 84,
    }
    const left = resolveLineCommentAddButtonLeft(layout)

    expect(left).toBe(59)
    expect(left).not.toBeNull()
    expect(left!).toBeGreaterThanOrEqual(layout.lineNumbersLeft + layout.lineNumbersWidth)
    expect(left! + LINE_COMMENT_ADD_BUTTON_SIZE).toBeLessThanOrEqual(layout.contentLeft)
    expect(resolveLineCommentAddButtonLeft({ ...layout, decorationsWidth: 12, contentLeft: 68 })).toBeNull()

    const source = await readFile(new URL('./line-comments.tsx', import.meta.url), 'utf8')
    const deletedSource = await readFile(new URL('./review-inline-deleted-comments.tsx', import.meta.url), 'utf8')
    const surface = await readFile(new URL('./line-comment-surface.tsx', import.meta.url), 'utf8')
    const styles = await readRendererStyleSource()
    expect(source).toContain('left={addButtonLeft}')
    expect(deletedSource).toContain('left={addButtonLeft}')
    expect(source).toContain('<LineCommentAddButton')
    expect(deletedSource).toContain('<LineCommentAddButton')
    expect(surface.split('workspace-line-comment-add-icon').length - 1).toBe(1)
    expect(styles).toMatch(/\.workspace-line-comment-add\s*\{[^}]*border:\s*0;/s)
    expect(styles).toMatch(/\.workspace-line-comment-add-icon::before\s*\{[^}]*width:\s*10px;[^}]*height:\s*2px;/s)
    expect(styles).toMatch(/\.workspace-line-comment-add-icon::after\s*\{[^}]*width:\s*2px;[^}]*height:\s*10px;/s)
    expect(source).toContain("marginClassName: 'workspace-comment-published-margin'")
    expect(source).not.toContain('workspace-comment-line-marker')
    expect(deletedSource).toContain('workspace-review-inline-deleted-comment-state selected')
  })

  it('maps diff model lines to source lines without crossing omitted regions', () => {
    const sourceLines = [10, 11, null, 90, 91]
    const lineNumbers = {
      toSourceLine: (modelLine: number) => sourceLines[modelLine - 1] ?? null,
      toModelLine: (sourceLine: number) => {
        const index = sourceLines.indexOf(sourceLine)
        return index < 0 ? null : index + 1
      },
    }

    expect(mapModelRangeToSource({ startLine: 1, endLine: 2 }, lineNumbers))
      .toEqual({ startLine: 10, endLine: 11 })
    expect(mapSourceRangeToModel({ startLine: 90, endLine: 91 }, lineNumbers))
      .toEqual({ startLine: 4, endLine: 5 })
    expect(mapModelRangeToSource({ startLine: 2, endLine: 4 }, lineNumbers)).toBeNull()
    expect(mapSourceRangeToModel({ startLine: 11, endLine: 90 }, lineNumbers)).toBeNull()
  })

  it('keeps native controls outside Monaco while view zones only reserve layout space', async () => {
    const source = await readFile(new URL('./line-comments.tsx', import.meta.url), 'utf8')
    const deletedSource = await readFile(new URL('./review-inline-deleted-comments.tsx', import.meta.url), 'utf8')
    const surface = await readFile(new URL('./line-comment-surface.tsx', import.meta.url), 'utf8')
    const viewZones = await readFile(new URL('./line-comment-view-zones.ts', import.meta.url), 'utf8')
    const styles = await readRendererStyleSource()

    expect(source).not.toContain("import { createPortal } from 'react-dom'")
    expect(viewZones).not.toContain('host.addEventListener')
    expect(source).toContain('className={`workspace-line-comment-overlay-zone ${zone.kind}`}')
    expect(viewZones).toContain("host.setAttribute('aria-hidden', 'true')")
    expect(surface).toContain('onClick={onCancel}')
    expect(surface).toContain("if (event.key !== 'Escape') return")
    expect(surface).toContain('event.stopPropagation()')
    expect(surface).toContain('onSubmit={(event) => {')
    expect(source).toContain('editor.setSelection(new monaco.Selection(')
    expect(source).not.toContain('<form')
    expect(deletedSource).not.toContain('<form')
    expect(source).not.toContain('data-line-comment-action')
    expect(source).not.toContain('actionButton.dataset.lineCommentAction')
    expect(styles).toMatch(/\.workspace-line-comment-zone\s*\{[^}]*pointer-events:\s*none/s)
    expect(styles).toMatch(/\.workspace-line-comment-editor,[\s\S]*?pointer-events:\s*auto/s)
  })

  it('keeps the comment editor as one flat surface with one line-range label', async () => {
    const source = await readFile(new URL('./line-comment-surface.tsx', import.meta.url), 'utf8')
    const styles = await readRendererStyleSource()

    const lineRangeLabel = '<span>{formatLineRange(range.startLine, range.endLine)}</span>'
    expect(source.split(lineRangeLabel).length - 1).toBe(1)
    expect(source.split('<form').length - 1).toBe(1)
    expect(styles).toMatch(/\.workspace-line-comment-editor,[\s\S]*?background:\s*var\(--surface\);[\s\S]*?border:\s*0;[\s\S]*?box-shadow:\s*none;/s)
    expect(styles).toMatch(/\.workspace-line-comment-editor textarea\s*\{[\s\S]*?background:\s*transparent;[\s\S]*?border:\s*0;[\s\S]*?border-radius:\s*0;[\s\S]*?box-shadow:\s*none;/s)
    expect(styles).toMatch(/\.workspace-line-comment-editor textarea:focus-visible\s*\{[\s\S]*?outline:\s*0;[\s\S]*?outline-offset:\s*0;/s)
  })

  it('centers the comment editor action labels inside their buttons', async () => {
    const styles = await readRendererStyleSource()

    expect(styles).toMatch(/\.workspace-line-comment-editor-actions button\s*\{[\s\S]*?display:\s*inline-flex;[\s\S]*?align-items:\s*center;[\s\S]*?justify-content:\s*center;[\s\S]*?line-height:\s*1;/s)
  })

  it('auto-sizes the draft and its Monaco view zone without a resize handle', async () => {
    const source = await readFile(new URL('./line-comment-surface.tsx', import.meta.url), 'utf8')
    const styles = await readRendererStyleSource()

    expect(source).toContain("textarea.style.height = '0px'")
    expect(source).toContain('Math.ceil(textarea.scrollHeight)')
    expect(source).toContain('record.zone.viewZone.heightInPx = nextZoneHeight')
    expect(source).toContain('accessor.layoutZone(record.id)')
    expect(source).toContain('new ResizeObserver')
    expect(source).not.toContain('const height = 190')
    expect(styles).toMatch(/\.workspace-line-comment-editor textarea\s*\{[\s\S]*?height:\s*auto;[\s\S]*?overflow-y:\s*hidden;[\s\S]*?resize:\s*none;/s)
  })

  it('keeps readonly line comments separate from Monaco text editing', async () => {
    const preview = await readFile(new URL('./preview-pane.tsx', import.meta.url), 'utf8')

    expect(preview).toContain('domReadOnly: !editing')
    expect(preview).toContain("extraEditorClassName: editing ? '' : 'workspace-monaco-readonly'")
    expect(preview).toContain('readOnly={!editing}')
  })

  it('keeps hover highlighting in edit mode while disabling comment controls', async () => {
    const source = await readFile(new URL('./line-comments.tsx', import.meta.url), 'utf8')

    expect(source).toContain('const mappedEditingRange = useMemo')
    expect(source).toContain('const activeEditingRange = readOnly && mappedEditingRange')
    expect(source).toContain('if (!readOnly) return')
    expect(source).toContain('if (!readOnly) draft.cancel()')
    expect(source).toContain('readOnly && hoveredLine !== null')
    expect(source).toContain('className="workspace-line-comment-hover-state"')
    expect(source).toContain('style={{ top: hoveredMetric.top, height: hoveredMetric.height }}')
  })

  it('routes published comments through the existing composer attachment state', async () => {
    const panel = await readFile(new URL('./panel.tsx', import.meta.url), 'utf8')
    const dock = await readFile(new URL('../app-shell/workspace-dock-view.tsx', import.meta.url), 'utf8')
    const composer = await readFile(new URL('../composer/message-files.tsx', import.meta.url), 'utf8')

    expect(panel).toContain('onAddAttachment={onAddAttachment}')
    expect(dock).toContain('mergeLineCommentAttachment(current, attachment)')
    expect(composer).toContain("`${lineComments.length} 条行评论`")
  })
})
