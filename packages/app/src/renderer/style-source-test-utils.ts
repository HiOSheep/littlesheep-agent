import { readFile } from 'node:fs/promises'

export const RENDERER_STYLE_SOURCE_PATHS = [
  './styles/00-reset.css',
  './styles/01-checkpoint-recovery.css',
  './styles/02-memory-files.css',
  './styles/03-shell-sidebar.css',
  './styles/04-workspace.css',
  './styles/05-chat-messages.css',
  './styles/06-composer.css',
  './styles/07-overlays-settings.css',
  './styles/08-activity.css',
  './styles/09-projects-archive.css',
  './styles/10-git-review.css',
  './styles/11-runtime-readiness.css',
] as const

export interface RendererStyleSourceFile {
  path: (typeof RENDERER_STYLE_SOURCE_PATHS)[number]
  source: string
}

const manifestUrl = new URL('./styles.css', import.meta.url)
const expectedManifest = `${RENDERER_STYLE_SOURCE_PATHS
  .map((path) => `@import '${path}';`)
  .join('\n')}\n`
let sourceFilesPromise: Promise<RendererStyleSourceFile[]> | undefined

export function readRendererStyleSourceFiles(): Promise<RendererStyleSourceFile[]> {
  sourceFilesPromise ??= loadRendererStyleSourceFiles()
  return sourceFilesPromise
}

export async function readRendererStyleSource(): Promise<string> {
  return (await readRendererStyleSourceFiles()).map(({ source }) => source).join('')
}

async function loadRendererStyleSourceFiles(): Promise<RendererStyleSourceFile[]> {
  const manifest = (await readFile(manifestUrl, 'utf8')).replace(/\r\n/gu, '\n')
  if (manifest !== expectedManifest) {
    throw new Error('Renderer styles.css must remain the ordered domain import manifest.')
  }
  return Promise.all(RENDERER_STYLE_SOURCE_PATHS.map(async (path) => ({
    path,
    source: await readFile(new URL(path, manifestUrl), 'utf8'),
  })))
}
