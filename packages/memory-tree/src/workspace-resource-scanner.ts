import { lstat, readdir } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, relative, resolve } from 'node:path';
import type {
  WorkspaceIndexedFile,
  WorkspaceIndexedFileKind,
  WorkspaceResourceChange,
  WorkspaceResourceIndexLimits,
  WorkspaceResourceIndexSnapshot,
} from './workspace-resource-index.js';

const SKIPPED_DIRECTORIES = new Set([
  '.git', '.hg', '.svn', '.idea', '.vscode', 'node_modules', 'vendor', 'dist', 'out',
  'build', 'coverage', 'cache', 'tmp', 'temp',
]);
const SENSITIVE_FILE_NAMES = new Set([
  '.env', '.env.local', 'credentials', 'credentials.json', 'secrets.json', 'id_rsa', 'id_ed25519',
]);
const SENSITIVE_EXTENSIONS = new Set(['.key', '.pem', '.pfx', '.p12']);
const CODE_EXTENSIONS = new Set([
  '.c', '.cc', '.cpp', '.cs', '.css', '.go', '.h', '.hpp', '.html', '.java', '.js', '.jsx',
  '.kt', '.lua', '.php', '.py', '.rb', '.rs', '.scss', '.sh', '.sql', '.swift', '.ts', '.tsx',
  '.vue', '.xml', '.zig',
]);
const TEXT_EXTENSIONS = new Set([
  '.csv', '.ini', '.json', '.jsonl', '.log', '.md', '.markdown', '.mdx', '.toml', '.tsv', '.txt',
  '.yaml', '.yml',
]);
const IMAGE_EXTENSIONS = new Set(['.bmp', '.gif', '.jpeg', '.jpg', '.png', '.svg', '.tiff', '.webp']);
const DOCUMENT_EXTENSIONS = new Set(['.doc', '.docx', '.pdf', '.ppt', '.pptx', '.xls', '.xlsx']);
const ARCHIVE_EXTENSIONS = new Set(['.7z', '.gz', '.rar', '.tar', '.tgz', '.zip']);
const DATA_EXTENSIONS = new Set(['.db', '.parquet', '.sqlite', '.sqlite3']);

export function startWorkspaceScanGeneration(
  snapshot: WorkspaceResourceIndexSnapshot,
  timestamp: string,
): void {
  snapshot.scan = {
    status: 'scanning',
    generation: snapshot.scan.generation + 1,
    queue: [{ relativeDir: '', depth: 0 }],
    startedAt: timestamp,
    completedAt: undefined,
    lastSyncedAt: timestamp,
    scannedDirectories: 0,
    truncated: false,
  };
}

export async function applyWorkspaceResourceChange(
  snapshot: WorkspaceResourceIndexSnapshot,
  root: string,
  change: WorkspaceResourceChange,
  generation: number,
  maxFiles: number,
): Promise<boolean> {
  const target = resolve(change.path);
  if (!isWorkspacePathInside(root, target)) return false;
  const relativePath = normalizeWorkspaceRelativePath(relative(root, target));
  if (!relativePath || relativePath.length > 600 || isSensitiveFile(basename(target))) return false;
  const index = snapshot.files.findIndex((file) => file.relativePath === relativePath);
  const info = await lstat(target).catch(() => undefined);
  if (!info?.isFile() || info.isSymbolicLink()) {
    if (index < 0) return false;
    snapshot.files.splice(index, 1);
    return true;
  }
  if (index < 0 && snapshot.files.length >= maxFiles * 2) {
    snapshot.scan.truncated = true;
    return false;
  }
  const next: WorkspaceIndexedFile = {
    relativePath,
    name: basename(target),
    extension: extname(target).toLocaleLowerCase(),
    kind: classifyFile(target),
    size: info.size,
    mtimeMs: info.mtimeMs,
    owner: change.source,
    generation,
  };
  if (index >= 0) snapshot.files[index] = next;
  else snapshot.files.push(next);
  return true;
}

export async function scanWorkspaceResourceBatch(
  snapshot: WorkspaceResourceIndexSnapshot,
  root: string,
  timestamp: string,
  limits: WorkspaceResourceIndexLimits,
): Promise<void> {
  const files = new Map(snapshot.files.map((file) => [file.relativePath, file]));
  let processed = 0;
  while (snapshot.scan.queue.length > 0 && processed < limits.maxDirectoriesPerSync) {
    const cursor = snapshot.scan.queue.shift()!;
    processed += 1;
    snapshot.scan.scannedDirectories += 1;
    const directoryPath = cursor.relativeDir ? resolve(root, cursor.relativeDir) : root;
    if (!isWorkspacePathInside(root, directoryPath)) {
      snapshot.scan.truncated = true;
      continue;
    }
    let entries: import('node:fs').Dirent[];
    try {
      entries = await readdir(directoryPath, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort(compareDirectoryEntries);
    if (entries.length > limits.maxEntriesPerDirectory) snapshot.scan.truncated = true;
    for (const entry of entries.slice(0, limits.maxEntriesPerDirectory)) {
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
      const relativePath = normalizeWorkspaceRelativePath(join(cursor.relativeDir, entry.name));
      if (!relativePath || relativePath.length > 600) continue;
      if (entry.isDirectory()) {
        const lower = entry.name.toLocaleLowerCase();
        if (SKIPPED_DIRECTORIES.has(lower)) continue;
        if (cursor.depth >= limits.maxDepth) {
          snapshot.scan.truncated = true;
          continue;
        }
        if (snapshot.scan.queue.length >= limits.maxPendingDirectories) {
          snapshot.scan.truncated = true;
          continue;
        }
        snapshot.scan.queue.push({ relativeDir: relativePath, depth: cursor.depth + 1 });
        continue;
      }
      if (!entry.isFile() || isSensitiveFile(entry.name)) continue;

      const currentGenerationCount = [...files.values()].filter((file) => (
        file.generation === snapshot.scan.generation
      )).length;
      const existing = files.get(relativePath);
      if (!existing && currentGenerationCount >= limits.maxFiles) {
        snapshot.scan.truncated = true;
        continue;
      }
      const filePath = resolve(root, relativePath);
      if (!isWorkspacePathInside(root, filePath)) continue;
      const info = await lstat(filePath).catch(() => undefined);
      if (!info?.isFile() || info.isSymbolicLink()) continue;
      files.set(relativePath, {
        relativePath,
        name: entry.name,
        extension: extname(entry.name).toLocaleLowerCase(),
        kind: classifyFile(entry.name),
        size: info.size,
        mtimeMs: info.mtimeMs,
        owner: existing?.owner ?? 'user',
        generation: snapshot.scan.generation,
      });
    }
  }

  if (snapshot.scan.queue.length === 0) {
    snapshot.files = [...files.values()].filter((file) => file.generation === snapshot.scan.generation);
    snapshot.scan.status = 'complete';
    snapshot.scan.completedAt = timestamp;
  } else {
    snapshot.files = [...files.values()]
      .sort((left, right) => right.generation - left.generation || left.relativePath.localeCompare(right.relativePath, 'zh-CN'))
      .slice(0, limits.maxFiles * 2);
  }
  snapshot.scan.lastSyncedAt = timestamp;
}

export function selectWorkspaceFiles(
  files: WorkspaceIndexedFile[],
  query: string | undefined,
  maxEntries: number,
): WorkspaceIndexedFile[] {
  const limit = Math.max(1, Math.min(512, Math.floor(maxEntries)));
  const terms = (query ?? '').trim().toLocaleLowerCase().split(/[^\p{L}\p{N}_.-]+/u).filter((term) => term.length > 1);
  if (terms.length === 0) return files.slice(0, limit);
  const matches = files
    .map((file) => {
      const haystack = `${file.relativePath} ${file.kind} ${file.extension}`.toLocaleLowerCase();
      const matched = terms.filter((term) => haystack.includes(term)).length;
      return { file, score: matched / terms.length };
    })
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.file.relativePath.localeCompare(right.file.relativePath, 'zh-CN'))
    .slice(0, limit)
    .map((item) => item.file);
  return matches.length > 0 ? matches : files.slice(0, limit);
}

function compareDirectoryEntries(left: import('node:fs').Dirent, right: import('node:fs').Dirent): number {
  const leftPriority = left.isFile() ? 0 : directoryPriority(left.name);
  const rightPriority = right.isFile() ? 0 : directoryPriority(right.name);
  return leftPriority - rightPriority || left.name.localeCompare(right.name, 'zh-CN');
}

function directoryPriority(name: string): number {
  const lower = name.toLocaleLowerCase();
  if (lower === 'src') return 1;
  if (lower === 'docs') return 2;
  if (lower === 'app' || lower === 'apps') return 3;
  if (lower === 'packages') return 4;
  if (lower === 'test' || lower === 'tests') return 5;
  return 10;
}

function classifyFile(fileName: string): WorkspaceIndexedFileKind {
  const ext = extname(fileName).toLocaleLowerCase();
  if (CODE_EXTENSIONS.has(ext)) return 'code';
  if (TEXT_EXTENSIONS.has(ext)) return 'text';
  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
  if (DOCUMENT_EXTENSIONS.has(ext)) return 'document';
  if (ARCHIVE_EXTENSIONS.has(ext)) return 'archive';
  if (DATA_EXTENSIONS.has(ext)) return 'data';
  return 'other';
}

function isSensitiveFile(name: string): boolean {
  const lower = name.toLocaleLowerCase();
  return lower.startsWith('.') || SENSITIVE_FILE_NAMES.has(lower) || SENSITIVE_EXTENSIONS.has(extname(lower));
}

export function normalizeWorkspaceRelativePath(value: string): string {
  return value.replace(/\\/gu, '/').replace(/^\.\//u, '').replace(/\/{2,}/gu, '/').replace(/\/$/u, '');
}

export function isWorkspacePathInside(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}
