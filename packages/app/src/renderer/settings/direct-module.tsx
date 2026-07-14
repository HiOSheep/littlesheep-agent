// Settings navigation and page composition.
import { MemoryTreeView } from '../MemoryTreeView'
import { SettingsPluginsPage } from './plugins'
import { SettingsScheduledPage } from './scheduled'
import { DirectModulePage } from './types'


export function DirectModuleWorkspace({ page }: { page: DirectModulePage }) {
  return (
    <main className="direct-module-workspace" aria-label={directModuleLabel(page)}>
      <div key={page} className="direct-module-page settings-page-transition with-motion">
        <DirectModulePageContent page={page} />
      </div>
    </main>
  )
}


export function DirectModulePageContent({ page }: { page: DirectModulePage }) {
  if (page === 'memoryTree') return <MemoryTreeView />
  if (page === 'scheduled') return <SettingsScheduledPage />
  return <SettingsPluginsPage />
}


export function directModuleLabel(page: DirectModulePage): string {
  if (page === 'memoryTree') return '记忆树'
  if (page === 'scheduled') return '已安排'
  return '插件'
}
