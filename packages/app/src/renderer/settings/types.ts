// Settings navigation and page composition.


export type SettingsPage = 'home' | 'application' | 'appearance' | 'agent' | 'api' | 'usage' | 'web' | 'storage' | 'browser' | 'developmentEnvironments' | 'scheduled' | 'memoryTree' | 'archive' | 'plugins' | 'skills' | 'channels'

export type DirectModulePage = Extract<SettingsPage, 'memoryTree' | 'scheduled' | 'plugins'>


/**
 * The part of a navigation entry a domain can own. The page id stays here (it is
 * the routing identity); the wording travels with the page that renders it, so
 * the sidebar entry, the settings-search hit and the page heading cannot drift.
 */
export interface SettingsNavItemDefinition {
  title: string
  desc: string
  /**
   * True for a page that stays a valid route and stays searchable but must not
   * occupy the common sidebar: the scheduled placeholder is not a connected
   * capability, so it must not look like one (taskbook S1).
   */
  searchOnly?: boolean
  /**
   * Extra words the settings search should match (S3 groundwork): the user's own
   * vocabulary for the field, kept next to the page that owns it instead of in a
   * second catalogue. Not rendered anywhere.
   */
  searchAliases?: readonly string[]
}

export interface SettingsNavItem extends SettingsNavItemDefinition {
  page: SettingsPage
}


export interface SettingsNavGroup {
  title: string
  items: SettingsNavItem[]
}
