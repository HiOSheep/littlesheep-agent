// electron.vite.config.ts — multi-target build for Electron + Vite.
//
// Build strategy:
//   - main + preload: bundled as CJS, with ONLY `electron` and Node built-ins
//     externalized. Workspace packages (@littlesheep/*) are BUNDLED into the
//     output to avoid CJS/ESM interop issues (workspace packages are ESM).
//   - renderer: standard Vite + React, served via dev server or built to HTML.
//   - native modules (e.g. better-sqlite3) are externalized and must resolve
//     from node_modules at runtime. Add more to `nativeModules` as needed.

import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'
import { builtinModules } from 'node:module'

// Native modules that cannot be bundled — must resolve at runtime.
// Add entries here when the build fails on a specific native dependency.
const nativeModules = ['better-sqlite3', 'node-pty']

const external = [
  'electron',
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
  ...nativeModules,
  ...nativeModules.map((m) => new RegExp(`^${m}/.+`)),
]

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        external,
        input: { index: resolve(__dirname, 'src/main/index.ts') },
      },
    },
  },
  preload: {
    build: {
      rollupOptions: {
        external,
        input: { index: resolve(__dirname, 'src/preload/index.ts') },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/renderer/index.html') },
      },
    },
    plugins: [react()],
  },
})
