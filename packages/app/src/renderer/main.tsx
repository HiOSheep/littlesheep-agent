import { createRoot } from 'react-dom/client'
import { App } from './App'
import { ContextMenuSurface } from './ui/context-menu'
import { warmVoidRingMotion } from './ui/void-ring'
import { reportRendererFirstFrame } from './runtime-readiness/renderer-timing'
import { preloadPersistedWorkspaceDirectory } from './workspace/directory-preload'
import { bootstrapAppearancePreferences } from './app-shell/appearance-preferences'
import './styles.css'

const rootEl = document.getElementById('root')
if (!rootEl) throw new Error('Root element #root not found')

// The real first frame is observed by the renderer itself, because an attached
// debugger can no longer read the paint entry. Inert unless Main enables
// bootstrap timing.
reportRendererFirstFrame()
bootstrapAppearancePreferences()
void preloadPersistedWorkspaceDirectory()
// Decode the empty conversation's mark while the app is still starting: a new conversation then
// paints its animation directly instead of swapping artwork one frame in (reported 2026-10-03).
void warmVoidRingMotion()
createRoot(rootEl).render(<><App /><ContextMenuSurface /></>)
