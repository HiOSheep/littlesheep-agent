import { readdir, readFile, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  parsePluginManifest,
  type LittleSheepPlugin,
  type PluginDiagnostic,
  type PluginSource,
} from './manifest.js'

const MANIFEST_FILE = 'littlesheep.plugin.json'

export interface LocalPluginDiscoveryResult {
  sources: PluginSource[]
  diagnostics: PluginDiagnostic[]
}

export async function discoverLocalPluginSources(directories: string[]): Promise<LocalPluginDiscoveryResult> {
  const sources: PluginSource[] = []
  const diagnostics: PluginDiagnostic[] = []

  for (const root of uniqueResolvedPaths(directories)) {
    if (!existsSync(root)) continue
    const candidates = [root]
    try {
      for (const entry of await readdir(root, { withFileTypes: true })) {
        if (entry.isDirectory()) candidates.push(join(root, entry.name))
      }
    } catch (error) {
      diagnostics.push({ source: root, message: `cannot read plugin directory: ${(error as Error).message}` })
      continue
    }

    for (const pluginDir of candidates) {
      const manifestPath = join(pluginDir, MANIFEST_FILE)
      if (!existsSync(manifestPath)) continue
      try {
        const manifest = parsePluginManifest(JSON.parse(await readFile(manifestPath, 'utf8')))
        if (!manifest.main) throw new Error('local plugin manifest must define main')
        const entryPath = resolveLocalEntry(pluginDir, manifest.main)
        sources.push({
          kind: 'local',
          manifest,
          location: pluginDir,
          load: async () => loadLocalPlugin(entryPath),
        })
      } catch (error) {
        diagnostics.push({ source: manifestPath, message: (error as Error).message })
      }
    }
  }

  return { sources, diagnostics }
}

function uniqueResolvedPaths(paths: string[]): string[] {
  return [...new Set(paths.map((path) => resolve(path)))]
}

function resolveLocalEntry(pluginDir: string, main: string): string {
  if (isAbsolute(main)) throw new Error('local plugin main must be relative to the plugin directory')
  const entryPath = resolve(pluginDir, main)
  const rel = relative(pluginDir, entryPath)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error('local plugin main escapes the plugin directory')
  }
  if (!existsSync(entryPath)) throw new Error(`local plugin entry does not exist: ${main}`)
  return entryPath
}

async function loadLocalPlugin(entryPath: string): Promise<LittleSheepPlugin> {
  const modified = (await stat(entryPath)).mtimeMs
  const namespace = await import(`${pathToFileURL(entryPath).href}?mtime=${modified}`) as Record<string, unknown>
  const candidate = namespace.default ?? namespace.plugin ?? namespace.littleSheepPlugin
  if (!candidate || typeof candidate !== 'object') {
    throw new Error('local plugin entry must export default, plugin, or littleSheepPlugin')
  }
  const plugin = candidate as Partial<LittleSheepPlugin>
  if (!plugin.manifest || typeof plugin.activate !== 'function') {
    throw new Error('local plugin export must provide manifest and activate(context)')
  }
  return plugin as LittleSheepPlugin
}
