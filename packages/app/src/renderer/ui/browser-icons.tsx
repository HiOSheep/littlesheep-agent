// Shared history icons used by the titlebar and embedded-browser toolbar.

export function HistoryBackIcon() {
  return (
    <svg className="workspace-panel-svg-icon history-navigation-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path className="workspace-browser-arrow-shaft" d="M12.5 8H3.5" />
      <path className="workspace-browser-arrow-head" d="m6.4 4.8-3.2 3.2 3.2 3.2" />
    </svg>
  )
}

export function HistoryForwardIcon() {
  return (
    <svg className="workspace-panel-svg-icon history-navigation-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path className="workspace-browser-arrow-shaft" d="M3.5 8h9" />
      <path className="workspace-browser-arrow-head" d="m9.6 4.8 3.2 3.2-3.2 3.2" />
    </svg>
  )
}

export const BrowserBackIcon = HistoryBackIcon
export const BrowserForwardIcon = HistoryForwardIcon

export function BrowserNewTabIcon() {
  return (
    <svg className="workspace-panel-svg-icon workspace-browser-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <rect x="2.65" y="3.2" width="8.9" height="9.2" rx="2" />
      <path d="M5.05 6.35h4.1M5.05 8.25h2.45M12.2 5.15v4.3M10.05 7.3h4.3" />
    </svg>
  )
}
