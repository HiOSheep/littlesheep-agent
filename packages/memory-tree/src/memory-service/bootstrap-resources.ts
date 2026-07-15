// Registers identity and operating documents without preloading non-prompt bodies.

import { readFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { InjectionTier } from '../types.js';
import type { MemoryResourceKind, MemoryResourceRegistration } from '../types.js';
import type { MemoryRepository } from '../memory-repository.js';
import {
  contentHash,
  fileResourceId,
  hashId,
  normalizedPath,
} from './resource-identifiers.js';

const BOOTSTRAP_FILES = ['AGENTS.md', 'SOUL.md', 'USER.md', 'PHILOSOPHY.md', 'TOOLS.md', 'MEMORY.md'] as const;
const PROMPT_BOOTSTRAP_FILES = new Set<string>(['AGENTS.md', 'SOUL.md', 'USER.md', 'TOOLS.md']);

const BOOTSTRAP_KINDS: Record<(typeof BOOTSTRAP_FILES)[number], MemoryResourceKind> = {
  'AGENTS.md': 'agent-instructions',
  'SOUL.md': 'persona',
  'USER.md': 'user-profile',
  'PHILOSOPHY.md': 'philosophy',
  'TOOLS.md': 'tool-guidance',
  'MEMORY.md': 'legacy-memory',
};

const BOOTSTRAP_DESCRIPTIONS: Record<(typeof BOOTSTRAP_FILES)[number], string> = {
  'AGENTS.md': 'LS 的操作规则、行为边界和工程约定。',
  'SOUL.md': 'LS 的稳定人格、语气和身份偏好。',
  'USER.md': '经过确认的用户偏好、习惯和长期约束。',
  'PHILOSOPHY.md': '经用户确认的长期价值判断、设计取舍和共同工作理念；仅按任务相关性读取。',
  'TOOLS.md': '工具使用约定、风险和已验证经验。',
  'MEMORY.md': '兼容旧数据的长期记忆来源；新写入仍以结构化记忆树为准。',
};

export class BootstrapResourceCoordinator {
  private readonly dataDir: string;

  constructor(
    private readonly repository: MemoryRepository,
    dataDir: string,
  ) {
    this.dataDir = resolve(dataDir);
  }

  async load(dir: string): Promise<Record<string, string>> {
    const root = resolve(dir);
    const isGlobal = normalizedPath(root) === normalizedPath(this.dataDir);
    const now = new Date().toISOString();
    const resources: MemoryResourceRegistration[] = [];
    const output: Record<string, string> = {};

    for (const fileName of BOOTSTRAP_FILES) {
      const path = join(root, fileName);
      let content: string | undefined;
      try {
        content = await readFile(path, 'utf8');
      } catch {
        content = undefined;
      }
      const kind = BOOTSTRAP_KINDS[fileName];
      const tier = isGlobal && (fileName === 'AGENTS.md' || fileName === 'SOUL.md')
        ? InjectionTier.T0_CORE
        : isGlobal
          ? InjectionTier.T1_ESSENTIAL
          : fileName === 'AGENTS.md'
            ? InjectionTier.T1_ESSENTIAL
            : InjectionTier.T2_RELEVANT;
      resources.push({
        version: 1,
        id: fileResourceId(path),
        kind,
        title: fileName,
        description: BOOTSTRAP_DESCRIPTIONS[fileName],
        tier,
        branch: kind === 'legacy-memory' ? 'long-term' : undefined,
        scope: isGlobal ? 'global' : 'workspace',
        scopeKey: isGlobal ? undefined : root,
        authority: kind === 'legacy-memory' ? 'compatibility' : 'authoritative',
        privacy: isGlobal ? 'private' : 'project-private',
        source: {
          kind: 'file',
          path,
          contentHash: content === undefined ? undefined : contentHash(content),
        },
        indexKeys: [fileName, kind, basename(root)],
        status: content === undefined ? 'missing' : 'active',
        registryGroup: `bootstrap:${hashId(normalizedPath(root))}`,
        registeredAt: now,
        updatedAt: now,
      });
      if (content !== undefined && PROMPT_BOOTSTRAP_FILES.has(fileName)) output[fileName] = content;
    }
    await this.repository.replaceResourceGroup(resources[0]!.registryGroup, resources);
    return output;
  }
}
