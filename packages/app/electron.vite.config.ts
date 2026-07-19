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
import { existsSync, readFileSync } from 'node:fs'
import { builtinModules, createRequire } from 'node:module'
import { dirname, extname, join, resolve } from 'node:path'

const configRequire = createRequire(import.meta.url)
const electronPackageRoot = dirname(configRequire.resolve('electron'))
const electronBinaryName = readFileSync(join(electronPackageRoot, 'path.txt'), 'utf8').trim()
const namedElectronPath = join(
  electronPackageRoot,
  'dist',
  `LittleSheep${extname(electronBinaryName)}`,
)
if (existsSync(namedElectronPath)) {
  process.env.ELECTRON_EXEC_PATH = namedElectronPath
}

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
    server: {
      fs: {
        allow: [resolve(__dirname, 'resources')],
      },
    },
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/renderer/index.html') },
      },
    },
    plugins: [react()],
  },
})
