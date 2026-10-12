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
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'

const configRequire = createRequire(import.meta.url)
const electronPackageRoot = dirname(configRequire.resolve('electron/package.json'))
const electronBinaryRelativePath = readFileSync(join(electronPackageRoot, 'path.txt'), 'utf8').trim()
if (!electronBinaryRelativePath || isAbsolute(electronBinaryRelativePath)) {
  throw new Error(`Electron path.txt contains an invalid executable path: ${electronBinaryRelativePath}`)
}
const electronDistRoot = resolve(electronPackageRoot, 'dist')
const electronExecutablePath = resolve(electronDistRoot, electronBinaryRelativePath)
const electronRelativePath = relative(electronDistRoot, electronExecutablePath)
if (electronRelativePath === '..' || electronRelativePath.startsWith(`..${sep}`) || isAbsolute(electronRelativePath)) {
  throw new Error(`Electron path.txt points outside the installed distribution: ${electronBinaryRelativePath}`)
}
const windowsRuntimeAlias = join(dirname(electronExecutablePath), `LittleSheep${extname(electronBinaryRelativePath)}`)
const configuredElectronPath = process.platform === 'win32' && existsSync(windowsRuntimeAlias)
  ? windowsRuntimeAlias
  : electronExecutablePath
if (!existsSync(configuredElectronPath)) {
  throw new Error(`Electron executable is missing at ${configuredElectronPath}`)
}
process.env.ELECTRON_EXEC_PATH = configuredElectronPath

const runtimeExternals = [
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
        allow: [resolve(__dirname)],
      },
    },
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/renderer/index.html') },
      },
    },
    plugins: [
      isolateMonacoLanguageDefinitions(),
      react(),
      rejectMonacoLanguageWorkers(),
    ],
  },
})

const monacoLanguageDefinitionPath =
  /[\\/]monaco-editor[\\/]esm[\\/]vs[\\/]basic-languages[\\/]([^\\/]+)[\\/]\1\.js(?:\?.*)?$/u
const monacoLanguageContributionImport =
  /^\s*import\s+(['"])\.\.\/\.\.\/(?:editor|base)\/[^'"\r\n]+\1;?\s*$/gmu

function isolateMonacoLanguageDefinitions() {
  return {
    name: 'isolate-monaco-language-definitions',
    enforce: 'pre' as const,
    transform(code: string, id: string) {
      if (!monacoLanguageDefinitionPath.test(id)) return null
      const isolated = code.replace(monacoLanguageContributionImport, '')
      if (isolated === code) return null
      return { code: isolated, map: null }
    },
  }
}

function rejectMonacoLanguageWorkers() {
  return {
    name: 'reject-monaco-language-workers',
    generateBundle(_options: unknown, bundle: Record<string, unknown>) {
      const workers = Object.keys(bundle).filter((file) => /(?:^|\/)(?:editor|ts|json|css|html)\.worker-[^/]+\.js$/u.test(file))
      if (workers.length > 0) {
        throw new Error(`Monaco language workers are outside the LS workspace contract: ${workers.join(', ')}`)
      }
      const contributionLeaks = Object.entries(bundle)
        .filter(([, output]) => output && typeof output === 'object' && 'code' in output)
        .filter(([, output]) => {
          const code = (output as { code?: unknown }).code
          return typeof code === 'string' && /ISuggestMemories|actionWidgetService/u.test(code)
        })
        .map(([file]) => file)
      if (contributionLeaks.length > 0) {
        throw new Error(
          `Monaco language definitions pulled editor contributions into the worker-free runtime: ${contributionLeaks.join(', ')}`,
        )
      }
    },
  }
}
