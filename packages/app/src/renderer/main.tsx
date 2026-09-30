import { createRoot } from 'react-dom/client'
import { App } from './App'
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
createRoot(rootEl).render(<App />)
