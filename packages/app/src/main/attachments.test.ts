import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createDocument } from '@littlesheep/documents'
import { asSessionId, type RunCheckpoint } from '@littlesheep/types'
import { ManagedAttachmentCache } from './attachment-cache.js'
import {
  classifyAttachment,
  createInspectAttachmentTool,
  createCheckpointResourceResolver,
  parseAttachments,
  prepareRunAttachments,
} from './attachments.js'

function writeTextlessPdf(filePath: string): void {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> /Contents 4 0 R >>',
    '<< /Length 0 >>\nstream\n\nendstream',
  ]
  let content = '%PDF-1.4\n'
  const offsets = [0]
  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(content, 'ascii'))
    content += `${index + 1} 0 obj\n${body}\nendobj\n`
  })
  const xrefOffset = Buffer.byteLength(content, 'ascii')
  content += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  content += offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')
  content += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
  writeFileSync(filePath, content, 'ascii')
}

describe('main attachment helpers', () => {
  it('validates line comments and exposes the exact file location to the Agent', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ls-att-line-comment-'))
    try {
      const file = join(dir, 'source.ts')
      writeFileSync(file, 'const answer = 42\nexport { answer }\n', 'utf8')
      const refs = parseAttachments([{
        path: file,
        contextPath: file,
        name: 'source.ts',
        lineComments: [
          { startLine: 1, text: '  Explain why this value is fixed.  ' },
          { startLine: 2, endLine: 1, text: 'invalid range' },
          { startLine: 0, text: 'invalid line' },
        ],
      }])
      expect(refs[0]?.lineComments).toEqual([
        { startLine: 1, text: 'Explain why this value is fixed.' },
      ])

      const prepared = await prepareRunAttachments(refs, { workspaceDir: dir })
      expect(prepared[0]?.lineComments).toEqual(refs[0]?.lineComments)
      expect(prepared[0]?.contextPath).toBe('source.ts')
      const result = await createInspectAttachmentTool(prepared)!.execute(
        { attachment_id: prepared[0]!.id },
        { sessionId: asSessionId('session-1'), runId: 'run-1', cwd: dir },
      )
      expect(result.ok).toBe(true)
      expect(String(result.output)).toContain('Path: source.ts')
      expect(String(result.output)).toContain('Lines 1: Explain why this value is fixed.')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('keeps document content uninspected until the scoped tool reads it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ls-att-'))
    try {
      const file = join(dir, 'notes.md')
      writeFileSync(file, '# Notes\nhello from the file', 'utf8')
      const refs = parseAttachments([{ path: file, name: 'notes.md' }])
      const attachments = await prepareRunAttachments(refs)
      expect(attachments[0]?.extractedText).toBeUndefined()
      expect(attachments[0]).toMatchObject({ ownership: 'external', contentState: 'uninspected' })

      const tool = createInspectAttachmentTool(attachments)
      expect(tool?.name).toBe('inspect_attachment')
      const result = await tool!.execute(
        { attachment_id: attachments[0]!.id },
        { sessionId: asSessionId('session-1'), runId: 'run-1', cwd: dir },
      )
      expect(result.ok).toBe(true)
      expect(String(result.output)).toContain('hello from the file')
      expect(attachments[0]).toMatchObject({ contentState: 'loaded' })
      expect(attachments[0]?.extractedText).toContain('hello from the file')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('extracts workbook sheet text from xlsx attachments', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ls-att-xlsx-'))
    try {
      const file = join(dir, 'tasks.xlsx')
      await createDocument({
        filePath: file,
        format: 'xlsx',
        sheets: [{
          name: 'Plan',
          rows: [
            ['Task', 'Owner'],
            ['Ship parser', 'LittleSheep'],
          ],
        }],
      })

      const attachment = await classifyAttachment(file)
      const prepared = await prepareRunAttachments([attachment])
      expect(prepared[0]?.contentState).toBe('uninspected')
      const tool = createInspectAttachmentTool(prepared)!
      const result = await tool.execute(
        { attachment_id: prepared[0]!.id },
        { sessionId: asSessionId('session-1'), runId: 'run-1', cwd: dir },
      )
      expect(result.ok).toBe(true)
      expect(prepared[0]?.extractedText).toContain('Task\tOwner')
      expect(prepared[0]?.extractedText).toContain('Ship parser\tLittleSheep')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('extracts text and page metadata from PDF attachments', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ls-att-pdf-'))
    try {
      const file = join(dir, 'paper.pdf')
      await createDocument({
        filePath: file,
        format: 'pdf',
        title: '附件 PDF',
        blocks: [{ type: 'paragraph', text: 'LS 可以直接读取这份 PDF。' }],
      })
      const prepared = await prepareRunAttachments([await classifyAttachment(file)])
      expect(prepared[0]?.contentState).toBe('uninspected')
      const tool = createInspectAttachmentTool(prepared)!
      const result = await tool.execute(
        { attachment_id: prepared[0]!.id },
        { sessionId: asSessionId('session-1'), runId: 'run-1', cwd: dir },
      )
      expect(result.ok).toBe(true)
      expect(String(result.output)).toContain('LS 可以直接读取')
      expect(prepared[0]?.contentState).toBe('loaded')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reads a PDF attachment in page ranges without poisoning its default cache', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ls-att-paged-pdf-'))
    try {
      const file = join(dir, 'paged.pdf')
      await createDocument({
        filePath: file,
        format: 'pdf',
        blocks: [
          { type: 'paragraph', text: 'FIRST_PAGE_ONLY' },
          { type: 'page_break' },
          { type: 'paragraph', text: 'SECOND_PAGE_ONLY' },
        ],
      })
      const prepared = await prepareRunAttachments([await classifyAttachment(file)])
      const tool = createInspectAttachmentTool(prepared)!
      const page = await tool.execute(
        { attachment_id: prepared[0]!.id, page_start: 2, page_end: 2 },
        { sessionId: asSessionId('session-1'), runId: 'run-1', cwd: dir },
      )

      expect(page.ok).toBe(true)
      expect(String(page.output)).toContain('SECOND_PAGE_ONLY')
      expect(String(page.output)).not.toContain('FIRST_PAGE_ONLY')
      expect(String(page.output)).toContain('总页数：2')
      expect(prepared[0]?.contentState).toBe('uninspected')

      const full = await tool.execute(
        { attachment_id: prepared[0]!.id },
        { sessionId: asSessionId('session-1'), runId: 'run-1', cwd: dir },
      )
      expect(full.ok).toBe(true)
      expect(String(full.output)).toContain('FIRST_PAGE_ONLY')
      expect(String(full.output)).toContain('SECOND_PAGE_ONLY')
      expect(prepared[0]?.contentState).toBe('loaded')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reports a textless PDF as unavailable instead of completing the read step', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ls-att-empty-pdf-'))
    try {
      const file = join(dir, 'scan.pdf')
      writeTextlessPdf(file)
      const prepared = await prepareRunAttachments([await classifyAttachment(file)])
      const result = await createInspectAttachmentTool(prepared)!.execute(
        { attachment_id: prepared[0]!.id },
        { sessionId: asSessionId('session-1'), runId: 'run-1', cwd: dir },
      )

      expect(result.ok).toBe(false)
      expect(result.error).toMatch(/OCR|no readable text/u)
      expect(result.meta).toMatchObject({ contentState: 'unavailable', contentAvailable: false })
      expect(prepared[0]?.contentState).toBe('unavailable')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('returns the legacy Office conversion requirement as a tool failure', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ls-att-legacy-office-'))
    try {
      const file = join(dir, 'legacy.doc')
      writeFileSync(file, 'not an OOXML document', 'utf8')
      const prepared = await prepareRunAttachments([await classifyAttachment(file)])
      const result = await createInspectAttachmentTool(prepared)!.execute(
        { attachment_id: prepared[0]!.id },
        { sessionId: asSessionId('session-1'), runId: 'run-1', cwd: dir },
      )

      expect(result.ok).toBe(false)
      expect(result.error).toMatch(/DOCX.*PPTX/u)
      expect(result.meta).toMatchObject({ contentState: 'unavailable', contentAvailable: false })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('classifies selected files by the workspace boundary without trusting client ownership', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ls-att-ownership-'))
    try {
      const workplace = join(dir, 'workplace')
      const project = join(dir, 'project')
      const external = join(dir, 'external.txt')
      const workplaceFile = join(workplace, 'user-note.txt')
      const projectFile = join(project, 'spec.md')
      mkdirSync(workplace, { recursive: true })
      mkdirSync(project, { recursive: true })
      writeFileSync(workplaceFile, 'workplace', { encoding: 'utf8', flag: 'w' })
      writeFileSync(projectFile, 'project', { encoding: 'utf8', flag: 'w' })
      writeFileSync(external, 'external', 'utf8')

      const prepared = await prepareRunAttachments([
        { path: workplaceFile, ownership: 'cache' },
        { path: projectFile },
        { path: external },
      ], {
        workplaceDir: workplace,
        workspaceDir: project,
        projectId: 'project-1',
      })

      expect(prepared.map((item) => item.ownership)).toEqual([
        'user_workplace',
        'project',
        'external',
      ])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('restores a checkpoint attachment by cache id and digest and rebuilds its trusted inspection tool', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ls-att-restore-'))
    try {
      const cache = new ManagedAttachmentCache({ rootDir: join(dir, 'attachment-cache') })
      await cache.initialize()
      const ref = await cache.importData({
        name: 'source.md',
        dataUrl: `data:text/markdown;base64,${Buffer.from('original checkpoint content').toString('base64')}`,
      })
      const original = (await prepareRunAttachments([ref], { managedCache: cache }))[0]!
      const checkpoint: RunCheckpoint = {
        version: 1,
        id: 'attachment-checkpoint',
        runId: 'attachment-source-run',
        sessionId: asSessionId('attachment-session'),
        status: 'waiting_user',
        currentStage: 'finalize',
        taskBookRevision: 1,
        eventCursor: 0,
        pendingEventIds: [],
        contextSnapshotIds: [],
        sideEffects: [],
        loopBudget: {
          attemptsUsed: 1,
          maxAttempts: 8,
          elapsedMs: 10,
          maxElapsedMs: 60_000,
          noProgressRounds: 0,
          maxNoProgressRounds: 2,
        },
        resumeState: {
          version: 1,
          inboundMessageId: 'attachment-inbound',
          cwd: dir,
          model: 'test/model',
          origin: 'app',
          permissionPolicyId: 'research',
          reasoning: 'auto',
          behaviorModeId: 'general',
          availableToolNames: ['inspect_attachment'],
          attachmentCount: 1,
          attachments: [{
            version: 1,
            attachmentId: original.id!,
            cacheId: original.cacheId!,
            contentHash: original.contentHash!,
            name: original.name!,
            kind: original.kind,
            mimeType: original.mimeType,
            size: original.size,
          }],
          toolRecipes: [{ version: 1, factory: 'inspect_attachment' }],
          continuation: {
            version: 1,
            requestId: 'attachment-question',
            sourceStage: 'recover',
          },
          appliedTaskBookPatchIds: [],
          deferredRuntimeEvents: [],
          recoveryAttempts: 1,
          replanAttempts: 0,
          maxReplanAttempts: 2,
          verificationHistory: [],
        },
        createdAt: new Date().toISOString(),
        reason: 'waiting for the attachment tool',
      }
      const restore = createCheckpointResourceResolver({ managedCache: cache })
      const restored = await restore(checkpoint, {})
      expect(restored.attachments?.[0]).toMatchObject({
        id: original.id,
        cacheId: original.cacheId,
        contentHash: original.contentHash,
      })
      expect(restored.additionalTools?.map((tool) => tool.name)).toEqual(['inspect_attachment'])
      const inspected = await restored.additionalTools![0]!.execute(
        { attachment_id: original.id },
        { sessionId: checkpoint.sessionId, runId: 'resume-run', cwd: dir },
      )
      expect(inspected.ok).toBe(true)
      expect(String(inspected.output)).toContain('original checkpoint content')

      writeFileSync(original.path, 'tampered checkpoint content', 'utf8')
      await expect(restore(checkpoint, {})).rejects.toThrow('受管附件已失效')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
