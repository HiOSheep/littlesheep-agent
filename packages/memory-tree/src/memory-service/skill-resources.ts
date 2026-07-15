// Reconciles Skill registrations by lifecycle owner while preserving stable resource identity.

import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { InjectionTier } from '../types.js';
import type { MemoryResourceRegistration } from '../types.js';
import type { MemoryRepository } from '../memory-repository.js';
import type {
  MemorySkillResourceInput,
  MemorySkillSourceInput,
  SyncMemorySkillResourcesOptions,
} from './contracts.js';
import {
  hashId,
  normalizedPath,
  skillOwnerKey,
  skillRegistryGroup,
} from './resource-identifiers.js';

export class SkillResourceCoordinator {
  constructor(private readonly repository: MemoryRepository) {}

  async sync(
    skills: MemorySkillResourceInput[],
    sources: MemorySkillSourceInput[],
    options: SyncMemorySkillResourcesOptions = {},
  ): Promise<void> {
    const now = new Date().toISOString();
    const managedKinds = new Set(options.ownerKinds ?? sources.map((source) => source.kind));
    const managedSources = sources.filter((source) => managedKinds.has(source.kind));
    const existing = await this.repository.listResources({ kind: 'skill' });
    const existingByPath = new Map(existing
      .filter((resource) => resource.source.path)
      .map((resource) => [normalizedPath(resource.source.path!), resource]));
    const existingByOwnerAndName = new Map(existing
      .filter((resource) => resource.owner && typeof resource.metadata?.skillName === 'string')
      .map((resource) => [
        skillOwnerKey(resource.owner!.kind, resource.owner!.id, String(resource.metadata!.skillName)),
        resource,
      ]));
    const currentGroups = new Set<string>();

    for (const source of managedSources) {
      const ownerId = source.ownerId ?? source.id;
      const registryGroup = skillRegistryGroup(source.kind, ownerId);
      currentGroups.add(registryGroup);
      const sourceSkills = skills.filter((skill) => skill.source.id === source.id);
      const resources: MemoryResourceRegistration[] = [];
      for (const skill of sourceSkills) {
        const path = join(skill.dir, 'SKILL.md');
        const ownerKey = skillOwnerKey(source.kind, ownerId, skill.name);
        const prior = existingByOwnerAndName.get(ownerKey) ?? existingByPath.get(normalizedPath(path));
        let fileUpdatedAt = now;
        let status: MemoryResourceRegistration['status'] = skill.availability === 'active'
          ? 'active'
          : skill.availability === 'disabled'
            ? 'disabled'
            : 'conflict';
        try {
          fileUpdatedAt = (await stat(path)).mtime.toISOString();
        } catch {
          status = 'missing';
        }
        if (prior?.source.path && normalizedPath(prior.source.path) !== normalizedPath(path)) {
          await this.repository.rebindResource(prior.id, {
            sourcePath: path,
            title: skill.name,
            kind: 'skill',
            indexKeys: [skill.name, skill.description, skill.whenToUse ?? ''],
            status: status === 'disabled' ? 'active' : status,
          }, {
            actor: 'system',
            reason: `技能“${skill.name}”随其所有者迁移了来源路径。`,
            replaceConflictingResource: true,
          });
        }
        resources.push({
          version: 1,
          id: prior?.id ?? `skill:${hashId(`${source.kind}:${ownerId}:${skill.name}`)}`,
          kind: 'skill',
          title: skill.name,
          description: skill.description,
          tier: InjectionTier.T2_RELEVANT,
          scope: 'global',
          authority: 'authoritative',
          privacy: 'private',
          source: { kind: 'file', path },
          indexKeys: [skill.name, skill.description, skill.whenToUse ?? ''],
          status,
          registryGroup,
          owner: {
            kind: source.kind,
            id: ownerId,
            controller: source.kind === 'plugin' ? 'plugin-host' : 'skill-loader',
          },
          registeredAt: prior?.registeredAt ?? now,
          updatedAt: fileUpdatedAt,
          metadata: {
            ...prior?.metadata,
            skillName: skill.name,
            skillAvailability: skill.availability,
            skillSourceId: source.id,
          },
        });
      }
      await this.repository.replaceResourceGroup(registryGroup, resources, {
        preserveDisabled: false,
        reason: source.kind === 'plugin'
          ? `插件“${ownerId}”已同步其 Skill 生命周期。`
          : `SkillLoader 已同步来源“${ownerId}”。`,
      });
    }

    const managesLegacySkillGroup = [...managedKinds].some((kind) => kind !== 'plugin');
    const staleGroups = new Set(existing
      .filter((resource) => resource.owner
        ? managedKinds.has(resource.owner.kind)
        : managesLegacySkillGroup)
      .map((resource) => resource.registryGroup)
      .filter((group) => !currentGroups.has(group)));
    for (const group of staleGroups) {
      await this.repository.replaceResourceGroup(group, [], {
        preserveDisabled: false,
        reason: 'Skill 所有者已不再被发现，资源登记保留为来源缺失状态。',
      });
    }
  }
}
