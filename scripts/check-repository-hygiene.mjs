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

async function collectPackageDirectories() {
  const packageDirs = []
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
  const actualDocs = (await readdir(join(repoRoot, 'docs'), { withFileTypes: true }))
    .filter((entry) => entry.isFile() && extname(entry.name).toLowerCase() === '.md')
    .map((entry) => `docs/${entry.name}`)
  const unlistedDocs = actualDocs.filter((path) => !readme.includes(path))
  assert(unlistedDocs.length === 0, '正式文档均可从 README 定位', unlistedDocs.join(', '))

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
    'docs/architecture-principles.md',
    'docs/architecture-decision-report.md',
    'docs/project-status.md',
    'docs/repository-guide.md',
    'docs/plugin-development.md',
    'docs/foundation-cognition-repository-taskbook-2026-07-15.md',
    'docs/core-agent-capability-taskbook-2026-07-13.md',
    'docs/agent-core-memory-taskbook-2026-07-14.md',
    'docs/core-focus-maintenance-taskbook-2026-07-13.md',
    'docs/extension-workspace-taskbook-2026-07-12.md',
    'docs/agent-runtime-continuity-taskbook-2026-07-14.md',
    'scripts/build-app.ps1',
    'scripts/start-littlesheep.ps1',
    'scripts/refresh-desktop-shortcut.ps1',
    'scripts/verify-app-recovery-sources.mjs',
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

async function checkTaskbookNaming() {
  const entries = await readdir(join(repoRoot, 'docs'), { withFileTypes: true })
  const taskbooks = entries
    .filter((entry) => entry.isFile() && entry.name.includes('taskbook') && entry.name.endsWith('.md'))
    .map((entry) => entry.name)
  const violations = []
  for (const name of taskbooks) {
    const match = name.match(/-taskbook-(\d{4}-\d{2}-\d{2})\.md$/u)
    if (!match) {
      violations.push(`${name}: 文件名缺少最后更新时间`)
      continue
    }
    const date = match[1]
    const content = await readText(join(repoRoot, 'docs', name))
    const title = content.split(/\r?\n/u, 1)[0]?.trim() ?? ''
    const updated = content.match(/^最后更新：(\d{4}-\d{2}-\d{2})$/mu)?.[1]
    if (!title.endsWith(date)) violations.push(`${name}: 一级标题日期应为 ${date}`)
    if (updated !== date) violations.push(`${name}: 最后更新时间应为 ${date}`)
  }
  assert(taskbooks.length > 0 && violations.length === 0, '任务书名称与最后更新时间一致', violations.join(', '))
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
  assert(
    rootManifest?.scripts?.['check:repo'] === 'node scripts/check-repository-hygiene.mjs',
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
    'packages/harness/src/stages/decide',
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
    'packages/app/src/renderer/App.tsx': 7,
    'packages/app/src/renderer/app-shell/use-app-controller.ts': 576,
    'packages/app/src/renderer/chat/run-actions.ts': 308,
    'packages/app/src/renderer/settings/plugins.tsx': 394,
    'packages/app/src/renderer/ui/icons.tsx': 333,
    'packages/app/src/renderer/workspace/file-navigator.tsx': 457,
    'packages/app/src/renderer/workspace/files.tsx': 400,
    'packages/app/src/renderer/workspace/panel.tsx': 368,
    'packages/app/src/renderer/workspace/preview-pane.tsx': 446,
    'packages/app/src/renderer/workspace/terminal.tsx': 556,
    'packages/app/src/renderer/workspace/use-workspace-layout-controller.ts': 380,
    'packages/app/src/main/local-app-api-server.ts': 241,
    'packages/app/src/renderer/api.ts': 21,
    'packages/memory-tree/src/memory-repository.ts': 171,
    'packages/memory-tree/src/memory-service.ts': 343,
    'packages/context/src/engine.ts': 180,
    'packages/harness/src/stages/decide.ts': 169,
    'packages/harness/src/stages/execute.ts': 46,
    'packages/harness/src/stages/verify.ts': 145,
    'packages/app/src/renderer/MemoryTreeView.tsx': 1104,
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

  const splitMap = await readText(join(repoRoot, 'docs', 'module-split-map.md'))
  const missingFromSplitMap = largeFiles
    .map((entry) => entry.path)
    .filter((path) => !splitMap.includes(`\`${path}\``))
  assert(missingFromSplitMap.length === 0, '300 行以上生产文件已登记', missingFromSplitMap.join(', '))

  const controlled = new Map()
  const controlledPattern = /^\| `([^`]+)` \| ([^|]+) \| ([^|]+) \| (\d+) \| (\d{4}-\d{2}-\d{2}) \|$/gmu
  for (const match of splitMap.matchAll(controlledPattern)) {
    controlled.set(match[1], {
      owner: match[2].trim(),
      reason: match[3].trim(),
      ceiling: Number(match[4]),
      reviewAt: match[5],
    })
  }
  const hardLimitFiles = largeFiles.filter((entry) => entry.lines > 600)
  const controlledViolations = []
  const today = new Date().toISOString().slice(0, 10)
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
    if (exception.reviewAt < today) controlledViolations.push(`${entry.path}: 复查日期已过 ${exception.reviewAt}`)
  }
  for (const path of controlled.keys()) {
    if (!hardLimitFiles.some((entry) => entry.path === path)) controlledViolations.push(`${path}: 已不超过 600 行，应移除登记`)
  }
  assert(controlledViolations.length === 0, '600 行以上生产文件受控', controlledViolations.join(', '))
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
    ['TaskBook', 'packages/types/src/agent.ts'],
    ['VerificationRecord', 'packages/types/src/agent.ts'],
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
  const actualDocs = (await readdir(join(repoRoot, 'docs'), { withFileTypes: true }))
    .filter((entry) => entry.isFile() && extname(entry.name).toLowerCase() === '.md')
    .map((entry) => `docs/${entry.name}`)
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
  const actualDocs = (await readdir(join(repoRoot, 'docs'), { withFileTypes: true }))
    .filter((entry) => entry.isFile() && extname(entry.name).toLowerCase() === '.md')
    .map((entry) => `docs/${entry.name}`)
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
  await checkWorkspacePackages()
  await checkRepositoryNavigation()
  await checkModuleBoundaries()
  await checkExtensionArchitectureNames()
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
