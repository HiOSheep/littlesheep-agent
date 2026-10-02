// Run-state rules for the workspace HTML preview (UX-26).
//
// "Run" is a different act from "preview": preview renders a sanitized static
// document with scripts removed, run serves the saved file over a tokenised
// loopback URL so the page behaves like a page. The state is kept small and pure
// so the view only decides what to render:
//
//   idle ──run──▶ starting ──ok──▶ running(url)
//                    └──error──▶ failed(message)
//   running ──stop──▶ stopped        failed/idle ──run──▶ starting
//
// Running always uses the saved file: a dirty draft must be saved first (or the
// run is cancelled), and a failed save never runs the previous version.
import { failureFeedback, type Feedback } from '../ui/feedback'
import {
  startWorkspacePreviewServer,
  stopWorkspacePreviewServer,
} from '../api/workspace-preview-server'

export type HtmlRunStatus = 'idle' | 'starting' | 'running' | 'stopped' | 'failed'

export interface HtmlRunState {
  status: HtmlRunStatus
  url: string
  message: string
}

export const IDLE_HTML_RUN: HtmlRunState = { status: 'idle', url: '', message: '' }

/**
 * What a run has to say, and nothing more.
 *
 * A healthy run says nothing: the served page is the answer, and a success banner over every
 * preview is the kind of extra label ordinary use should not carry (reported 2026-10-02). Only a
 * failure — the one state the reader cannot infer from the page itself — is reported here; the page
 * reports its own script errors and failed resources through `run-diagnostics.tsx`.
 */
export function htmlRunFeedback(state: HtmlRunState): Feedback | null {
  if (state.status === 'failed') return failureFeedback('无法启动这个页面的本地服务。', state.message)
  return null
}

/** True while the control should present itself as busy. */
export function htmlRunBusy(state: HtmlRunState): boolean {
  return state.status === 'starting'
}

export async function startHtmlRun(root: string, path: string): Promise<HtmlRunState> {
  try {
    const server = await startWorkspacePreviewServer(root, path)
    return { status: 'running', url: server.url, message: '' }
  } catch (error) {
    return {
      status: 'failed',
      url: '',
      message: error instanceof Error ? error.message : String(error),
    }
  }
}

export async function stopHtmlRun(root: string): Promise<HtmlRunState> {
  try {
    await stopWorkspacePreviewServer(root)
    return { status: 'stopped', url: '', message: '' }
  } catch (error) {
    return {
      status: 'failed',
      url: '',
      message: error instanceof Error ? error.message : String(error),
    }
  }
}
