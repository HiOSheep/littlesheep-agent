import { createHash } from 'node:crypto';
import type { ExplicitFileContentCheckRequest } from '@littlesheep/tools';

export interface ExplicitFileContentRequirement extends ExplicitFileContentCheckRequest {
  sourceMessageId: string;
  origin: 'user_explicit';
}

/**
 * Recognize one deliberately narrow, complete user request. This is not a
 * general task extractor: anything with extra prose or unsupported structure
 * remains inventory=unknown and cannot become a completed Task Outcome.
 */
export function parseExplicitFileContentRequirement(input: {
  runId: string;
  sourceMessageId: string;
  text: string;
}): ExplicitFileContentRequirement | undefined {
  const text = input.text.trim();
  const match = /^(?:创建|Create)\s+([A-Za-z0-9][A-Za-z0-9._-]{0,127})[，,]\s*(?:内容必须为|content must be)\s*(?:"([^"\r\n]{0,4096})"|'([^'\r\n]{0,4096})'|([^，,。\r\n]{1,4096}?))[。.]?$/u.exec(text);
  if (!match) return undefined;
  const filePath = match[1]!;
  if (filePath === '.' || filePath === '..' || filePath.includes('..')) return undefined;
  const expectedContent = (match[2] ?? match[3] ?? match[4] ?? '').trim();
  if (!expectedContent || Buffer.byteLength(expectedContent, 'utf8') > 16 * 1024) return undefined;

  const identity = createHash('sha256')
    .update(`${input.runId}\0${input.sourceMessageId}\0${filePath}`)
    .digest('hex')
    .slice(0, 24);
  return {
    runId: input.runId,
    requirementId: `req-${identity}`,
    sourceMessageId: input.sourceMessageId,
    origin: 'user_explicit',
    filePath,
    expectedContent,
  };
}

/**
 * Recognize a complete two- or three-item root-level text-file checklist.
 * Each non-empty line must be exactly one supported explicit requirement;
 * any surrounding prose leaves the inventory unrecognized.
 */
export function parseExplicitFileContentRequirements(input: {
  runId: string;
  sourceMessageId: string;
  text: string;
}): ExplicitFileContentRequirement[] | undefined {
  const text = input.text.trim();
  if (!text) return undefined;
  const lines = text.split(/\r?\n/u);
  if (lines.length === 1) {
    const single = parseExplicitFileContentRequirement({ ...input, text: lines[0]! });
    return single ? [single] : undefined;
  }
  if (lines.length < 2 || lines.length > 3) return undefined;

  const requirements: ExplicitFileContentRequirement[] = [];
  const paths = new Set<string>();
  for (const sourceLine of lines) {
    const line = sourceLine.trim().replace(/^(?:[-*]\s+|\d+[.)]\s+)/u, '');
    const requirement = parseExplicitFileContentRequirement({ ...input, text: line });
    if (!requirement || !/\.txt$/iu.test(requirement.filePath)) return undefined;
    const pathKey = requirement.filePath.toLocaleLowerCase();
    if (paths.has(pathKey)) return undefined;
    paths.add(pathKey);
    requirements.push(requirement);
  }
  return requirements;
}
