import { useLayoutEffect, useRef, useState } from 'react'
import type * as Monaco from 'monaco-editor'
import type { LineCommentRange } from './line-comment-gesture'
import type { WorkspaceLineComment } from './line-comment-model'

interface LineCommentViewZoneBase {
  key: string
  startLine: number
  endLine: number
  top: number
  height: number
  host: HTMLDivElement
  viewZone: Monaco.editor.IViewZone
}

export interface LineCommentEditorViewZone extends LineCommentViewZoneBase {
  kind: 'editor'
}

export interface LineCommentPublishedViewZone extends LineCommentViewZoneBase {
  kind: 'comment'
  comment: WorkspaceLineComment
}

export type LineCommentViewZone = LineCommentEditorViewZone | LineCommentPublishedViewZone

export type LineCommentEditorZoneRecord = { id: string; zone: LineCommentViewZone }

interface LineCommentViewZoneSpecBase {
  key: string
  range: LineCommentRange
  afterLineNumber: number
  height: number
}

export type LineCommentViewZoneSpec = LineCommentViewZoneSpecBase & (
  | { kind: 'editor' }
  | { kind: 'comment'; comment: WorkspaceLineComment }
)

function createLineCommentViewZone(input: LineCommentViewZoneSpec): LineCommentViewZone {
  const host = document.createElement('div')
  host.className = `workspace-line-comment-zone ${input.kind}`
  host.setAttribute('aria-hidden', 'true')
  const base = {
    key: input.key,
    startLine: input.range.startLine,
    endLine: input.range.endLine,
    top: -input.height,
    height: input.height,
    host,
    viewZone: {
      afterLineNumber: input.afterLineNumber,
      heightInPx: input.height,
      domNode: host,
    },
  }
  return input.kind === 'comment'
    ? { ...base, kind: 'comment', comment: input.comment }
    : { ...base, kind: 'editor' }
}

function addLineCommentViewZone(
  accessor: Monaco.editor.IViewZoneChangeAccessor,
  zone: LineCommentViewZone,
  onTopChange: (key: string, top: number) => void,
): string {
  zone.viewZone.onDomNodeTop = (top) => {
    zone.top = top
    onTopChange(zone.key, top)
  }
  return accessor.addZone(zone.viewZone)
}

export function useLineCommentViewZones(
  editor: Monaco.editor.ICodeEditor | null,
  specs: readonly LineCommentViewZoneSpec[],
) {
  const [zoneHosts, setZoneHosts] = useState<LineCommentViewZone[]>([])
  const editorZoneRecordRef = useRef<LineCommentEditorZoneRecord | null>(null)

  useLayoutEffect(() => {
    if (!editor) {
      editorZoneRecordRef.current = null
      setZoneHosts([])
      return
    }
    const zones: LineCommentViewZone[] = []
    const zoneIds: string[] = []
    let editorRecord: LineCommentEditorZoneRecord | null = null
    let disposed = false
    editor.changeViewZones((accessor) => {
      for (const spec of specs) {
        const zone = createLineCommentViewZone(spec)
        const id = addLineCommentViewZone(accessor, zone, (key, top) => {
          if (!disposed) setZoneHosts((current) => updateZoneTop(current, key, top))
        })
        if (zone.kind === 'editor') editorRecord = { id, zone }
        zones.push(zone)
        zoneIds.push(id)
      }
    })
    editorZoneRecordRef.current = editorRecord
    setZoneHosts(zones)
    return () => {
      disposed = true
      if (editorZoneRecordRef.current === editorRecord) editorZoneRecordRef.current = null
      editor.changeViewZones((accessor) => {
        for (const zoneId of zoneIds) accessor.removeZone(zoneId)
      })
    }
  }, [editor, specs])

  return {
    zoneHosts,
    setZoneHosts,
    editorZoneRecordRef,
    editorZoneHost: zoneHosts.find((zone) => zone.kind === 'editor')?.host ?? null,
  }
}

function updateZoneTop(zones: LineCommentViewZone[], key: string, top: number): LineCommentViewZone[] {
  const index = zones.findIndex((zone) => zone.key === key)
  if (index < 0 || zones[index]?.top === top) return zones
  const next = [...zones]
  next[index] = { ...next[index]!, top }
  return next
}
