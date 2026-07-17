// Link navigation policy for internal workspace previews and system-default opening.
import {
  openExternalHref,
  openWorkspacePath,
  type RuntimeState,
} from '../api'
import { resolveLinkTarget } from '../workspace/link-target'
import { resolveWorkspacePreviewRoot } from '../workspace/path-utils'

interface LinkNavigationOptions {
  runtime: RuntimeState | null
  projectPath: string
  settingsOpen: boolean
  pushRoute: (route: { section: 'chat' }) => void
  setControlTip: (tip: null) => void
  setRuntimeError: (message: string) => void
  openFileInWorkspace: (path: string) => void
  setWorkspaceBrowserUrl: (url: string) => void
  openWorkspacePanelTab: (tab: 'browser') => void
  appMountedRef: { current: boolean }
}

export function createLinkNavigationActions(options: LinkNavigationOptions) {
  const workspaceRoot = options.runtime?.workspace ?? options.runtime?.workplace ?? options.projectPath

  function openHyperlinkInside(href: string) {
    const target = resolveLinkTarget(href, workspaceRoot)
    options.setControlTip(null)
    if (target.kind === 'web') {
      options.setWorkspaceBrowserUrl(target.href)
      options.openWorkspacePanelTab('browser')
      if (options.settingsOpen) options.pushRoute({ section: 'chat' })
      return
    }
    if (target.kind === 'file') {
      options.openFileInWorkspace(target.path)
      return
    }
    if (target.kind === 'fragment') {
      scrollToFragment(target.href)
      return
    }
    options.setRuntimeError('这个链接类型不能在 LS 内预览。')
  }

  function openHyperlinkWithSystem(href: string) {
    const target = resolveLinkTarget(href, workspaceRoot)
    options.setControlTip(null)
    void (async () => {
      try {
        if (target.kind === 'web') {
          await openExternalHref(target.href)
          return
        }
        if (target.kind === 'file') {
          const root = resolveWorkspacePreviewRoot(target.path, options.runtime, options.projectPath)
          await openWorkspacePath(root, target.path)
          return
        }
        if (target.kind === 'fragment') {
          openHyperlinkInside(target.href)
          return
        }
        throw new Error('这个链接类型不能交给系统打开。')
      } catch (error) {
        if (options.appMountedRef.current) options.setRuntimeError((error as Error).message)
      }
    })()
  }

  return { openHyperlinkInside, openHyperlinkWithSystem }
}

function scrollToFragment(href: string) {
  let id = href.slice(1)
  try {
    id = decodeURIComponent(id)
  } catch {
    // Keep malformed fragment text literal rather than failing navigation.
  }
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}
