import { z } from 'zod';
import type { AgentTool, FetchRequest, WebEvidenceProjection } from '@littlesheep/types';
import { authorizeToolAccess } from '@littlesheep/safety';
import { withToolTiming } from '../wrapper.js';
import {
  adjustedProjection,
  boundedText,
  hasValidUnicode,
  recordWebEvidence,
  webExecution,
  webFailure,
  webFetchInputProjection,
} from './web-common.js';

const WebFetchInput = z.object({
  url: z.string().trim().min(1).max(4_096).superRefine((value, ctx) => {
    if (/[\u0000-\u0020\u007f]/u.test(value)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'URL contains whitespace or control characters' });
    if (!hasValidUnicode(value)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'URL contains invalid Unicode' });
  }),
  citationId: z.string().trim().min(1).max(200).optional(),
  maxChars: z.number().int().min(1).max(500_000).optional(),
  purpose: z.enum(['user_url', 'search_followup', 'verification']).optional(),
}).strict();

const MAX_MODEL_CONTENT_CHARS = 7_000;

export const webFetchTool: AgentTool = {
  name: 'web_fetch',
  description: 'Fetch one anonymous public HTTP(S) page through the runtime safety boundary. Returns bounded untrusted text with citation metadata.',
  inputSchema: WebFetchInput,
  execution: webExecution('web_fetch'),
  persistence: { projectInput: webFetchInputProjection },
  execute: withToolTiming(async (input, ctx) => {
    const parsed = WebFetchInput.parse(input);
    const policy = ctx.networkPolicy;
    if (!policy?.enabled || policy.mode === 'disabled') return webFailure({ kind: 'web_disabled' });
    if (!ctx.webRetrieval) return webFailure({ kind: 'web_provider_unconfigured' });
    const authorization = await authorizeToolAccess('web_fetch', webFetchInputProjection(parsed), ctx);
    if (!authorization.allowed) return webFailure({ kind: 'web_ssrf_blocked' });
    const request: FetchRequest = {
      url: parsed.url,
      ...(parsed.citationId ? { citationId: parsed.citationId } : {}),
      ...(parsed.maxChars ? { maxChars: parsed.maxChars } : {}),
      ...(parsed.purpose ? { purpose: parsed.purpose } : {}),
    };

    let projection: WebEvidenceProjection;
    try {
      const document = await ctx.webRetrieval.fetch(request, ctx.signal);
      const content = document.content.slice(0, MAX_MODEL_CONTENT_CHARS);
      const modelTruncated = content.length < document.content.length;
      projection = adjustedProjection(ctx.webRetrieval.evidence(), modelTruncated);
      await recordWebEvidence(ctx, projection);
      return {
        output: JSON.stringify({
          kind: 'web_fetch', citationId: document.citationId, status: document.status,
          contentType: document.contentType, extractor: document.extractor,
          fetchedAt: document.fetchedAt, cached: document.cached,
          partial: projection.partial, truncated: projection.truncated,
          contentHash: document.contentHash,
        }),
        modelOutput: {
          kind: 'web_fetched_document', externalUntrusted: true,
          ...(document.title ? { title: boundedText(document.title, 300) } : {}),
          ...(document.finalUrl.length <= 1_000 ? { finalUrl: document.finalUrl } : { finalUrlOmitted: true }),
          ...(document.publishedAt ? { publishedAt: boundedText(document.publishedAt, 100) } : {}),
          fetchedAt: document.fetchedAt, status: document.status, contentType: document.contentType,
          extractor: document.extractor, cached: document.cached,
          truncated: document.truncated || modelTruncated, citationId: document.citationId,
          content,
        },
        webEvidence: projection,
        meta: { externalUntrusted: true, extractor: document.extractor, contentChars: content.length },
      };
    } catch (error) {
      projection = ctx.webRetrieval.evidence();
      await recordWebEvidence(ctx, projection);
      return { ...webFailure(error), webEvidence: projection };
    }
  }),
};
