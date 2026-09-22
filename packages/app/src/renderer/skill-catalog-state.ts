// Pure state for the skills page.
//
// "Still loading", "loaded and genuinely empty" and "failed to load" are three
// different facts and must not collapse into one empty view. A failed reload
// keeps the list the user is already reading and marks it as not refreshed
// instead of silently replacing it with nothing.
import type { SkillDetail, SkillMeta } from './api'

export type SkillCatalogStatus = 'loading' | 'ready' | 'error'

export interface SkillCatalogState {
  status: SkillCatalogStatus
  skills: SkillMeta[]
  /** Latest list failure; kept while a previously loaded list is still shown. */
  loadError: string | null
  /** A reload failed after a successful load, so the shown list may be out of date. */
  stale: boolean
  selected: SkillDetail | null
  /** Detail read that failed, so retry targets the same skill and the list stays. */
  failedDetailName: string | null
  detailError: string | null
  /** Newest list request; responses from older requests are ignored. */
  listRequestId: number
  /** Newest detail request; rapid switching must not publish an older skill. */
  detailRequestId: number
}

export type SkillCatalogAction =
  | { type: 'load-start'; requestId: number }
  | { type: 'load-success'; requestId: number; skills: SkillMeta[] }
  | { type: 'load-failure'; requestId: number; message: string }
  | { type: 'detail-start'; requestId: number; name: string }
  | { type: 'detail-success'; requestId: number; detail: SkillDetail }
  | { type: 'detail-failure'; requestId: number; name: string; message: string }
  | { type: 'detail-close' }

export function initialSkillCatalogState(): SkillCatalogState {
  return {
    status: 'loading',
    skills: [],
    loadError: null,
    stale: false,
    selected: null,
    failedDetailName: null,
    detailError: null,
    listRequestId: 0,
    detailRequestId: 0,
  }
}

export function skillCatalogReducer(
  state: SkillCatalogState,
  action: SkillCatalogAction,
): SkillCatalogState {
  switch (action.type) {
    case 'load-start':
      return {
        ...state,
        listRequestId: action.requestId,
        // A reload keeps the visible list; only the first load has nothing to show.
        status: state.skills.length > 0 ? 'ready' : 'loading',
        loadError: null,
      }
    case 'load-success':
      if (action.requestId !== state.listRequestId) return state
      return { ...state, status: 'ready', skills: action.skills, loadError: null, stale: false }
    case 'load-failure':
      if (action.requestId !== state.listRequestId) return state
      if (state.skills.length === 0) {
        return { ...state, status: 'error', loadError: action.message, stale: false }
      }
      return { ...state, status: 'ready', loadError: action.message, stale: true }
    case 'detail-start':
      return { ...state, detailRequestId: action.requestId, detailError: null, failedDetailName: null }
    case 'detail-success':
      if (action.requestId !== state.detailRequestId) return state
      return { ...state, selected: action.detail, detailError: null, failedDetailName: null }
    case 'detail-failure':
      if (action.requestId !== state.detailRequestId) return state
      // Keep the list and the user's current selection; only the detail read failed.
      return { ...state, detailError: action.message, failedDetailName: action.name }
    case 'detail-close':
      return { ...state, selected: null, detailError: null, failedDetailName: null }
  }
}

/**
 * Bounded, user-readable failure text. The Local App API message is a Runtime
 * fact, so it is shown as-is when present and never rewritten into a claim
 * about skills having been removed.
 */
export function skillErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const normalized = message.replace(/\s+/gu, ' ').trim()
  if (!normalized) return '原因未知'
  return normalized.length <= 180 ? normalized : `${normalized.slice(0, 179)}…`
}
