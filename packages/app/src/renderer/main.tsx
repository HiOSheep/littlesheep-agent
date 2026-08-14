import { createRoot } from 'react-dom/client'
import { App } from './App'
import { preloadPersistedWorkspaceDirectory } from './workspace/directory-preload'
import './styles.css'

const rootEl = document.getElementById('root')
if (!rootEl) throw new Error('Root element #root not found')

void preloadPersistedWorkspaceDirectory()
createRoot(rootEl).render(<App />)
