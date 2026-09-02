import { z } from 'zod';
import type { AgentTool, SearchRequest, WebEvidenceProjection } from '@littlesheep/types';
import { authorizeToolAccess, classifySensitiveWebQuery, redactSensitiveWebQuery } from '@littlesheep/safety';
import { withToolTiming } from '../wrapper.js';
import {
  adjustedProjection,
  boundedText,
  hasValidUnicode,
  recordWebEvidence,
  webExecution,
  webFailure,
  webSearchInputProjection,
} from './web-common.js';

const Domain = z.string().trim().toLowerCase().max(253).regex(/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*\.?$/u)
  .transform((value) => value.replace(/\.$/u, ''));
const Query = z.string().max(2_000).superRefine((value, ctx) => {
  if (!value.trim()) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'query is empty' });
  if (/[\u0000-\u001f\u007f]/u.test(value)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'query contains control characters' });
  if (!hasValidUnicode(value)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'query contains invalid Unicode' });
}).transform((value) => value.normalize('NFKC').replace(/\s+/gu, ' ').trim());
const WebSearchInput = z.object({
  query: Query,
  domains: z.array(Domain).max(20).optional().transform((value) => value ? [...new Set(value)] : undefined),
  excludeDomains: z.array(Domain).max(20).optional().transform((value) => value ? [...new Set(value)] : undefined),
  recency: z.enum(['today', 'week', 'month', 'year']).optional(),
  language: z.string().trim().min(2).max(35).regex(/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/u).optional(),
  maxResults: z.number().int().min(1).max(20).optional(),
}).strict();

export const webSearchTool: AgentTool = {
  name: 'web_search',
  description: 'Search current public web sources through the configured provider. Returns bounded untrusted results with runtime-issued citations.',
  inputSchema: WebSearchInput,
  execution: webExecution('web_search'),
  persistence: { projectInput: webSearchInputProjection },
  execute: withToolTiming(async (input, ctx) => {
    const parsed = WebSearchInput.parse(input);
    const policy = ctx.networkPolicy;
    if (!policy?.enabled || policy.mode === 'disabled') return webFailure({ kind: 'web_disabled' });
    if (!ctx.webRetrieval) return webFailure({ kind: 'web_provider_unconfigured' });

    const sensitive = classifySensitiveWebQuery(parsed.query);
    let query = parsed.query;
    if (sensitive.sensitive) {
      if (policy.sensitiveQueryPolicy === 'deny') return webFailure({ kind: 'web_sensitive_query_blocked' });
      if (policy.sensitiveQueryPolicy === 'approve' && ctx.approvalGranted !== true && ctx.permissionMode !== 'full') {
        return webFailure({ kind: 'web_sensitive_query_blocked' });
      }
      if (policy.sensitiveQueryPolicy === 'redact') {
        query = redactSensitiveWebQuery(query);
        if (!query || query.length > policy.maxQueryChars) return webFailure({ kind: 'web_sensitive_query_blocked' });
      }
    }

    const authorization = await authorizeToolAccess('web_search', webSearchInputProjection(parsed), ctx);
    if (!authorization.allowed) return webFailure({ kind: 'web_sensitive_query_blocked' });
    const request: SearchRequest = {
      query,
      ...(parsed.domains ? { domains: parsed.domains } : {}),
      ...(parsed.excludeDomains ? { excludeDomains: parsed.excludeDomains } : {}),
      ...(parsed.recency ? { recency: parsed.recency } : {}),
      ...(parsed.language ? { language: parsed.language } : {}),
      maxResults: parsed.maxResults ?? Math.min(10, policy.maxResults),
      runId: ctx.runId,
    };

    let projection: WebEvidenceProjection;
    try {
      const response = await ctx.webRetrieval.search(request, ctx.signal);
      const results = response.results.map((result) => ({
        rank: result.rank,
        title: boundedText(result.title, 160),
        ...(result.url.length <= 500 ? { url: result.url } : { urlOmitted: true }),
        ...(result.snippet ? { snippet: boundedText(result.snippet, 240) } : {}),
        ...(result.publishedAt ? { publishedAt: boundedText(result.publishedAt, 100) } : {}),
        ...(result.siteName ? { siteName: boundedText(result.siteName, 253) } : {}),
        citationId: result.citationId,
        sourceStatus: result.sourceStatus,
      }));
      projection = adjustedProjection(ctx.webRetrieval.evidence(), results.some((result) => 'urlOmitted' in result));
      await recordWebEvidence(ctx, projection);
      return {
        output: JSON.stringify({
          kind: 'web_search', provider: response.provider, resultCount: results.length,
          fetchedAt: response.fetchedAt, cached: response.cached, partial: projection.partial,
          citationIds: projection.citationIds,
        }),
        modelOutput: {
          kind: 'web_search_results', externalUntrusted: true, provider: response.provider,
          fetchedAt: response.fetchedAt, cached: response.cached, partial: projection.partial, results,
        },
        webEvidence: projection,
        meta: { resultCount: results.length, externalUntrusted: true },
      };
    } catch (error) {
      projection = ctx.webRetrieval.evidence();
      await recordWebEvidence(ctx, projection);
      return { ...webFailure(error), webEvidence: projection };
    }
  }),
};
