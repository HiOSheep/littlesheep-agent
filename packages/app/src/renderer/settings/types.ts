// Settings navigation and page composition.


export type SettingsPage = 'home' | 'application' | 'agent' | 'api' | 'web' | 'storage' | 'browser' | 'developmentEnvironments' | 'scheduled' | 'memoryTree' | 'archive' | 'plugins' | 'skills' | 'channels'

export type DirectModulePage = Extract<SettingsPage, 'memoryTree' | 'scheduled' | 'plugins'>


export interface SettingsNavItem {
  page: SettingsPage
  title: string
  desc: string
}


export interface SettingsNavGroup {
  title: string
  items: SettingsNavItem[]
}
