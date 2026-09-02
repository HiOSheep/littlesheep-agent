import type { AgentTool, RetrievalIntent, RunContext } from '@littlesheep/types';

const URL_PATTERN = /https?:\/\/[^\s<>()"']+/iu;
const CAPABILITY_PATTERN = /(?:(?:LS|LittleSheep|你|系统).{0,16}(?:(?:还|尚)?没(?:有)?|未曾?|暂未|不再?|支持|能否|能不能|可以|会不会|有没有).{0,16}(?:配置|提供|启用|联网|网络搜索|网页搜索|实时搜索|网络查询|搜索能力|搜索功能)|(?:(?:还|尚)?没(?:有)?|未曾?|暂未).{0,16}(?:给(?:你|LS|系统)?|为(?:你|LS|系统)?)?.{0,16}(?:配置|提供|启用).{0,16}(?:联网|网络搜索|网页搜索|实时搜索|网络查询|搜索能力|搜索功能)|(?:LS|LittleSheep|你|系统).{0,16}(?:支持|能否|能不能|可以|会不会|有没有).{0,16}(?:联网|网络搜索|网页搜索|实时搜索|网络查询|搜索能力|搜索功能)|\b(?:can|does|is)\s+(?:LS|LittleSheep|the agent|you)\s+(?:search|browse|access the web)\b)/iu;
const CAPABILITY_PROBE_PATTERN = /(?:查询过了吗|查过了吗|实际(?:查|测)一下|实测(?:一下)?(?:网络|联网|搜索|查询)?|验证一下(?:联网|网络|搜索|查询|能力)|测试一下(?:联网|网络|搜索|查询|能力)|基于事实.{0,24}(?:需要|请).{0,8}(?:查询|搜索|联网)|你(?:到底|真的)?查(?:过|一下)|\b(?:probe|test|verify)\b.{0,24}\b(?:web|network|search|internet|capability)\b)/iu;
const WORKSPACE_PATTERN = /(?:工作区|项目|仓库|目录|文件夹|本地文件|代码|源码)|\b(?:workspace|repository|repo|project files?|local files?|source code)\b/iu;
const MEMORY_PATTERN = /(?:记得|记忆|上次|之前的决定|我的偏好|历史约定|项目约定|长期记忆)|\b(?:remember|memory|previous decision|my preference|project convention)\b/iu;
const WEB_PATTERN = /(?:联网|网上|网络|网页|公开来源|官方来源|找来源|查资料|新闻|政策|价格|赛事|天气|版本|今天|今日|最新|实时|刚刚|近期)|\b(?:online|web|internet|source|news|policy|price|weather|version|today|current|latest|real[- ]?time|recent)\b/iu;
const EXPLICIT_WEB_PATTERN = /(?:联网|网上|网络|网页|公开来源|官方来源|找来源|查资料|新闻|政策|价格|赛事|天气)|\b(?:online|web|internet|public source|news|policy|price|weather)\b/iu;
const FETCH_PATTERN = /(?:打开|读取|查看|总结|概括|分析).{0,24}(?:链接|网址|网页|页面)|\b(?:open|read|fetch|summari[sz]e|inspect|analy[sz]e)\b.{0,30}\b(?:url|link|page|website)\b/iu;
const BROWSER_PATTERN = /(?:登录|验证码|点击|填写表单|上传|下载按钮|浏览器会话|已登录页面)|\b(?:log[ -]?in|sign[ -]?in|captcha|click|fill (?:the )?form|upload|browser session|authenticated page)\b/iu;
const COMPLEX_WEB_PATTERN = /(?:比较|对比|交叉验证|多来源|多个来源|三份|3份|至少.{0,4}(?:来源|网站|页面))|\b(?:compare|cross-check|multiple sources|three sources|at least \d+ sources)\b/iu;

export interface RetrievalIntentAssessment {
  readonly intent: RetrievalIntent;
  readonly compact: boolean;
  readonly reason: string;
}

const WEB_TOOL_NAMES = new Set(['web_search', 'web_fetch']);

/**
 * Apply the Runtime-owned inbound retrieval decision to the model catalog.
 * This must never be recomputed from fetched page content or model output.
 */
export function toolsForRetrievalIntent(
  ctx: Pick<RunContext, 'classification' | 'inbound' | 'tools' | 'toolSources'>,
): AgentTool[] {
  const intent = ctx.classification?.retrievalIntent ?? assessRetrievalIntent(inboundText(ctx)).intent;
  if (intent === 'web_search' || intent === 'combined_memory_web') {
    return ctx.tools.filter((tool) => (
      !WEB_TOOL_NAMES.has(tool.name)
      || ((tool.name === 'web_search' || tool.name === 'web_fetch')
        && ctx.toolSources?.[tool.name] === 'builtin')
    ));
  }
  if (intent === 'web_fetch') {
    return ctx.tools.filter((tool) => (
      !WEB_TOOL_NAMES.has(tool.name)
      || (tool.name === 'web_fetch' && ctx.toolSources?.[tool.name] === 'builtin')
    ));
  }
  return ctx.tools.filter((tool) => !WEB_TOOL_NAMES.has(tool.name));
}

export function renderRetrievalIntentContract(
  ctx: Pick<RunContext, 'classification' | 'inbound'>,
): string {
  const intent = ctx.classification?.retrievalIntent ?? assessRetrievalIntent(inboundText(ctx)).intent;
  switch (intent) {
    case 'local_workspace':
      return 'Runtime retrieval intent: local_workspace. Use only local workspace evidence. Do not plan or request Web tools.';
    case 'local_memory':
      return 'Runtime retrieval intent: local_memory. Use the existing Memory Tree flow. Do not plan or request Web tools.';
    case 'web_search':
      return 'Runtime retrieval intent: web_search. Public Web evidence may be obtained only through the listed built-in web_search/web_fetch tools. Select 2-4 relevant sources for comparisons, fetch only what is necessary, and preserve Runtime citation ids.';
    case 'web_fetch':
      return 'Runtime retrieval intent: web_fetch. Read only the user-supplied public URL through the listed built-in web_fetch tool. Do not add discovery scope unless the user requested it.';
    case 'combined_memory_web':
      return 'Runtime retrieval intent: combined_memory_web. First use the existing Memory Tree route to resolve only the specific project/user semantic needed for this question. Then construct a short public query containing only that minimal non-sensitive meaning. Never copy raw Memory atoms, conversations, attachments, daily logs, credentials, unique personal identifiers, or private paths into Web tool input. If the necessary query cannot be safely minimized, request egress approval instead of sending raw memory. Keep Memory and Web evidence distinct by source, authority and time.';
    case 'browser_required':
      return 'Runtime retrieval intent: browser_required. This requires interactive or authenticated browser state. Do not substitute anonymous web_fetch/web_search or claim that the interaction was completed.';
    case 'capability_question':
      return 'Runtime retrieval intent: capability_question. Explain capability from Runtime state; do not retrieve from the Web.';
    case 'capability_probe':
      return 'Runtime retrieval intent: capability_probe. Emit and rely on a real Runtime capability probe event. Do not claim a Web query unless a real web_search/web_fetch event exists.';
    case 'none':
    default:
      return 'Runtime retrieval intent: none. Web tools are not admitted for this request.';
  }
}

/** Classify only the user's inbound text; external page content is never an intent source. */
export function assessRetrievalIntent(text: string): RetrievalIntentAssessment {
  const value = text.normalize('NFKC').trim();
  if (!value) return { intent: 'none', compact: false, reason: 'empty request' };
  if (CAPABILITY_PROBE_PATTERN.test(value)) {
    return { intent: 'capability_probe', compact: false, reason: 'requests an observable Runtime capability probe' };
  }
  if (CAPABILITY_PATTERN.test(value)) {
    return { intent: 'capability_question', compact: false, reason: 'asks about capability rather than requesting retrieval' };
  }
  const hasMemory = MEMORY_PATTERN.test(value);
  const hasWorkspace = WORKSPACE_PATTERN.test(value);
  const hasWeb = WEB_PATTERN.test(value);
  const hasExplicitWeb = EXPLICIT_WEB_PATTERN.test(value);
  if (BROWSER_PATTERN.test(value)) {
    return { intent: 'browser_required', compact: false, reason: 'requires interactive or authenticated browser state' };
  }
  if (hasMemory && hasWeb) {
    return { intent: 'combined_memory_web', compact: false, reason: 'combines private memory context with fresh public evidence' };
  }
  if (URL_PATTERN.test(value) && (FETCH_PATTERN.test(value) || /(?:打开|读取|查看|总结|概括|分析)|\b(?:open|read|fetch|summari[sz]e|inspect|analy[sz]e)\b/iu.test(value))) {
    return { intent: 'web_fetch', compact: !COMPLEX_WEB_PATTERN.test(value), reason: 'requests one public URL to be read' };
  }
  if (hasWorkspace && !hasExplicitWeb) {
    return { intent: 'local_workspace', compact: true, reason: 'requests local workspace evidence' };
  }
  if (hasMemory && !hasWeb) {
    return { intent: 'local_memory', compact: false, reason: 'requests local memory evidence' };
  }
  if (hasWeb) {
    return { intent: 'web_search', compact: !COMPLEX_WEB_PATTERN.test(value), reason: 'requests fresh public information' };
  }
  return { intent: 'none', compact: false, reason: 'no retrieval signal' };
}

function inboundText(ctx: Pick<RunContext, 'inbound'>): string {
  return ctx.inbound.content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}
