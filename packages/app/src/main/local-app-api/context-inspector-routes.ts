// Authorized, read-only view of already-redacted memory. Never reads/replays raw logs.
import { LOCAL_APP_API_PREFIXES, SESSION_CONTEXT_SUFFIX, matchLocalAppApiItemPath } from '../../shared/local-app-api-routes.js';
import { json, resolveRunner, type LocalAppApiRequest } from './http.js';
import type { SessionRouteContext } from './session-routes.js';

export async function routeContextInspector(request: LocalAppApiRequest, context: SessionRouteContext): Promise<boolean> {
  const sessionId = matchLocalAppApiItemPath(request.path, LOCAL_APP_API_PREFIXES.sessions, SESSION_CONTEXT_SUFFIX);
  if (request.method !== 'GET' || sessionId === null) return false;
  const availableRunner = context.getRunner();
  const listed = (await context.sessionIndex.list()).find((session) => session.id === sessionId);
  const active = availableRunner?.activeRuns?.list().some((run) => run.sessionId === sessionId);
  if (!listed && !active) {
    json(request.res, 404, { error: '当前会话不可用，请返回聊天后重新打开。' });
    return true;
  }
  const runner = resolveRunner(context.getRunner);
  if (!runner.inspectContext) {
    json(request.res, 503, { error: '上下文诊断暂不可用。' });
    return true;
  }
  const inspection = runner.inspectContext(sessionId);
  if (inspection.sessionId !== sessionId) {
    json(request.res, 409, { error: '上下文快照不匹配，请刷新后重试。' });
    return true;
  }
  json(request.res, 200, { ...inspection, ...(listed ? { session: {
    title: listed.title, createdAt: listed.createdAt, lastMessageAt: listed.lastMessageAt,
  } } : {}) });
  return true;
}
