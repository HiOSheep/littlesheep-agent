import { projectAppController, type AppViewController } from './app-controller-projections'
import { useAppController } from './use-app-controller'

export function useAppViewController(): AppViewController {
  return projectAppController(useAppController())
}
