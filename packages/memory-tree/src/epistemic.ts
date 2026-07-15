// Shared epistemic contracts used by write intents, Memory v3 atoms, Context, and UI projections.

export type MemoryDomain =
  | 'user'
  | 'agent-self'
  | 'task'
  | 'project'
  | 'session'
  | 'experience'
  | 'knowledge';

export type StatementKind =
  | 'instruction'
  | 'goal'
  | 'preference'
  | 'value'
  | 'reported-observation'
  | 'factual-claim'
  | 'suggestion'
  | 'hypothesis'
  | 'decision'
  | 'approval';

export type EpistemicStatus =
  | 'reported'
  | 'unverified'
  | 'corroborated'
  | 'verified'
  | 'disputed'
  | 'superseded';

export type AuthorityKind =
  | 'user-self'
  | 'system-policy'
  | 'project-owner'
  | 'session-owner'
  | 'tool-evidence'
  | 'external-source'
  | 'none';

export type MemoryAuthorityScope = 'global' | 'workspace' | 'project' | 'session' | 'run';

export interface AuthorityScope {
  kind: AuthorityKind;
  scope: MemoryAuthorityScope;
  scopeKey?: string;
  topics: string[];
}

export type MemoryActorKind = 'user' | 'agent' | 'system' | 'tool' | 'external';

export interface MemoryActorRef {
  kind: MemoryActorKind;
  id?: string;
  label?: string;
}

export interface MemoryWriteEpistemicMetadata {
  domain: MemoryDomain;
  statementKind: StatementKind;
  epistemicStatus: EpistemicStatus;
  authorityScope: AuthorityScope;
  assertedBy: MemoryActorRef;
  evidenceRefs?: string[];
  entityRefs?: string[];
  relationRefs?: string[];
}
