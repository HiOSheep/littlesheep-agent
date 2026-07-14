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
  const unlistedDocs = tracked
    .filter((path) => /^docs\/[^/]+\.md$/i.test(path))
    .filter((path) => !readme.includes(path))
  assert(unlistedDocs.length === 0, '正式文档均可从 README 定位', unlistedDocs.join(', '))

  const publicTextExtensions = new Set([
    '.bat', '.cjs', '.css', '.html', '.js', '.json', '.jsx', '.md', '.mjs',
    '.ps1', '.ts', '.tsx', '.yaml', '.yml',
  ])
  const textFiles = tracked.filter((path) =>
    path !== 'pnpm-lock.yaml' && publicTextExtensions.has(extname(path).toLowerCase()) && existsSync(join(repoRoot, path)),
  )
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
    'docs/core-agent-capability-taskbook.md',
    'docs/extension-workspace-taskbook.md',
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
  const markdownFiles = trackedFiles()
    .filter((path) => extname(path).toLowerCase() === '.md' && existsSync(join(repoRoot, path)))
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
  const documentationFiles = trackedFiles()
    .filter((path) => extname(path).toLowerCase() === '.md' && existsSync(join(repoRoot, path)))
  const nonChinese = []
  for (const path of documentationFiles) {
    if (!/[\u4e00-\u9fff]/.test(await readText(join(repoRoot, path)))) nonChinese.push(path)
  }
  assert(nonChinese.length === 0, '说明文档以中文为主', nonChinese.join(', '))
}

async function main() {
  await checkPublishedSurface()
  await checkCanonicalFiles()
  await checkWorkspacePackages()
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
