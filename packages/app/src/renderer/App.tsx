// Electron renderer compatibility entry.
import { AppView } from './app-shell/app-view'
import { useAppViewController } from './app-shell/use-app-view-controller'

export function App() {
  return <AppView controller={useAppViewController()} />
}
