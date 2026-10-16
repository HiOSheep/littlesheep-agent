// Settings navigation and page composition.
import { lazy, Suspense } from 'react'
import { ArchiveManager } from '../ArchiveManager'
import { DirectModulePage } from './types'

const MemoryTreeView = lazy(async () => ({ default: (await import('../MemoryTreeView')).MemoryTreeView }))
const SettingsPluginsPage = lazy(async () => ({ default: (await import('./plugins')).SettingsPluginsPage }))
const SettingsScheduledPage = lazy(async () => ({ default: (await import('./scheduled')).SettingsScheduledPage }))


export function DirectModuleWorkspace({ page, onArchiveChanged }: { page: DirectModulePage; onArchiveChanged?: () => void }) {
  return (
    <main className="direct-module-workspace" aria-label={directModuleLabel(page)}>
      <div key={page} className="direct-module-page settings-page-transition with-motion">
        <DirectModulePageContent page={page} onArchiveChanged={onArchiveChanged} />
      </div>
    </main>
  )
}


export function DirectModulePageContent({ page, onArchiveChanged }: { page: DirectModulePage; onArchiveChanged?: () => void }) {
  return <Suspense fallback={<div role="status">加载{directModuleLabel(page)}…</div>}>
    {page === 'archive' ? <ArchiveManager onChanged={onArchiveChanged} /> : page === 'memoryTree' ? <MemoryTreeView /> : page === 'scheduled' ? <SettingsScheduledPage /> : <SettingsPluginsPage />}
  </Suspense>
}


export function directModuleLabel(page: DirectModulePage): string {
  if (page === 'archive') return '归档'
  if (page === 'memoryTree') return '记忆树'
  if (page === 'scheduled') return '已安排'
  return '插件'
}
