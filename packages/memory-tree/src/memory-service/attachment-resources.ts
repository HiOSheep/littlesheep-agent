// Keeps attachment bodies run-scoped while registering only bounded metadata.

import { basename } from 'node:path';
import type { RunAttachment, SessionId } from '@littlesheep/types';
import { InjectionTier } from '../types.js';
import type { MemoryResourceRegistration } from '../types.js';
import type { MemoryRepository } from '../memory-repository.js';
import { attachmentManifestResourceId, attachmentResourceId } from './resource-identifiers.js';

export class AttachmentResourceCoordinator {
  private readonly active = new Map<string, Map<string, RunAttachment>>();

  constructor(private readonly repository: MemoryRepository) {}

  clearRun(runId: string): void {
    this.active.delete(runId);
  }

  async register(runId: string, sessionId: SessionId, attachments: RunAttachment[]): Promise<void> {
    const now = new Date().toISOString();
    const group = `session-attachments:${sessionId}`;
    const resources: MemoryResourceRegistration[] = [];
    const active = new Map<string, RunAttachment>();

    if (attachments.length > 0) {
      resources.push({
        version: 1,
        id: attachmentManifestResourceId(runId),
        kind: 'attachment-manifest',
        title: '本轮附件清单',
        description: `本轮共有 ${attachments.length} 个附件；清单不包含文件正文。`,
        tier: InjectionTier.T1_ESSENTIAL,
        scope: 'run',
        scopeKey: runId,
        authority: 'external',
        privacy: 'private',
        source: { kind: 'attachment', id: attachmentManifestResourceId(runId) },
        indexKeys: ['attachment manifest', '附件清单', runId],
        status: 'active',
        registryGroup: group,
        registeredAt: now,
        updatedAt: now,
        metadata: { runId, sessionId: String(sessionId), attachmentCount: attachments.length },
      });
    }

    attachments.forEach((attachment, index) => {
      const attachmentId = attachment.id ?? `attachment-${index + 1}`;
      const resourceId = attachmentResourceId(runId, attachmentId);
      active.set(resourceId, { ...attachment, id: attachmentId, dataUrl: undefined });
      resources.push({
        version: 1,
        id: resourceId,
        kind: 'attachment',
        title: attachment.name ?? basename(attachment.path),
        description: '用户为本轮任务提供的附件；正文仅在任务确有需要时通过专用读取路径解析。',
        tier: InjectionTier.T2_RELEVANT,
        scope: 'run',
        scopeKey: runId,
        authority: 'external',
        privacy: attachment.ownership === 'project' ? 'project-private' : 'private',
        source: { kind: 'attachment', id: attachmentId, path: attachment.path },
        indexKeys: [attachmentId, attachment.name ?? basename(attachment.path), attachment.kind, attachment.mimeType ?? ''],
        status: 'active',
        registryGroup: group,
        registeredAt: now,
        updatedAt: now,
        metadata: {
          runId,
          sessionId: String(sessionId),
          attachmentId,
          kind: attachment.kind,
          mimeType: attachment.mimeType,
          size: attachment.size,
          contentHash: attachment.contentHash,
          ownership: attachment.ownership ?? 'external',
          contentState: attachment.contentState ?? 'uninspected',
          extractionNote: attachment.extractionNote,
        },
      });
    });

    if (active.size > 0) this.active.set(runId, active);
    else this.active.delete(runId);
    await this.repository.replaceResourceGroup(group, resources, { staleMode: 'remove' });
  }

  resolve(
    resource: MemoryResourceRegistration,
    runId: string,
  ): { content: string; source: string } | undefined {
    if (resource.source.kind !== 'attachment') return undefined;
    const attachments = this.active.get(runId);
    if (!attachments) return undefined;
    if (resource.kind === 'attachment-manifest') {
      const entries = [...attachments.values()];
      return {
        content: [
          'Attached files manifest (file bodies are not included):',
          ...entries.map((attachment) => (
            `- [${attachment.id}] ${attachment.name ?? attachment.path} (${attachment.kind}, ${attachment.size ?? 'unknown'} bytes, ${attachment.contentState ?? 'uninspected'})`
          )),
          'Use the run-scoped inspect_attachment tool when a non-image body is required.',
        ].join('\n'),
        source: `run:${runId}#attachments`,
      };
    }
    const attachment = attachments.get(resource.id);
    if (!attachment) return undefined;
    const content = attachment.extractedText?.trim()
      ? attachment.extractedText
      : [
          `Attachment: ${attachment.name ?? attachment.path}`,
          `Kind: ${attachment.kind}; content state: ${attachment.contentState ?? 'uninspected'}.`,
          attachment.kind === 'image'
            ? 'Image bytes are handled by the model input path and are not duplicated into the memory registry.'
            : `Use inspect_attachment with attachment_id=${attachment.id} to parse the body only when needed.`,
          attachment.extractionNote ?? '',
        ].filter(Boolean).join('\n');
    return { content, source: attachment.path };
  }
}
