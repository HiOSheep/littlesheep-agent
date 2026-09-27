// Reuse the previous preimage when the data root has not changed.
//
// Every run commits a rollback preimage of the managed data directories before anything else happens. That
// costs a walk, a `git ls-files`, one `stat` per path, one `git add` per 128 paths and a commit — and on a
// warm installation most runs change nothing at all, so all of it buys an identical commit. Measured on the
// cold-start metric: 448–563 ms of a ~915 ms wait for the first token.
//
// The signature is deliberately cheap: path, size and mtime of every managed file, taken from the walk the
// preimage already performs. A content change inside one mtime tick without a size change would be missed,
// so the reuse only happens when the *tracked* path count also matches the walked count — a run that
// versioned anything the walk cannot see falls back to the full commit. Missing a change would lose a
// rollback point, which is the one direction this must not fail in.
import { readFile, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface PreimageFileStat {
  path: string
  sizeBytes: number
  mtimeMs: number
}

export interface PreimageSignature {
  version: 2
  /** Commit the signature describes; reused as the next run's preimage. */
  commit: string
  /** Paths that commit tracks — reported by a manifest without listing the tree again. */
  trackedCount: number
}

export function signaturePath(gitDir: string): string {
  return join(gitDir, 'littlesheep-preimage.json')
}

export function buildSignature(commit: string, trackedCount: number): PreimageSignature {
  return { version: 2, commit, trackedCount }
}

export async function readSignature(gitDir: string): Promise<PreimageSignature | undefined> {
  try {
    const parsed = JSON.parse(await readFile(signaturePath(gitDir), 'utf8')) as PreimageSignature
    if (parsed?.version !== 2 || typeof parsed.commit !== 'string') return undefined
    if (typeof parsed.trackedCount !== 'number') return undefined
    return parsed
  } catch {
    return undefined
  }
}

export async function writeSignature(gitDir: string, signature: PreimageSignature): Promise<void> {
  await writeFile(signaturePath(gitDir), JSON.stringify(signature), 'utf8').catch(() => undefined)
}

/** Drop the record; the next run then pays the full preimage instead of trusting a stale signature. */
export async function clearSignature(gitDir: string): Promise<void> {
  await unlink(signaturePath(gitDir)).catch(() => undefined)
}
