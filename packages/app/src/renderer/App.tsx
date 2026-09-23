import { AppView } from './app-shell/app-view'
import { useAppViewController } from './app-shell/use-app-view-controller'
import { RuntimeReadinessNotice } from './runtime-readiness/runtime-readiness-notice'
import { useRuntimeReadiness } from './runtime-readiness/use-runtime-readiness'

export function App() {
  // The window is shown before the Runner exists, so the shell reports the
  // Runtime's real stage instead of pretending every capability is available.
  const { readiness, reason } = useRuntimeReadiness()
  return (
    <>
      <AppView controller={useAppViewController()} />
      <RuntimeReadinessNotice readiness={readiness} reason={reason} />
    </>
  )
}
