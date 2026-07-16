// electron.vite.config.ts — multi-target build for Electron + Vite.
//
// Build strategy:
//   - main + preload: bundled as CJS, with ONLY `electron` and Node built-ins
//     externalized. Workspace packages (@littlesheep/*) are BUNDLED into the
//     output to avoid CJS/ESM interop issues (workspace packages are ESM).
//   - renderer: standard Vite + React, served via dev server or built to HTML.
//   - native or environment-sensitive modules are externalized and must
//     resolve from node_modules at runtime. Bundling Transformers.js selects
//     its browser/WASM backend and drops the matching WASM assets, so it must
//     remain external for Electron's Node main process.

import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'
import { builtinModules } from 'node:module'

const runtimeExternals = [
  'better-sqlite3',
  'node-pty',
  '@huggingface/transformers',
  'onnxruntime-node',
]

const external = [
  'electron',
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
  ...runtimeExternals,
  ...runtimeExternals.map((moduleName) => new RegExp(`^${moduleName}/.+`)),
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
