// Why a Git *read* failed, in terms the user can act on (UX-28 item 1).
//
// The review path used to collapse every failure into "当前工作区不是 Git 仓库。": a
// corrupt object store, a repository Git refuses to touch because of directory
// ownership, a permission problem and a genuine non-repository all looked identical,
// and the suggested next step was wrong for three of them.
//
// Classification is deliberately text-based, against the messages Git itself prints
// (they are stable and documented), with the raw first line kept as bounded evidence.
// It never *fixes* anything: the ownership case in particular must not silently write
// `safe.directory` into the user's global config — it tells them what Git said.

export type WorkspaceGitFailureKind =
  /** Not inside a work tree at all. */
  | 'not-repository'
  /** Git refused because the directory is owned by someone else (`safe.directory`). */
  | 'dubious-ownership'
  /** The filesystem refused the read. */
  | 'permission-denied'
  /** The repository exists but its data cannot be read. */
  | 'corrupt-repository'
  /** The read ran into the bounded time limit. */
  | 'timed-out'
  /** The read was cancelled (navigation, a newer read, shutdown). */
  | 'cancelled'
  /** No usable Git executable. */
  | 'git-unavailable'
  /** Anything else: reported as-is rather than guessed. */
  | 'unknown'

export interface WorkspaceGitFailure {
  kind: WorkspaceGitFailureKind
  /** One actionable sentence for the user. */
  reason: string
  /** The bounded raw evidence (first line of what Git said). */
  detail: string
}

/** Longest detail kept: enough to recognise the failure, never a wall of stderr. */
const MAX_DETAIL_CHARS = 200

const PATTERNS: Array<{ kind: WorkspaceGitFailureKind; pattern: RegExp; reason: string }> = [
  {
    kind: 'not-repository',
    pattern: /not a git repository|not a work tree|\.git['"]? does not exist/iu,
    reason: '这个目录不是 Git 仓库；在终端里运行 git init 或选择仓库内的目录后再试。',
  },
  {
    kind: 'dubious-ownership',
    pattern: /detected dubious ownership|safe\.directory/iu,
    reason: 'Git 因目录属主与当前用户不一致而拒绝读取；按 Git 的提示把该目录加入 safe.directory（LS 不会自动改动你的全局配置）。',
  },
  {
    kind: 'corrupt-repository',
    pattern: /bad object|object file .* (?:is empty|is corrupt)|loose object .* corrupt|index file (?:corrupt|smaller than expected)|unable to read (?:tree|commit|object|blob)|bad signature|not a valid object name|fatal: bad revision|invalid object|compressed data is corrupt|inflate: data stream error|bad pack header|packfile .* corrupt/iu,
    reason: '仓库数据无法读取（对象或索引可能已损坏）；先用 git fsck 检查，必要时从备份恢复。',
  },
  {
    kind: 'permission-denied',
    pattern: /permission denied|operation not permitted|access is denied|EACCES|EPERM/iu,
    reason: '读取仓库时被系统拒绝访问；检查该目录与 .git 的权限后再试。',
  },
  {
    kind: 'timed-out',
    pattern: /git command timed out|timed out/iu,
    reason: '读取 Git 超时；仓库过大或磁盘繁忙时重试一次，或稍后再试。',
  },
  {
    kind: 'cancelled',
    pattern: /git command aborted|aborted/iu,
    reason: '读取已取消。',
  },
  {
    kind: 'git-unavailable',
    pattern: /git executable was not found|ENOENT/iu,
    reason: '没有找到可用的 Git；安装 Git 并确认它在 PATH 的绝对路径条目里。',
  },
]

/**
 * Classify a Git read failure.
 *
 * `name === 'AbortError'` is checked first: a cancelled read must never be reported as
 * a repository problem, whatever its message happens to contain.
 */
export function classifyGitFailure(error: unknown): WorkspaceGitFailure {
  const message = error instanceof Error ? error.message : String(error ?? '')
  const name = error instanceof Error ? error.name : ''
  const code = (error as NodeJS.ErrnoException | null)?.code
  const detail = firstLine(message).slice(0, MAX_DETAIL_CHARS)

  if (name === 'AbortError') {
    return { kind: 'cancelled', reason: '读取已取消。', detail }
  }
  if (code === 'ENOENT') {
    return { kind: 'git-unavailable', reason: PATTERNS[6]!.reason, detail }
  }
  for (const entry of PATTERNS) {
    // `aborted` inside an unrelated message would misfire, so cancellation is only
    // recognised through the error's own name above.
    if (entry.kind === 'cancelled') continue
    if (entry.pattern.test(message)) return { kind: entry.kind, reason: entry.reason, detail }
  }
  return {
    kind: 'unknown',
    reason: '读取 Git 时发生未分类的错误；详情见下，重试一次或改用终端查看。',
    detail,
  }
}

/** True when the failure means "this is not a repository", the one case that is normal. */
export function isNotRepositoryFailure(failure: WorkspaceGitFailure): boolean {
  return failure.kind === 'not-repository'
}

/**
 * A classified Git read failure, thrown where a caller has to decide what the user sees.
 *
 * Carrying the classification (rather than a bare message) is what lets the review
 * snapshot answer with the matching `availability` and a next step instead of one
 * generic sentence for every kind of breakage.
 */
export class WorkspaceGitReadError extends Error {
  readonly failure: WorkspaceGitFailure

  constructor(failure: WorkspaceGitFailure) {
    super(failure.reason)
    this.name = 'WorkspaceGitReadError'
    this.failure = failure
  }
}

/** The classification of a thrown error, whether or not it is already classified. */
export function gitFailureOf(error: unknown): WorkspaceGitFailure {
  return error instanceof WorkspaceGitReadError ? error.failure : classifyGitFailure(error)
}

function firstLine(message: string): string {
  return message.split(/\r?\n/u).map((line) => line.trim()).find((line) => line.length > 0) ?? ''
}
