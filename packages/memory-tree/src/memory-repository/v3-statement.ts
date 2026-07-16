// Classifies every v3 write before persistence and preserves epistemic category across merges.

import type {
  AuthorityScope,
  EpistemicStatus,
  MemoryActorRef,
  MemoryDomain,
  MemoryWriteEpistemicMetadata,
  StatementKind,
} from '../epistemic.js';
import type { MemoryResolutionStatus } from '../v3/contracts.js';
import type { MemoryWriteIntent } from '../types.js';
import { cleanText, unique } from './text.js';

export interface ClassifiedMemoryStatement extends MemoryWriteEpistemicMetadata {
  evidenceRefs: string[];
  entityRefs: string[];
  relationRefs: string[];
  resolutionStatus: MemoryResolutionStatus;
}

export function classifyMemoryWriteIntent(intent: MemoryWriteIntent): ClassifiedMemoryStatement {
  const explicit = intent.epistemic;
  const text = `${intent.summary}\n${intent.content}\n${intent.reason}`;
  const statementKind = explicit?.statementKind ?? inferStatementKind(intent, text);
  const assertedBy = normalizeActor(explicit?.assertedBy ?? inferActor(intent, statementKind, text));
  const domain = explicit?.domain ?? inferDomain(intent, statementKind, assertedBy);
  const epistemicStatus = explicit?.epistemicStatus ?? inferEpistemicStatus(intent, statementKind);
  const authorityScope = normalizeAuthorityScope(
    explicit?.authorityScope ?? inferAuthorityScope(intent, assertedBy),
    intent,
  );
  return {
    domain,
    statementKind,
    epistemicStatus,
    authorityScope,
    assertedBy,
    evidenceRefs: unique([...(intent.evidenceRefs ?? []), ...(explicit?.evidenceRefs ?? [])]).slice(0, 64),
    entityRefs: unique(explicit?.entityRefs ?? []).slice(0, 64),
    relationRefs: unique(explicit?.relationRefs ?? []).slice(0, 64),
    resolutionStatus: resolutionStatus(statementKind, epistemicStatus, assertedBy),
  };
}

export function sameStatementCategory(
  left: Pick<ClassifiedMemoryStatement, 'domain' | 'statementKind' | 'authorityScope' | 'assertedBy'>,
  right: Pick<ClassifiedMemoryStatement, 'domain' | 'statementKind' | 'authorityScope' | 'assertedBy'>,
): boolean {
  return left.domain === right.domain
    && left.statementKind === right.statementKind
    && left.authorityScope.kind === right.authorityScope.kind
    && left.authorityScope.scope === right.authorityScope.scope
    && (left.authorityScope.scopeKey ?? '') === (right.authorityScope.scopeKey ?? '')
    && left.assertedBy.kind === right.assertedBy.kind
    && (left.assertedBy.id ?? '') === (right.assertedBy.id ?? '');
}

function inferStatementKind(intent: MemoryWriteIntent, text: string): StatementKind {
  if (/(?:建议|可以考虑|推荐|不妨|最好考虑|recommend|suggest|should consider)/iu.test(text)) return 'suggestion';
  if (/(?:可能|也许|推测|假设|maybe|perhaps|hypothes)/iu.test(text)) return 'hypothesis';
  if (/(?:批准|授权|允许|同意执行|approved|permission granted)/iu.test(text)) return 'approval';
  if (/(?:决定|已选择|确认采用|decision|decided|selected)/iu.test(text)) return 'decision';
  if (/(?:偏好|喜欢|希望|习惯|prefers?|preference|wants?)/iu.test(text)) return 'preference';
  if (/(?:核心理念|设计原则|价值取向|重视|value|principle)/iu.test(text)) return 'value';
  if (/(?:目标|要实现|需要完成|goal|objective)/iu.test(text)) return 'goal';
  if (/(?:必须|不得|禁止|始终|规则是|must|never|always|required)/iu.test(text)) return 'instruction';
  if (intent.sourceStage === 'capture') return 'reported-observation';
  return 'factual-claim';
}

function inferActor(intent: MemoryWriteIntent, kind: StatementKind, text: string): MemoryActorRef {
  if (['preference', 'goal', 'decision', 'approval', 'value'].includes(kind)
    && /(?:用户|user|我(?:偏好|喜欢|希望|决定|选择|允许|批准|重视))/iu.test(text)) {
    return { kind: 'user' };
  }
  if (intent.sourceStage === 'tool') return { kind: 'tool' };
  if (intent.sourceStage === 'migration') return { kind: 'system' };
  return { kind: 'agent', id: 'littlesheep' };
}

function inferDomain(intent: MemoryWriteIntent, kind: StatementKind, actor: MemoryActorRef): MemoryDomain {
  if (actor.kind === 'user' && ['preference', 'goal', 'decision', 'approval', 'value'].includes(kind)) return 'user';
  if (intent.branch === 'experience') return 'experience';
  if (intent.branch === 'project') return 'project';
  if (intent.branch === 'daily') return intent.scope === 'session' ? 'session' : 'task';
  return 'knowledge';
}

function inferEpistemicStatus(intent: MemoryWriteIntent, kind: StatementKind): EpistemicStatus {
  if (['suggestion', 'hypothesis'].includes(kind)) return 'unverified';
  if (['preference', 'goal', 'decision', 'approval', 'value'].includes(kind)) return 'reported';
  if (intent.sourceStage === 'tool') return 'corroborated';
  return intent.sourceStage === 'capture' ? 'reported' : 'unverified';
}

function inferAuthorityScope(intent: MemoryWriteIntent, actor: MemoryActorRef): AuthorityScope {
  const scope = intent.scope;
  if (actor.kind === 'user') {
    return { kind: 'user-self', scope, scopeKey: intent.scopeKey, topics: [] };
  }
  if (actor.kind === 'tool') {
    return { kind: 'tool-evidence', scope, scopeKey: intent.scopeKey, topics: [] };
  }
  return { kind: 'none', scope, scopeKey: intent.scopeKey, topics: [] };
}

function normalizeAuthorityScope(value: AuthorityScope, intent: MemoryWriteIntent): AuthorityScope {
  const scopeKey = value.scope === 'global' ? undefined : cleanText(value.scopeKey ?? intent.scopeKey ?? '') || undefined;
  if (value.scope !== 'global' && !scopeKey) {
    throw new Error(`Epistemic authority scope "${value.scope}" requires scopeKey.`);
  }
  return {
    kind: value.kind,
    scope: value.scope,
    scopeKey,
    topics: unique(value.topics.map((topic) => cleanText(topic).toLocaleLowerCase())).slice(0, 32),
  };
}

function normalizeActor(value: MemoryActorRef): MemoryActorRef {
  return {
    kind: value.kind,
    id: value.id ? cleanText(value.id) : undefined,
    label: value.label ? cleanText(value.label).slice(0, 120) : undefined,
  };
}

function resolutionStatus(
  kind: StatementKind,
  status: EpistemicStatus,
  actor: MemoryActorRef,
): MemoryResolutionStatus {
  if (kind === 'suggestion' || kind === 'hypothesis') return 'proposed';
  if (kind === 'decision' || kind === 'approval') return actor.kind === 'user' ? 'resolved' : 'under-review';
  if ((kind === 'preference' || kind === 'goal' || kind === 'value') && actor.kind === 'user') return 'adopted';
  return status === 'verified' ? 'resolved' : 'unresolved';
}
