// @littlesheep/app — preload/index.ts
// Bridge between main and renderer: exposes the local app API base URL
// to the renderer via contextBridge. The renderer uses fetch() directly.

import { contextBridge, webUtils } from 'electron'

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
})
