// Settings navigation and page composition.


export type SettingsPage = 'home' | 'application' | 'appearance' | 'agent' | 'api' | 'web' | 'storage' | 'browser' | 'developmentEnvironments' | 'scheduled' | 'memoryTree' | 'archive' | 'plugins' | 'skills' | 'channels'

export type DirectModulePage = Extract<SettingsPage, 'memoryTree' | 'scheduled' | 'plugins'>


export interface SettingsNavItem {
  page: SettingsPage
  title: string
  desc: string
  /**
   * True for a page that stays a valid route and stays searchable but must not
   * occupy the common sidebar: the scheduled placeholder is not a connected
   * capability, so it must not look like one (taskbook S1).
   */
  searchOnly?: boolean
}


export interface SettingsNavGroup {
  title: string
  items: SettingsNavItem[]
}
