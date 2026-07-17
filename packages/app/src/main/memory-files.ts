// User-facing memory document projection. Internal atoms never cross this boundary.

import { existsSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { atomicWrite } from '@littlesheep/memory-core'
import type {
  MemoryFileDetail,
  MemoryFileName,
  MemoryFileOverview,
} from '../shared/memory-control-contracts.js'

const MAX_MEMORY_FILE_BYTES = 512 * 1024

const MEMORY_FILES: ReadonlyArray<{
  name: MemoryFileName
  description: string
  editable: boolean
}> = [
  { name: 'AGENTS.md', description: 'LS 的操作规则与行为边界', editable: false },
  { name: 'SOUL.md', description: 'LS 的人格、语气与身份偏好', editable: true },
  { name: 'USER.md', description: '经确认的用户偏好与长期约束', editable: false },
  { name: 'PHILOSOPHY.md', description: '长期价值判断与共同工作理念', editable: false },
  { name: 'TOOLS.md', description: '工具使用约定与已验证经验', editable: false },
  { name: 'MEMORY.md', description: '兼容旧数据的长期记忆文件', editable: false },
]

const MEMORY_FILE_NAMES = new Set<MemoryFileName>(MEMORY_FILES.map((file) => file.name))

export async function listUserMemoryFiles(dataDir: string): Promise<MemoryFileOverview[]> {
  return Promise.all(MEMORY_FILES.map(async (file) => {
    const path = join(dataDir, file.name)
    try {
      const info = await stat(path)
      return {
        ...file,
        exists: info.isFile(),
        size: info.isFile() ? info.size : 0,
        updatedAt: info.isFile() ? info.mtime.toISOString() : undefined,
      }
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error
      return { ...file, exists: false, size: 0 }
    }
  }))
}

export async function readUserMemoryFile(dataDir: string, name: string): Promise<MemoryFileDetail | undefined> {
  if (!isMemoryFileName(name)) return undefined
  const overview = (await listUserMemoryFiles(dataDir)).find((file) => file.name === name)!
  const path = join(dataDir, name)
  if (!overview.exists || !existsSync(path)) return { ...overview, content: '' }
  if (overview.size > MAX_MEMORY_FILE_BYTES) {
    throw new Error(`记忆文件超过 ${MAX_MEMORY_FILE_BYTES} 字节的读取上限。`)
  }
  return { ...overview, content: await readFile(path, 'utf8') }
}

export async function writeUserMemoryFile(
  dataDir: string,
  name: string,
  content: string,
): Promise<MemoryFileDetail | undefined> {
  if (!isMemoryFileName(name)) return undefined
  if (name !== 'SOUL.md') throw new Error('当前前端只允许编辑 SOUL.md。')
  const bytes = Buffer.byteLength(content, 'utf8')
  if (bytes > MAX_MEMORY_FILE_BYTES) {
    throw new Error(`SOUL.md 不能超过 ${MAX_MEMORY_FILE_BYTES} 字节。`)
  }
  await atomicWrite(join(dataDir, name), content)
  return readUserMemoryFile(dataDir, name)
}

function isMemoryFileName(value: string): value is MemoryFileName {
  return MEMORY_FILE_NAMES.has(value as MemoryFileName)
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined
}
