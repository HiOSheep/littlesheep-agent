// Electron renderer compatibility entry.
import { AppView } from './app-shell/app-view'
import { useAppController } from './app-shell/use-app-controller'

export function App() {
  return <AppView controller={useAppController()} />
}
