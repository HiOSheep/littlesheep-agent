// Selects the conservative high-relevance cluster for automatic initial Context injection.

const MIN_INITIAL_ATOM_RELEVANCE = 0.25;
const MIN_INITIAL_RELEVANCE_CLIFF = 0.2;
const MAX_INITIAL_TAIL_RATIO = 0.75;
const MIN_INITIAL_RELATION_STRENGTH = 0.65;

export interface MemoryPrimeCandidate {
  branchId: string;
  nodeId: string;
  taskRelevance: number;
  selectionScore: number;
  order: number;
  retrievalPath?: 'hierarchy' | 'fts' | 'vector' | 'relation';
  retrievalMatchReason?: string;
  relationStrength?: number;
}

export function selectMemoryPrimeCandidates(
  candidates: MemoryPrimeCandidate[],
  maxAtoms: number,
): MemoryPrimeCandidate[] {
  const admitted = candidates
    .filter((candidate) => candidate.taskRelevance > MIN_INITIAL_ATOM_RELEVANCE);
  const strongest = admitted.reduce((score, candidate) => Math.max(score, candidate.taskRelevance), 0);
  return admitted
    .filter((candidate) => strongest - candidate.taskRelevance < MIN_INITIAL_RELEVANCE_CLIFF
      || candidate.taskRelevance > strongest * MAX_INITIAL_TAIL_RATIO
      || (candidate.retrievalPath === 'relation'
        && (candidate.relationStrength ?? 0) >= MIN_INITIAL_RELATION_STRENGTH))
    .sort((left, right) => right.selectionScore - left.selectionScore
      || (right.relationStrength ?? 0) - (left.relationStrength ?? 0)
      || right.taskRelevance - left.taskRelevance
      || left.order - right.order)
    .slice(0, maxAtoms);
}
