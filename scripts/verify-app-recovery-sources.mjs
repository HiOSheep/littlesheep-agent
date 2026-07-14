#!/usr/bin/env node
// Read-only sanity check for LittleSheep desktop recovery sources.

import { existsSync } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const dataDir = resolve(process.env.LITTLESHEEP_DATA_DIR || join(homedir(), '.littlesheep'))
const result = {
  dataDir,
  ok: true,
  checks: [],
}

function pass(name, detail = '') {
  result.checks.push({ status: 'pass', name, detail })
}

function warn(name, detail = '') {
  result.checks.push({ status: 'warn', name, detail })
}

function fail(name, detail = '') {
  result.ok = false
  result.checks.push({ status: 'fail', name, detail })
}

async function readJsonIfExists(path, label, required = true) {
  if (!existsSync(path)) {
    if (required) fail(label, `missing: ${path}`)
    else warn(label, `missing optional file: ${path}`)
    return null
  }
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (err) {
    fail(label, `invalid JSON: ${err.message}`)
    return null
  }
}

async function main() {
  if (!existsSync(dataDir)) {
    fail('user data root', `missing: ${dataDir}`)
    printAndExit()
  }

  pass('user data root', dataDir)

  const config = await readJsonIfExists(join(dataDir, 'config.json'), 'config.json')
  const workspace = config?.agents?.defaults?.workspace
  if (typeof workspace === 'string' && workspace.trim()) {
    pass('runtime workspace in config', workspace)
    if (existsSync(workspace)) {
      const workspaceStat = await stat(workspace).catch(() => null)
      if (workspaceStat?.isDirectory()) pass('runtime workspace directory exists', workspace)
      else warn('runtime workspace path exists but is not a directory', workspace)
    } else {
      warn('runtime workspace directory missing', workspace)
    }
  } else {
    fail('runtime workspace in config', 'agents.defaults.workspace is missing or empty')
  }

  const projects = await readJsonIfExists(join(dataDir, 'projects', 'index.json'), 'projects/index.json', false)
  const projectItems = Array.isArray(projects?.projects) ? projects.projects : []
  pass('project index readable', `${projectItems.length} project(s)`)
  const workplace = join(dataDir, 'workplace')
  const workplaceProject = projectItems.find((project) => samePath(project.path, workplace))
  if (workplaceProject) warn('default workplace is incorrectly indexed as a project', workplaceProject.id)
  else pass('default workplace is not a project', workplace)

  const duplicateProjectPaths = duplicateNormalizedPaths(projectItems)
  if (duplicateProjectPaths.length > 0) fail('project paths are unique', duplicateProjectPaths.join(', '))
  else pass('project paths are unique')

  const projectRebindJournalPath = join(dataDir, 'projects', 'rebind-operation.json')
  if (!existsSync(projectRebindJournalPath)) {
    pass('no pending project path rebind')
  } else {
    const journal = await readJsonIfExists(projectRebindJournalPath, 'project rebind journal')
    const validJournal = journal?.version === 1
      && typeof journal.operationId === 'string'
      && typeof journal.projectBefore?.id === 'string'
      && journal.projectBefore.id === journal.projectAfter?.id
      && typeof journal.projectBefore?.path === 'string'
      && typeof journal.projectAfter?.path === 'string'
      && Array.isArray(journal.completedSteps)
    if (validJournal) {
      warn(
        'pending project path rebind',
        `${journal.projectBefore.id}: ${journal.projectBefore.path} -> ${journal.projectAfter.path}; completed=${journal.completedSteps.length}`,
      )
    } else {
      fail('project rebind journal', 'journal shape is invalid')
    }
  }

  const sessionIndex = await readJsonIfExists(join(dataDir, 'sessions.json'), 'sessions.json', false)
  const sessionItems = Array.isArray(sessionIndex?.sessions) ? sessionIndex.sessions : []
  pass('session index readable', `${sessionItems.length} session(s)`)
  const activeProjectIds = new Set(projectItems.map((project) => project.id).filter(Boolean))
  const legacySessions = sessionItems.filter((session) => session?.scope !== 'standalone' && session?.scope !== 'project')
  const invalidStandalone = sessionItems.filter((session) => session?.scope === 'standalone' && session?.projectId)
  const orphanProjectSessions = sessionItems.filter((session) =>
    session?.scope === 'project' && (!session?.projectId || !activeProjectIds.has(session.projectId)),
  )
  if (legacySessions.length > 0) warn('sessions awaiting ownership migration', `${legacySessions.length} session(s)`)
  else pass('all sessions have explicit ownership')
  if (invalidStandalone.length > 0) fail('standalone sessions have no project ownership', invalidStandalone.map((session) => session.id).join(', '))
  else pass('standalone sessions have no project ownership')
  if (orphanProjectSessions.length > 0) fail('project sessions reference active projects', orphanProjectSessions.map((session) => session.id).join(', '))
  else pass('project sessions reference active projects')

  const sessionDir = join(dataDir, 'sessions')
  const sessionFiles = existsSync(sessionDir)
    ? (await readdir(sessionDir)).filter((name) => name.endsWith('.jsonl'))
    : []
  pass('session jsonl directory readable', `${sessionFiles.length} file(s)`)

  const indexedSessionIds = new Set(sessionItems.map((session) => session.id).filter(Boolean))
  const missingJsonl = [...indexedSessionIds].filter((id) => !existsSync(join(sessionDir, `${id}.jsonl`)))
  if (missingJsonl.length > 0) warn('indexed sessions missing jsonl files', missingJsonl.slice(0, 5).join(', '))
  else pass('indexed sessions have jsonl files')

  const executionDir = join(dataDir, 'execution-logs')
  const executionFiles = existsSync(executionDir)
    ? new Set((await readdir(executionDir)).filter((name) => name.endsWith('.json')).map((name) => name.replace(/\.json$/, '')))
    : new Set()
  pass('execution log directory readable', `${executionFiles.size} log(s)`)

  const sampledRunIds = await sampleRunIdsFromSessions(sessionDir, sessionFiles.slice(0, 20))
  const missingRunLogs = sampledRunIds.filter((runId) => !executionFiles.has(runId))
  if (sampledRunIds.length === 0) warn('session runId sampling', 'no runId found in sampled sessions')
  else if (missingRunLogs.length > 0) warn('sampled runIds missing execution logs', missingRunLogs.slice(0, 5).join(', '))
  else pass('sampled runIds have execution logs', `${sampledRunIds.length} runId(s)`)

  const artifactIndex = await readJsonIfExists(join(dataDir, 'workspace', 'artifacts.json'), 'workspace/artifacts.json', false)
  const artifactItems = Array.isArray(artifactIndex?.records) ? artifactIndex.records : []
  if (artifactIndex) pass('workspace artifact index readable', `${artifactItems.length} artifact(s)`)

  const resourceIndexDir = join(dataDir, 'workspace', 'resource-indexes')
  if (!existsSync(resourceIndexDir)) {
    warn('workspace resource indexes', `missing optional directory: ${resourceIndexDir}`)
  } else {
    const resourceIndexFiles = (await readdir(resourceIndexDir)).filter((name) => /^[a-f0-9]{24}\.json$/.test(name)).slice(0, 64)
    let scanning = 0
    let indexedFiles = 0
    for (const fileName of resourceIndexFiles) {
      const document = await readJsonIfExists(join(resourceIndexDir, fileName), `workspace resource index ${fileName}`)
      if (!document) continue
      const files = Array.isArray(document.files) ? document.files : null
      const queue = Array.isArray(document.scan?.queue) ? document.scan.queue : null
      const valid = document.version === 1
        && typeof document.identity === 'string'
        && typeof document.workspacePath === 'string'
        && files !== null
        && files.length <= 1024
        && queue !== null
        && queue.length <= 512
        && files.every((file) => isSafeWorkspaceIndexFile(file))
      if (!valid) {
        fail(`workspace resource index ${fileName}`, 'index shape or safety bounds are invalid')
        continue
      }
      indexedFiles += files.length
      if (document.scan?.status === 'scanning') scanning += 1
    }
    pass('workspace resource indexes readable', `${resourceIndexFiles.length} index(es), ${indexedFiles} file(s), ${scanning} scanning`)
  }

  const terminalIndex = await readJsonIfExists(join(dataDir, 'workspace', 'terminal-activity.json'), 'workspace/terminal-activity.json', false)
  const terminalItems = Array.isArray(terminalIndex?.records) ? terminalIndex.records : []
  if (terminalIndex) pass('terminal activity index readable', `${terminalItems.length} command(s)`)

  const layoutSnapshot = await readJsonIfExists(join(dataDir, 'workspace', 'layout.json'), 'workspace/layout.json', false)
  if (layoutSnapshot) {
    if (layoutSnapshot.version === 1 && typeof layoutSnapshot.workspacePath === 'string' && Array.isArray(layoutSnapshot.openTabs)) {
      pass('workspace layout snapshot readable', `${layoutSnapshot.openTabs.length} tab(s), active=${layoutSnapshot.activeTab ?? 'unknown'}`)
      if (workspace && layoutSnapshot.workspacePath && !samePath(layoutSnapshot.workspacePath, workspace)) {
        warn('workspace layout snapshot uses a non-default root', layoutSnapshot.workspacePath)
      }
    } else {
      fail('workspace layout snapshot readable', 'layout snapshot shape is invalid')
    }
  }

  printAndExit()
}

async function sampleRunIdsFromSessions(sessionDir, sessionFiles) {
  const runIds = new Set()
  for (const fileName of sessionFiles) {
    const path = join(sessionDir, fileName)
    const content = await readFile(path, 'utf8').catch(() => '')
    for (const line of content.split(/\r?\n/)) {
      if (!line.trim()) continue
      try {
        const item = JSON.parse(line)
        if (typeof item.runId === 'string' && item.runId) runIds.add(item.runId)
      } catch {
        // A malformed line should not stop the recovery-source check.
      }
      if (runIds.size >= 20) return [...runIds]
    }
  }
  return [...runIds]
}

function samePath(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false
  return resolve(left).replace(/[\\/]+$/, '').toLowerCase() ===
    resolve(right).replace(/[\\/]+$/, '').toLowerCase()
}

function duplicateNormalizedPaths(items) {
  const seen = new Set()
  const duplicates = new Set()
  for (const item of items) {
    if (typeof item?.path !== 'string') continue
    const normalized = resolve(item.path).replace(/[\\/]+$/, '').toLowerCase()
    if (seen.has(normalized)) duplicates.add(normalized)
    seen.add(normalized)
  }
  return [...duplicates]
}

function isSafeWorkspaceIndexFile(file) {
  if (!file || typeof file !== 'object' || typeof file.relativePath !== 'string') return false
  const path = file.relativePath.replace(/\\/g, '/')
  if (!path || path.startsWith('/') || path.startsWith('../') || /^[A-Za-z]:/.test(path)) return false
  if (typeof file.size !== 'number' || file.size < 0 || typeof file.mtimeMs !== 'number' || file.mtimeMs < 0) return false
  if (Object.hasOwn(file, 'content') || Object.hasOwn(file, 'body') || Object.hasOwn(file, 'dataUrl')) return false
  return true
}

function printAndExit() {
  const lines = [
    `LittleSheep recovery sources: ${result.ok ? 'ok' : 'failed'}`,
    `Data dir: ${result.dataDir}`,
    '',
    ...result.checks.map((check) => {
      const marker = check.status === 'pass' ? '[pass]' : check.status === 'warn' ? '[warn]' : '[fail]'
      return `${marker} ${check.name}${check.detail ? ` — ${check.detail}` : ''}`
    }),
  ]
  console.log(lines.join('\n'))
  process.exit(result.ok ? 0 : 1)
}

await main()
