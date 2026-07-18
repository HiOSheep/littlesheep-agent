interface SkillProposal {
  name?: unknown;
  description?: unknown;
  whenToUse?: unknown;
  body?: unknown;
}

const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

export function parseSkillProposal(value: unknown): {
  name: string;
  description: string;
  whenToUse?: string;
  body: string;
} | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const proposal = value as SkillProposal;
  const name = cleanString(proposal.name, 64) ?? '';
  const description = cleanString(proposal.description, 200) ?? '';
  const body = cleanString(proposal.body, 12_000) ?? '';
  const whenToUse = cleanString(proposal.whenToUse, 500);
  if (!name || !description || !body || !NAME_RE.test(name)) return null;
  return { name, description, whenToUse, body };
}

function cleanString(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const cleaned = value.replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
  return cleaned ? cleaned.slice(0, max) : undefined;
}
