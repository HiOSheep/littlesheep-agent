#!/usr/bin/env node

import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const failures = []
const passes = []
let trackedFilesCache

function pass(label, detail = '') {
  passes.push({ label, detail })
}

function fail(label, detail = '') {
  failures.push({ label, detail })
}

function assert(condition, label, detail = '') {
  if (condition) pass(label, detail)
  else fail(label, detail)
}

function displayPath(path) {
  return relative(repoRoot, path).replaceAll('\\', '/') || '.'
}

async function readText(path) {
  return readFile(path, 'utf8')
}

async function readJson(path, label) {
  try {
    return JSON.parse(await readText(path))
  } catch (error) {
    fail(label, `${displayPath(path)}: ${error.message}`)
    return null
  }
}

function trackedFiles() {
  if (trackedFilesCache) return trackedFilesCache

  const result = spawnSync('git', ['ls-files', '-z'], { cwd: repoRoot, encoding: 'utf8' })
  if (result.status !== 0) {
    fail('Git 跟踪文件清单可读', result.stderr?.trim() || `git exited ${result.status}`)
    trackedFilesCache = []
    return trackedFilesCache
  }

  trackedFilesCache = result.stdout
    .split('\0')
    .filter(Boolean)
    .map((path) => path.replaceAll('\\', '/'))
  return trackedFilesCache
}

/** Commit time (seconds) of the last commit touching the given pathspecs. */
function lastCommitSeconds(pathspecs) {
  const result = spawnSync('git', ['log', '-1', '--format=%ct', ...pathspecs], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
  if (result.status !== 0) return 0
  const seconds = Number(result.stdout.trim())
  return Number.isFinite(seconds) ? seconds : 0
}

async function collectPackageDirectories() {  const packageDirs = []
  const packageRoot = join(repoRoot, 'packages')

  for (const entry of await readdir(packageRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === 'channels') continue
    const dir = join(packageRoot, entry.name)
    if (existsSync(join(dir, 'package.json'))) packageDirs.push(dir)
  }

  const channelRoot = join(packageRoot, 'channels')
  for (const entry of await readdir(channelRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const dir = join(channelRoot, entry.name)
    if (existsSync(join(dir, 'package.json'))) packageDirs.push(dir)
  }

  return packageDirs
}

async function collectSourceFiles(root) {
  const files = []
  const entries = await readdir(root, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'out') continue
    const absolute = join(root, entry.name)
    if (entry.isDirectory()) {
      files.push(...await collectSourceFiles(absolute))
    } else if (entry.isFile() && ['.ts', '.tsx'].includes(extname(entry.name).toLowerCase())) {
      files.push(absolute)
    }
  }
  return files
}

async function collectMarkdownFiles(root) {
  const files = []
  const entries = await readdir(root, { withFileTypes: true })
  for (const entry of entries) {
    const absolute = join(root, entry.name)
    if (entry.isDirectory()) {
      files.push(...await collectMarkdownFiles(absolute))
    } else if (entry.isFile() && extname(entry.name).toLowerCase() === '.md') {
      files.push(absolute)
    }
  }
  return files
}

async function checkPublishedSurface() {
  const tracked = trackedFiles()
  const rootMarkdown = tracked.filter((path) => !path.includes('/') && extname(path).toLowerCase() === '.md')
  assert(
    rootMarkdown.length === 1 && rootMarkdown[0] === 'README.md',
    '根目录只发布 README Markdown',
    rootMarkdown.join(', '),
  )

  const allowedHiddenRoots = new Set(['.github'])
  const hiddenRoots = [...new Set(tracked
    .filter((path) => path.includes('/'))
    .map((path) => path.split('/', 1)[0])
    .filter((name) => name.startsWith('.') && !allowedHiddenRoots.has(name)))]
  assert(hiddenRoots.length === 0, '未跟踪本地隐藏工作目录', hiddenRoots.join(', '))

  const readme = await readText(join(repoRoot, 'README.md'))
  const docsIndexPath = join(repoRoot, 'docs', 'README.md')
  const docsIndex = existsSync(docsIndexPath) ? await readText(docsIndexPath) : ''
  const actualDocs = (await collectMarkdownFiles(join(repoRoot, 'docs'))).map(displayPath)
  const unlistedDocs = actualDocs
    .filter((path) => path !== 'docs/README.md')
    .filter((path) => !docsIndex.includes(path.slice('docs/'.length)))
  assert(readme.includes('docs/README.md'), '根 README 指向唯一文档入口')
  assert(unlistedDocs.length === 0, '正式文档均可从分层入口定位', unlistedDocs.join(', '))

  const progressiveSections = [
    '## 现在先做什么',
    '## 需要确认依据时',
    '## 需要修改长期方向时',
    '## 已决定方向后再看任务书',
    '## 需要定位代码或维护仓库时',
  ]
  const missingSections = progressiveSections.filter((heading) => !docsIndex.includes(heading))
  assert(missingSections.length === 0, '文档入口遵守渐进式披露层级', missingSections.join(', '))

  const publicTextExtensions = new Set([
    '.bat', '.cjs', '.css', '.html', '.js', '.json', '.jsx', '.md', '.mjs',
    '.ps1', '.ts', '.tsx', '.yaml', '.yml',
  ])
  const trackedTextFiles = tracked.filter((path) =>
    path !== 'pnpm-lock.yaml' && publicTextExtensions.has(extname(path).toLowerCase()) && existsSync(join(repoRoot, path)),
  )
  const textFiles = [...new Set([...trackedTextFiles, ...actualDocs])]
  const metadataFiles = textFiles.filter((path) =>
    path === 'README.md' ||
    path === 'package.json' ||
    path.startsWith('docs/') ||
    path.startsWith('scripts/') ||
    path.endsWith('.bat'),
  )
  const localPathPatterns = [
    /[a-z]:[\\/]Users[\\/](?!<)[^\\/\s`"')]+/ig,
    /[a-z]:[\\/]tools[\\/]littlesheep/ig,
    /file:\/{2,3}[a-z]:\/(?:Users|tools)\//ig,
    /\b28971\b/g,
  ]
  const localPathMatches = []
  for (const path of metadataFiles) {
    const content = await readText(join(repoRoot, path))
    for (const pattern of localPathPatterns) {
      pattern.lastIndex = 0
      const match = pattern.exec(content)
      if (match) localPathMatches.push(`${path}: ${match[0]}`)
    }
  }
  assert(localPathMatches.length === 0, '公开文档和脚本不含本机路径或账号', localPathMatches.join(', '))
}

async function checkCanonicalFiles() {
  const required = [
    'docs/README.md',
    'docs/principles/architecture-principles.md',
    'docs/decision/architecture-decision-report.md',
    'docs/decision/project-status.md',
    'docs/reference/repository-guide.md',
    'docs/reference/plugin-development.md',
    // Taskbooks are execution-time working documents. A finished or superseded
    // one is retired after its still-true facts move into the document that owns
    // them, so none of them is canonical here (see checkTaskbookBudget).
    'scripts/build-app.ps1',
    'scripts/start-littlesheep.ps1',
    'scripts/prepare-littlesheep-runtime.mjs',
    'scripts/refresh-desktop-shortcut.ps1',
    'scripts/verify-app-recovery-sources.mjs',
    'scripts/workspace-projects.mjs',
    'scripts/sync-typescript-projects.mjs',
    'scripts/run-affected-verification.mjs',
    'scripts/run-verification-gate.mjs',
    'scripts/run-task-verification.mjs',
    'scripts/verify-memory-v3-soak.mjs',
    'scripts/verify-memory-v3-compaction-continuity.mjs',
    'scripts/verify-electron-deepseek-compaction-continuity.mjs',
    'scripts/verify-memory-v3-migration-readiness.mjs',
    'tsconfig.workspace.json',
    'build-app.bat',
    'start-littlesheep.bat',
  ]
  const missing = required.filter((path) => !existsSync(join(repoRoot, path)))
  assert(missing.length === 0, '正式文档和维护脚本完整', missing.join(', '))

  const ignore = await readText(join(repoRoot, '.gitignore'))
  const requiredIgnoreRules = ['packages/app/out/', 'dist/', '*.tsbuildinfo']
  const missingIgnoreRules = requiredIgnoreRules.filter((rule) => !ignore.split(/\r?\n/).includes(rule))
  assert(missingIgnoreRules.length === 0, '生成物已忽略', missingIgnoreRules.join(', '))

  const scriptFiles = trackedFiles().filter((path) =>
    path.startsWith('scripts/') || path === 'build-app.bat' || path === 'start-littlesheep.bat',
  )
  const hardcodedRoot = /[a-z]:[\\/]tools[\\/]littlesheep/i
  const hardcodedPaths = []
  for (const path of scriptFiles) {
    if (hardcodedRoot.test(await readText(join(repoRoot, path)))) hardcodedPaths.push(path)
  }
  assert(hardcodedPaths.length === 0, '维护脚本与仓库位置无关', hardcodedPaths.join(', '))
}

async function checkTaskbookBudget() {
  /**
   * Taskbooks are execution-time working documents, not permanent fact sources.
   * A finished one is retired: consolidate what is still true into the document
   * that owns it, then `git rm` it (the text stays in git history). The budget
   * is what makes that retirement happen "promptly" instead of never — past the
   * limit, a new taskbook can only be added after an old one is retired.
   */
  const budget = 16
  const taskbooks = trackedFiles()
    .filter((path) => path.startsWith('docs/taskbooks/') && path.endsWith('.md'))
  assert(
    taskbooks.length <= budget,
    '任务书数量在预算内',
    `${taskbooks.length}/${budget}`,
  )
}

async function checkTaskbookNaming() {
  const documents = await collectMarkdownFiles(join(repoRoot, 'docs'))
  const taskbooks = documents
    .filter((path) => path.includes('taskbook') && path.endsWith('.md'))
  const violations = []
  for (const path of documents) {
    const content = await readText(path)
    if (!/^最后更新：\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/mu.test(content)) {
      violations.push(`${displayPath(path)}: 正文缺少秒级最后更新时间`)
    }
  }
  for (const path of taskbooks) {
    const name = displayPath(path)
    const match = name.match(/-taskbook-(\d{4}-\d{2}-\d{2})\.md$/u)
    if (!match) {
      violations.push(`${name}: 文件名缺少任务书基线日期`)
      continue
    }
    const date = match[1]
    const content = await readText(path)
    const title = content.split(/\r?\n/u, 1)[0]?.trim() ?? ''
    const updated = content.match(/^最后更新：(\d{4}-\d{2}-\d{2}) \d{2}:\d{2}:\d{2}$/mu)?.[1]
    if (!title.endsWith(date)) violations.push(`${name}: 一级标题日期应为 ${date}`)
    if (updated && updated < date) violations.push(`${name}: 最后更新时间不能早于基线日期 ${date}`)
  }
  assert(taskbooks.length > 0 && violations.length === 0, '文档秒级更新时间与任务书基线日期有效', violations.join(', '))
}

async function checkWorkspacePackages() {
  const workspaceFile = await readText(join(repoRoot, 'pnpm-workspace.yaml'))
  assert(workspaceFile.includes("'packages/*'"), 'workspace 包含 packages/*')
  assert(workspaceFile.includes("'packages/channels/*'"), 'workspace 包含 packages/channels/*')

  const packageDirs = await collectPackageDirectories()
  const names = new Set()
  for (const dir of packageDirs) {
    const manifest = await readJson(join(dir, 'package.json'), 'workspace package.json 可解析')
    if (!manifest) continue
    if (typeof manifest.name !== 'string' || !manifest.name.startsWith('@littlesheep/')) {
      fail('workspace 包名有效', displayPath(dir))
    } else if (names.has(manifest.name)) {
      fail('workspace 包名唯一', manifest.name)
    } else {
      names.add(manifest.name)
    }

    const expectedEntries = manifest.name === '@littlesheep/app'
      ? ['src/main/index.ts', 'src/preload/index.ts', 'src/renderer/main.tsx']
      : ['src/index.ts']
    const missingEntries = expectedEntries.filter((path) => !existsSync(join(dir, path)))
    if (missingEntries.length > 0) {
      fail('workspace 包入口存在', `${displayPath(dir)}: ${missingEntries.join(', ')}`)
    }
  }
  assert(packageDirs.length > 0, 'workspace 包可发现', `${packageDirs.length} package(s)`)
  assert(names.size === packageDirs.length, 'workspace 包清单有效且唯一', `${names.size}/${packageDirs.length}`)
  assert(names.has('@littlesheep/plugins'), '插件运行时包存在')
  assert(!existsSync(join(repoRoot, 'packages', 'gateway')), '旧渠道网关包已移除')

  const rootManifest = await readJson(join(repoRoot, 'package.json'), '根 package.json 可解析')
  const repositoryCheck = rootManifest?.scripts?.['check:repo'] ?? ''
  assert(
    repositoryCheck.includes('node scripts/check-repository-hygiene.mjs') &&
      repositoryCheck.includes('node scripts/sync-typescript-projects.mjs --check'),
    'check:repo 脚本已接入',
  )
}

async function checkRepositoryNavigation() {
  const packageDirs = await collectPackageDirectories()
  const missingPackageReadmes = packageDirs
    .filter((dir) => !existsSync(join(dir, 'README.md')))
    .map(displayPath)
  assert(missingPackageReadmes.length === 0, 'workspace package README 完整', missingPackageReadmes.join(', '))

  const requiredDomainReadmes = [
    'packages/app/src/main',
    'packages/app/src/main/local-app-api',
    'packages/app/src/preload',
    'packages/app/src/renderer',
    'packages/app/src/renderer/api',
    'packages/app/src/renderer/app-shell',
    'packages/app/src/renderer/approval',
    'packages/app/src/renderer/chat',
    'packages/app/src/renderer/composer',
    'packages/app/src/renderer/runtime',
    'packages/app/src/renderer/settings',
    'packages/app/src/renderer/sidebar',
    'packages/app/src/renderer/ui',
    'packages/app/src/renderer/workspace',
    'packages/app/src/shared',
    'packages/cli/src/commands',
    'packages/context/src/context-engine',
    'packages/harness/src/hooks',
    'packages/harness/src/llm-call-contracts',
    'packages/harness/src/stages',
    'packages/harness/src/stages/execute',
    'packages/harness/src/stages/verify',
    'packages/memory-tree/src/memory-repository',
    'packages/memory-tree/src/memory-service',
    'packages/plugins/src/channel',
    'packages/tools/src/builtin',
  ]
  const missingDomainReadmes = requiredDomainReadmes
    .filter((path) => !existsSync(join(repoRoot, path, 'README.md')))
  assert(missingDomainReadmes.length === 0, '独立领域 README 完整', missingDomainReadmes.join(', '))

  /**
   * Every README under `packages/` carries a second-precision `最后更新` line.
   * The rule is not decoration: a README states what a package owns right now, so
   * a change that alters a package's surface has to touch its README in the same
   * commit, and the timestamp is what makes that visible in review instead of
   * leaving documentation to drift silently.
   */
  const packageReadmes = trackedFiles().filter(
    (path) => path.startsWith('packages/') && path.endsWith('README.md'),
  )
  const missingStamps = []
  for (const path of packageReadmes) {
    const content = await readText(join(repoRoot, path))
    if (!/^最后更新：\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/mu.test(content)) {
      missingStamps.push(path)
    }
  }
  assert(
    missingStamps.length === 0,
    'package README 带秒级最后更新',
    missingStamps.join(', '),
  )

  /**
   * And the stamp has to move with the code: if a directory's sources were
   * committed after its README, the README was not updated in the same change.
   * Only committed history is compared, so an in-progress working tree does not
   * fail the gate — the check fires on the commit that skipped the README.
   */
  const staleReadmes = []
  for (const path of packageReadmes) {
    const dir = dirname(path)
    const readmeTime = lastCommitSeconds(['--', path])
    // Other READMEs in the same tree are documentation, not the surface this file
    // describes, so they are excluded: updating a leaf README must not force its
    // parent README to move.
    const sourceTime = lastCommitSeconds(['--', dir, ':(exclude,glob)**/README.md'])
    if (readmeTime > 0 && sourceTime > readmeTime) staleReadmes.push(path)
  }
  assert(
    staleReadmes.length === 0,
    'package README 与源码同步更新',
    staleReadmes.join(', '),
  )

  const sourceFiles = (await collectSourceFiles(join(repoRoot, 'packages')))
    .filter((file) => !/\.(test|spec)\.[^.]+$/u.test(file))
  const largeFiles = []
  const missingHeaders = []
  for (const file of sourceFiles) {
    const lines = (await readText(file)).split(/\r?\n/u)
    if (lines.length - (lines.at(-1) === '' ? 1 : 0) <= 300) continue
    largeFiles.push({ path: displayPath(file), lines: lines.length - (lines.at(-1) === '' ? 1 : 0) })
    const firstMeaningful = lines.find((line) => line.trim().length > 0)?.trim() ?? ''
    if (!firstMeaningful.startsWith('//') && !firstMeaningful.startsWith('/*')) {
      missingHeaders.push(displayPath(file))
    }
  }
  assert(missingHeaders.length === 0, '大型生产文件有职责头注释', missingHeaders.join(', '))

  // These are the current composition hotspots. A later split may lower a
  // baseline; adding new responsibilities must never increase it.
  const hotspotBaselines = {
    // 2026-09-23: App.tsx now mounts the readiness notice beside AppView, so a
    // cold-start window can report the Runtime's real stage. Keep it at this
    // measured boundary; further shell logic belongs in app-shell/.
    'packages/app/src/renderer/App.tsx': 16,
    // 2026-09-02: startup recovery, runtime settings and session projection
    // changes are frozen here; the facade is now in the hard-limit queue.
    'packages/app/src/renderer/app-shell/use-app-controller.ts': 655,
    // 2026-08-14: stable conversation-turn request identity and rejected-input
    // retention are now owned by this facade; further growth remains blocked.
    'packages/app/src/renderer/chat/run-actions.ts': 349,
    'packages/app/src/renderer/settings/plugins.tsx': 394,
    // 2026-09-02: browser/file glyph families and compatibility tests are
    // frozen at the measured boundary; future growth remains blocked.
    // 2026-09-26: FolderGlyphIcon moved into file-glyph-icons.tsx with the file
    // glyphs, lowering the ceiling from 359 to the measured 350.
    'packages/app/src/renderer/ui/icons.tsx': 350,
    // 2026-08-13: the old files.tsx coordinator was removed. The remaining
    // workspace ownership boundaries are explicit and may only shrink.
    'packages/app/src/renderer/workspace/file-navigator.tsx': 455,
    'packages/app/src/renderer/workspace/panel.tsx': 403,
    'packages/app/src/renderer/workspace/preview-pane.tsx': 453,
    'packages/app/src/renderer/workspace/review.tsx': 383,
    'packages/app/src/renderer/workspace/terminal.tsx': 564,
    // 2026-08-14: file-close/save recovery callbacks were added at the
    // workspace boundary; keep the controller at this measured ceiling.
    'packages/app/src/renderer/workspace/use-workspace-layout-controller.ts': 614,
    // 2026-08-14: attachment lease protection is initialized with the API
    // server; route composition must move to the existing adapter boundary.
    // 2026-09-23: the listener now starts before the Runner, so this facade
    // also owns the readiness short-circuit and lazy Runner resolution. Extract
    // startLocalAppApiServer into a dedicated composition module before adding
    // a new responsibility here.
    'packages/app/src/main/local-app-api-server.ts': 320,
    'packages/app/src/renderer/api.ts': 22,
    'packages/memory-tree/src/memory-repository.ts': 172,
    'packages/memory-tree/src/memory-service.ts': 343,
    'packages/context/src/engine.ts': 180,
    'packages/harness/src/stages/execute.ts': 46,
    'packages/harness/src/stages/verify.ts': 145,
    'packages/app/src/renderer/MemoryTreeView.tsx': 206,
  }
  const growth = []
  for (const [path, baseline] of Object.entries(hotspotBaselines)) {
    const file = join(repoRoot, path)
    if (!existsSync(file)) {
      growth.push(`${path}: 文件不存在`)
      continue
    }
    const lines = (await readText(file)).split(/\r?\n/u)
    const count = lines.length - (lines.at(-1) === '' ? 1 : 0)
    if (count > baseline) growth.push(`${path}: ${count} > ${baseline}`)
  }
  assert(growth.length === 0, '核心组合热点未继续增长', growth.join(', '))

  const splitMap = await readText(join(repoRoot, 'docs', 'reference', 'module-split-map.md'))
  const missingFromSplitMap = largeFiles
    .map((entry) => entry.path)
    .filter((path) => !splitMap.includes(`\`${path}\``))
  assert(missingFromSplitMap.length === 0, '300 行以上生产文件已登记', missingFromSplitMap.join(', '))

  const controlled = new Map()
  // The section declares ONE due date for every row and the rows carry `同上`, so renewing
  // the review is a single edit instead of 22. The previous per-row dates could not be kept
  // honest by anything: they all silently expired together.
  const reviewDue = /本轮复查到期：(\d{4}-\d{2}-\d{2})/u.exec(splitMap)?.[1] ?? null
  const controlledPattern = /^\| `([^`]+)` \| ([^|]+) \| ([^|]+) \| (\d+) \| ([^|]+) \|$/gmu
  for (const match of splitMap.matchAll(controlledPattern)) {
    controlled.set(match[1], {
      owner: match[2].trim(),
      reason: match[3].trim(),
      ceiling: Number(match[4]),
      reviewAt: match[5].trim(),
    })
  }
  const hardLimitFiles = largeFiles.filter((entry) => entry.lines > 600)
  const controlledViolations = []
  const today = new Date().toISOString().slice(0, 10)
  if (!reviewDue) controlledViolations.push('缺少"本轮复查到期：YYYY-MM-DD"声明')
  else if (reviewDue < today) controlledViolations.push(`本轮复查到期日已过 ${reviewDue}：必须逐条复查后顺延`)
  for (const entry of hardLimitFiles) {
    const exception = controlled.get(entry.path)
    if (!exception) {
      controlledViolations.push(`${entry.path}: 缺少受控超限登记`)
      continue
    }
    if (!exception.owner || !exception.reason) controlledViolations.push(`${entry.path}: 所有者或原因为空`)
    if (entry.lines > exception.ceiling) {
      controlledViolations.push(`${entry.path}: ${entry.lines} > 受控上限 ${exception.ceiling}`)
    }
    if (exception.reviewAt !== '同上') {
      controlledViolations.push(`${entry.path}: 复查日期必须写"同上"，实际为 ${exception.reviewAt}`)
    }
  }
  for (const path of controlled.keys()) {
    if (!hardLimitFiles.some((entry) => entry.path === path)) controlledViolations.push(`${path}: 已不超过 600 行，应移除登记`)
  }
  assert(controlledViolations.length === 0, '600 行以上生产文件受控', controlledViolations.join(', '))
  if (reviewDue && reviewDue >= today) pass('受控超限复查到期', reviewDue)

  /**
   * The queue counts are hand-written review notes, so they are VERIFIED here rather than
   * generated: a generator would silently rewrite the very numbers (ceilings, queue rows)
   * that exist to make the reader look at the file again.
   */
  async function productionLineCount(rel) {
    const file = join(repoRoot, rel)
    if (!existsSync(file)) return null
    const fileLines = (await readText(file)).split(/\r?\n/u)
    return fileLines.length - (fileLines.at(-1) === '' ? 1 : 0)
  }
  const queueCounts = new Map(largeFiles.map((entry) => [entry.path, entry.lines]))
  const countMismatches = []
  let splitSection = ''
  for (const line of splitMap.split(/\r?\n/u)) {
    if (line.startsWith('## ')) {
      splitSection = line.slice(3).trim()
      continue
    }
    if (splitSection === '强制拆分队列' || splitSection === '软上限审查队列') {
      const match = /^\| `([^`]+)` \| (\d+) \|/u.exec(line)
      if (!match) continue
      const actual = queueCounts.get(match[1]) ?? await productionLineCount(match[1])
      if (actual === null) countMismatches.push(`${match[1]}: 表内登记但文件不存在`)
      else if (String(actual) !== match[2]) countMismatches.push(`${match[1]}: 表内 ${match[2]} ≠ 实测 ${actual}`)
    }
    if (splitSection === '已完成拆分') {
      const match = /^\| `([^`]+)` \| \d+ \| (\d+) 行/u.exec(line)
      if (!match) continue
      const actual = await productionLineCount(match[1])
      if (actual === null) countMismatches.push(`${match[1]}: 当前入口文件不存在`)
      else if (String(actual) !== match[2]) countMismatches.push(`${match[1]} 当前入口: 表内 ${match[2]} ≠ 实测 ${actual}`)
    }
  }
  assert(countMismatches.length === 0, '模块拆分地图计数与实测一致', countMismatches.join(', '))
  pass('大型生产文件基线', `${largeFiles.length} 个文件超过 300 行；${hardLimitFiles.length} 个受控超过 600 行`)
}

async function checkModuleBoundaries() {
  const packageDirs = await collectPackageDirectories()
  const violations = []
  const importPattern = /(?:from\s+|import\s*\()(['"])(@littlesheep\/[^'"\s]+)\1/g
  const publicSubpaths = new Map()

  for (const packageDir of packageDirs) {
    const manifest = await readJson(join(packageDir, 'package.json'), '模块边界 package.json 可解析')
    if (!manifest?.name) continue
    const exportsField = manifest.exports && typeof manifest.exports === 'object' ? manifest.exports : {}
    publicSubpaths.set(
      manifest.name,
      new Set(Object.keys(exportsField).filter((key) => key.startsWith('./') && key !== '.')),
    )
  }

  for (const packageDir of packageDirs) {
    const manifest = await readJson(join(packageDir, 'package.json'), '模块边界 package.json 可解析')
    if (!manifest?.name) continue
    const packageName = manifest.name.replace('@littlesheep/', '')
    const sourceRoot = join(packageDir, 'src')
    if (!existsSync(sourceRoot)) continue

    for (const file of await collectSourceFiles(sourceRoot)) {
      const content = (await readText(file)).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')
      for (const match of content.matchAll(importPattern)) {
        const specifier = match[2]
        const dependency = specifier.replace('@littlesheep/', '')
        const [dependencyName, ...subpathParts] = dependency.split('/')
        const isChannel = dependencyName.startsWith('channel-')

        if (subpathParts.length > 0) {
          const publicPath = `./${subpathParts.join('/')}`
          const allowed = publicSubpaths.get(`@littlesheep/${dependencyName}`)?.has(publicPath) === true
          if (!allowed) {
            violations.push(`${displayPath(file)}: deep import ${specifier}`)
            continue
          }
        }
        if (packageName !== 'app' && (dependencyName === 'app' || isChannel)) {
          violations.push(`${displayPath(file)}: core package imports ${specifier}`)
          continue
        }
        if (packageName === 'types' && dependencyName !== 'types') {
          violations.push(`${displayPath(file)}: types imports ${specifier}`)
        }
      }
    }
  }

  assert(violations.length === 0, 'workspace 模块依赖方向有效', violations.join(', '))

  const manifests = new Map()
  for (const packageDir of packageDirs) {
    const manifest = await readJson(join(packageDir, 'package.json'), '依赖图 package.json 可解析')
    if (manifest?.name) manifests.set(manifest.name, manifest)
  }
  const graph = new Map()
  for (const [name, manifest] of manifests) {
    const dependencies = Object.entries({
      ...(manifest.dependencies ?? {}),
      ...(manifest.optionalDependencies ?? {}),
      ...(manifest.peerDependencies ?? {}),
    })
      .filter(([dependency, version]) => manifests.has(dependency) && String(version).startsWith('workspace:'))
      .map(([dependency]) => dependency)
    graph.set(name, dependencies)
  }
  const cycles = findDependencyCycles(graph)
  assert(cycles.length === 0, 'workspace 运行时依赖无环', cycles.map((cycle) => cycle.join(' -> ')).join(', '))

  const contractOwners = new Map([
    ['AttachmentManifest', 'packages/types/src/runtime-contracts.ts'],
    ['ContextSnapshot', 'packages/types/src/runtime-contracts.ts'],
    ['LlmCallContract', 'packages/types/src/runtime-contracts.ts'],
    ['MemoryIntentDecisionRecord', 'packages/types/src/runtime-contracts.ts'],
    ['ModelRequestSnapshot', 'packages/types/src/runtime-contracts.ts'],
    ['ResolvedRunConfig', 'packages/types/src/runtime-contracts.ts'],
    ['RuntimeEventEnvelope', 'packages/types/src/runtime-contracts.ts'],
    ['TaskBook', 'packages/types/src/task.ts'],
    ['VerificationRecord', 'packages/types/src/task.ts'],
  ])
  const duplicateContracts = []
  for (const packageDir of packageDirs) {
    for (const file of await collectSourceFiles(join(packageDir, 'src'))) {
      if (/\.(test|spec)\.[^.]+$/u.test(file)) continue
      const path = displayPath(file)
      const content = await readText(file)
      for (const [contract, owner] of contractOwners) {
        const declaration = new RegExp(`^export\\s+(?:interface|type)\\s+${contract}\\b`, 'mu')
        if (path !== owner && declaration.test(content)) duplicateContracts.push(`${path}: ${contract}（权威来源 ${owner}）`)
      }
    }
  }
  assert(duplicateContracts.length === 0, '核心协议类型保持唯一来源', duplicateContracts.join(', '))
}

function findDependencyCycles(graph) {
  const state = new Map()
  const stack = []
  const cycles = []
  const seen = new Set()

  function visit(node) {
    state.set(node, 1)
    stack.push(node)
    for (const dependency of graph.get(node) ?? []) {
      if ((state.get(dependency) ?? 0) === 0) visit(dependency)
      else if (state.get(dependency) === 1) {
        const start = stack.indexOf(dependency)
        const cycle = [...stack.slice(start), dependency]
        const key = [...new Set(cycle.slice(0, -1))].sort().join('|')
        if (!seen.has(key)) {
          seen.add(key)
          cycles.push(cycle)
        }
      }
    }
    stack.pop()
    state.set(node, 2)
  }

  for (const node of graph.keys()) {
    if ((state.get(node) ?? 0) === 0) visit(node)
  }
  return cycles
}

async function checkExtensionArchitectureNames() {
  const forbiddenPatterns = [
    /@littlesheep\/gateway/g,
    /packages\/gateway/g,
    /\bGatewayService\b/g,
    /\bgatewayService\b/g,
    /\/gateway\/(?:status|reload)\b/g,
  ]
  const extensions = new Set(['.js', '.json', '.md', '.mjs', '.ts', '.tsx', '.yaml', '.yml'])
  const matches = []
  for (const path of trackedFiles()) {
    if (path === 'scripts/check-repository-hygiene.mjs') continue
    const absolute = join(repoRoot, path)
    if (!existsSync(absolute) || !extensions.has(extname(path).toLowerCase())) continue
    const content = await readText(absolute)
    for (const pattern of forbiddenPatterns) {
      pattern.lastIndex = 0
      if (pattern.test(content)) matches.push(path)
    }
  }
  assert(matches.length === 0, '旧渠道网关架构名称未回流', [...new Set(matches)].join(', '))
}

async function checkMemoryV3WriteBoundary() {
  const retiredPaths = [
    'packages/memory-core/src/archive.ts',
    'packages/memory-core/src/archive.test.ts',
    'packages/memory-core/src/vector-decorator.ts',
    'packages/memory-core/src/vector-decorator.test.ts',
    'packages/memory-core/src/distill.ts',
    'packages/cli/src/commands/archive.ts',
    'packages/cli/src/commands/archive.test.ts',
  ]
  const retiredFiles = retiredPaths
    .filter((path) => existsSync(join(repoRoot, path)))
  const sourceFiles = await collectSourceFiles(join(repoRoot, 'packages'))
  const forbiddenSymbols = [
    ['archiveOldMemories', /\barchiveOldMemories\b/u],
    ['VectorIndexedMemoryStore', /\bVectorIndexedMemoryStore\b/u],
    ['parseArchiveFlags', /\bparseArchiveFlags\b/u],
    ['runArchive', /\brunArchive\b/u],
    ['distillDailyToMemory', /\bdistillDailyToMemory\b/u],
    ['markDistilled', /\bmarkDistilled\b/u],
  ]
  const matches = []
  for (const path of sourceFiles) {
    const content = await readText(path)
    for (const [name, pattern] of forbiddenSymbols) {
      if (pattern.test(content)) matches.push(`${displayPath(path)}:${name}`)
    }
  }

  const memoryCorePackage = await readJson(join(repoRoot, 'packages', 'memory-core', 'package.json'), 'memory-core package.json 可读')
  const memoryCoreDeps = {
    ...(memoryCorePackage?.dependencies ?? {}),
    ...(memoryCorePackage?.devDependencies ?? {}),
  }
  const forbiddenMemoryCoreDeps = ['@littlesheep/config', '@littlesheep/llm', '@littlesheep/vector']
    .filter((name) => Object.prototype.hasOwnProperty.call(memoryCoreDeps, name))

  const cliTsconfig = await readJson(join(repoRoot, 'packages', 'cli', 'tsconfig.json'), 'cli tsconfig 可读')
  const cliReferences = Array.isArray(cliTsconfig?.references) ? cliTsconfig.references : []
  const cliVectorReference = cliReferences.some((reference) => reference?.path === '../vector')

  assert(
    retiredFiles.length === 0 && matches.length === 0,
    'Memory v2 归档与向量写入入口已退役',
    [...retiredFiles, ...matches].join(', '),
  )
  assert(
    forbiddenMemoryCoreDeps.length === 0 && !cliVectorReference,
    '核心包不再依赖旧向量/归档实现',
    [...forbiddenMemoryCoreDeps.map((name) => `memory-core:${name}`), cliVectorReference ? 'cli:../vector' : ''].filter(Boolean).join(', '),
  )
}

function checkTrackedGeneratedFiles() {
  const generated = trackedFiles().filter((path) =>
    path.startsWith('packages/app/out/') ||
    /(^|\/)dist\//.test(path) ||
    /(^|\/)(coverage|release)\//.test(path) ||
    /\.tsbuildinfo$/i.test(path) ||
    /\.log$/i.test(path),
  )
  assert(generated.length === 0, 'Git 未跟踪生成物', generated.join(', '))
}

async function checkMarkdownLinks() {
  const actualDocs = (await collectMarkdownFiles(join(repoRoot, 'docs'))).map(displayPath)
  const markdownFiles = [...new Set([
    ...trackedFiles().filter((path) => extname(path).toLowerCase() === '.md' && existsSync(join(repoRoot, path))),
    ...actualDocs,
  ])]
    .map((path) => join(repoRoot, path))
  const broken = []
  const localLinkPattern = /\[[^\]]*\]\(([^)]+)\)/g

  for (const source of markdownFiles) {
    const content = await readText(source)
    for (const match of content.matchAll(localLinkPattern)) {
      let target = match[1].trim().replace(/^<|>$/g, '')
      if (!target || target.startsWith('#') || /^[a-z][a-z\d+.-]*:/i.test(target)) continue
      target = target.split('#', 1)[0].split('?', 1)[0]
      if (!target) continue
      try {
        target = decodeURIComponent(target)
      } catch {
        broken.push(`${displayPath(source)} -> ${target} (invalid encoding)`)
        continue
      }
      if (!existsSync(resolve(dirname(source), target))) {
        broken.push(`${displayPath(source)} -> ${target}`)
      }
    }
  }
  assert(broken.length === 0, 'Markdown 本地链接有效', broken.join(', '))
}

async function checkDocumentationLanguage() {
  const actualDocs = (await collectMarkdownFiles(join(repoRoot, 'docs'))).map(displayPath)
  const documentationFiles = [...new Set([
    ...trackedFiles().filter((path) => extname(path).toLowerCase() === '.md' && existsSync(join(repoRoot, path))),
    ...actualDocs,
  ])]
  const nonChinese = []
  for (const path of documentationFiles) {
    if (!/[\u4e00-\u9fff]/.test(await readText(join(repoRoot, path)))) nonChinese.push(path)
  }
  assert(nonChinese.length === 0, '说明文档以中文为主', nonChinese.join(', '))
}

async function main() {
  await checkPublishedSurface()
  await checkCanonicalFiles()
  await checkTaskbookNaming()
  await checkTaskbookBudget()
  await checkWorkspacePackages()
  await checkRepositoryNavigation()
  await checkModuleBoundaries()
  await checkExtensionArchitectureNames()
  await checkMemoryV3WriteBoundary()
  checkTrackedGeneratedFiles()
  await checkMarkdownLinks()
  await checkDocumentationLanguage()

  for (const item of passes) {
    console.log(`[pass] ${item.label}${item.detail ? `: ${item.detail}` : ''}`)
  }
  for (const item of failures) {
    console.error(`[fail] ${item.label}${item.detail ? `: ${item.detail}` : ''}`)
  }
  console.log(`\nRepository hygiene: ${failures.length === 0 ? 'ok' : 'failed'} (${passes.length} passed, ${failures.length} failed)`)
  process.exit(failures.length === 0 ? 0 : 1)
}

await main()
