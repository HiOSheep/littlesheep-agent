// @littlesheep/app — preload/index.ts
// Bridge between main and renderer: exposes the local app API base URL
// to the renderer via contextBridge. The renderer uses fetch() directly.

import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { BROWSER_OPEN_NEW_TAB_CHANNEL, type BrowserOpenNewTabEvent } from '../shared/browser-control-contracts'

const apiPort = process.env['LITTLESHEEP_API_PORT'] ?? '0'
const apiBase = `http://127.0.0.1:${apiPort}`

contextBridge.exposeInMainWorld('littlesheep', {
  apiBase,
  getPathForFile: (file: unknown) => {
    try {
      return webUtils.getPathForFile(file as Parameters<typeof webUtils.getPathForFile>[0])
    } catch {
      return ''
    }
  },
  onBrowserOpenNewTab: (listener: (event: BrowserOpenNewTabEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: unknown) => {
      if (!payload || typeof payload !== 'object') return
      const value = payload as Partial<BrowserOpenNewTabEvent>
      if (typeof value.url !== 'string' || !/^https?:\/\//iu.test(value.url)) return
      listener({ url: value.url, disposition: typeof value.disposition === 'string' ? value.disposition : undefined })
    }
    ipcRenderer.on(BROWSER_OPEN_NEW_TAB_CHANNEL, handler)
    return () => ipcRenderer.removeListener(BROWSER_OPEN_NEW_TAB_CHANNEL, handler)
  },
})
