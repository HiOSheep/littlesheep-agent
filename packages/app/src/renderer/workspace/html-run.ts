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
import { failureFeedback, successFeedback, warningFeedback, type Feedback } from '../ui/feedback'
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

/** Which toolbar actions a state offers. */
export function htmlRunActions(state: HtmlRunState): { run: boolean; stop: boolean; label: string } {
  switch (state.status) {
    case 'starting':
      return { run: false, stop: false, label: '正在启动…' }
    case 'running':
      return { run: true, stop: true, label: '重新运行' }
    case 'stopped':
      return { run: true, stop: false, label: '运行' }
    case 'failed':
      return { run: true, stop: false, label: '重试运行' }
    default:
      return { run: true, stop: false, label: '运行' }
  }
}

export function htmlRunFeedback(state: HtmlRunState): Feedback | null {
  if (state.status === 'running') {
    return successFeedback('页面已在隔离的本地地址中运行；脚本、样式和本地资源按浏览器语义加载。')
  }
  if (state.status === 'stopped') return warningFeedback('运行服务已停止；页面重新加载会失败。')
  if (state.status === 'failed') return failureFeedback('无法运行这个页面。', state.message)
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
