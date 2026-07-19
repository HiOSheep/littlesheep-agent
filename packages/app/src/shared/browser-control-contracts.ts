// Contracts for the persistent embedded-browser session and its settings page.

export interface BrowserStorageStatus {
  partition: string
  persistent: true
  cookieCount: number
  cookieDomainCount: number
}

export interface BrowserStorageOperationResult {
  ok: true
  clearedAt: string
  status: BrowserStorageStatus
}

export const EMBEDDED_BROWSER_PARTITION = 'persist:littlesheep-browser'
export const BROWSER_OPEN_NEW_TAB_CHANNEL = 'littlesheep:browser-open-new-tab'

export interface BrowserOpenNewTabEvent {
  url: string
  disposition?: string
}
