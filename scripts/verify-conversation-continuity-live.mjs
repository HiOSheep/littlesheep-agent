// CTC-P0-12 / P0-E2E-001 in today's architecture: a blocked first turn, a user who grants access, and a
// final reply that delivers the original task instead of asking what the task was.
//
// The retired failure chain (classify → ask_user → finalize parks the run → the next message is classified
// as a brand-new task) no longer exists: a run does not park itself on a question, so continuity is carried
// by the session transcript plus the user's own answer. That makes "回答连续" the part that still needs a
// release-level gate, and it is the part this script measures, against the shipped provider path:
//
//   1. the user asks for a translated PDF while the session is in research mode and nothing may be approved
//      -> the deliverable must NOT appear, and the reply must say what is missing;
//   2. the same user answers "给你权限和相关工具了，你再试试" in the same session with full access
//      -> the same task must be finished: a real PDF appears, its text is Chinese, and the final reply
//         names the deliverable instead of repeating the original request back as a question.
//
// The assertion on the reply is deliberately a delivery check (the artifact it names exists and validates)
// plus a bounded refusal to accept a generic re-ask; it is not a semantic judge of the model's prose.
//
// Usage: DEEPSEEK_API_KEY=... node scripts/verify-conversation-continuity-live.mjs

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { performance } from 'node:perf_hooks';
import { DEFAULT_BRANDING } from '../packages/branding/dist/index.js';
import { DEFAULT_CONFIG } from '../packages/config/dist/index.js';
import { createDocument, extractDocument, verifyDocument } from '../packages/documents/dist/index.js';
import { createMemoryV3ExperimentMarker } from '../packages/memory-tree/dist/index.js';
import { createRunner } from '../packages/runner/dist/runner.js';

const apiKey = process.env.DEEPSEEK_API_KEY?.trim();
if (!apiKey) throw new Error('DEEPSEEK_API_KEY is required: this gate exists to run a real model.');

const SOURCE_FILE = 'source-report.pdf';
const FIRST_REQUEST = `请把 workplace/${SOURCE_FILE} 按原有排版翻译成中文（专有名词按需处理），交付物也是 PDF 文件。`;
const USER_ANSWER = '给你权限和相关工具了，你再试试。';
/** A reply that only asks the user to restate the task is exactly what CTC-P0-12 calls a failure. */
const REASK_PATTERNS = [
  /请(先)?(说明|告诉)我?(具体)?(的)?(任务|需求|要求)/u,
  /你想(让我)?(做|要)(什么|些什么)/u,
  /what would you like me to do/iu,
  /could you (please )?(clarify|tell me) what (you|the task)/iu,
];
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff]/u;

const startedAt = performance.now();
const root = await mkdtemp(join(tmpdir(), 'littlesheep-continuity-live-'));
const dataDir = join(root, 'data');
const workspace = join(dataDir, 'workplace');
const originalDataDir = process.env.LITTLESHEEP_DATA_DIR;
const steps = [];
let runner;
let report;
let failure;

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const listPdfs = async () => (await readdir(workspace)).filter((name) => name.toLowerCase().endsWith('.pdf')).sort();

try {
  process.env.LITTLESHEEP_DATA_DIR = dataDir;
  await mkdir(workspace, { recursive: true });
  await createMemoryV3ExperimentMarker(dataDir);

  // A small English fixture with a verifiable layout and a proper noun, so "translated into Chinese" is a
  // checkable property of the bytes rather than a matter of taste.
  const sourceText = [
    'Harbour Signal Report',
    'The Meridian Array consists of four stations along the northern coast.',
    'Each station reports wind speed, salinity and drift once every six hours.',
    'Operators must confirm the calibration log before publishing any reading.',
  ];
  const source = await createDocument({
    filePath: join(workspace, SOURCE_FILE),
    format: 'pdf',
    title: sourceText[0],
    blocks: sourceText.slice(1).map((text) => ({ type: 'paragraph', text })),
    createOnly: true,
  });
  const sourceBytes = await readFile(source.filePath);
  const sourceExtract = await extractDocument(source.filePath);
  // The extractor prefixes each page with a Chinese marker, so 'the source contains Chinese' is not a
  // usable property. The English body sentence is.
  const SOURCE_SENTENCE = 'The Meridian Array consists of four stations';
  assert(sourceExtract.text.includes(SOURCE_SENTENCE), 'The fixture is not readable as the English source.');

  const config = structuredClone(DEFAULT_CONFIG);
  config.memory.repositoryBackend = 'v3';
  config.agents.defaults.model = 'deepseek/deepseek-flash';
  config.agents.defaults.workspace = workspace;
  config.providers = [{
    id: 'deepseek',
    name: 'DeepSeek',
    baseURL: 'https://api.deepseek.com',
    apiKey: '$DEEPSEEK_API_KEY',
    models: ['deepseek-flash'],
  }];
  await writeFile(join(dataDir, 'config.json'), `${JSON.stringify(config, null, 2)}\n`, 'utf8');

  runner = await createRunner({
    config,
    branding: DEFAULT_BRANDING,
    model: 'deepseek/deepseek-flash',
    skillsDirs: [],
    log: () => undefined,
  });

  const session = await runner.sessionManager.create('deepseek/deepseek-flash');
  const approvals = { asked: 0, approved: 0 };
  const run = (text, options) => runner.run({
    sessionId: session.id,
    text,
    cwd: workspace,
    permissionPolicyId: options.permissionMode,
    ...(options.approve
      ? {
          approve: async () => {
            approvals.asked += 1;
            approvals.approved += 1;
            return true;
          },
        }
      : {}),
  });
  const toolNames = async () => {
    const lines = (await readFile(join(dataDir, 'sessions', `${session.id}.jsonl`), 'utf8'))
      .split('\n').filter(Boolean);
    const names = [];
    for (const line of lines) {
      let record;
      try { record = JSON.parse(line); } catch { continue }
      for (const block of record?.content ?? []) {
        if (block?.type !== 'tool_calls') continue;
        for (const call of block.calls ?? []) names.push(call?.function?.name ?? call?.name ?? null);
      }
    }
    return names;
  };

  // ─── 1. Blocked turn: research mode, nothing approves the write ──────────────────────────────────
  const blocked = await run(FIRST_REQUEST, { permissionMode: 'research' });
  const pdfsAfterBlocked = await listPdfs();
  const blockedDelivered = pdfsAfterBlocked.some((name) => name !== SOURCE_FILE);
  steps.push({
    step: '第一轮：缺权限时不得产出交付物',
    evidence: {
      status: blocked.status,
      reply: String(blocked.reply ?? '').slice(0, 240),
      files: pdfsAfterBlocked,
      approvalsAsked: approvals.asked,
    },
    result: !blockedDelivered && pdfsAfterBlocked.length === 1 ? 'pass' : 'fail',
  });
  assert(!blockedDelivered,
    'The blocked turn produced a deliverable anyway, so this gate would not be measuring anything.');
  assert.equal(pdfsAfterBlocked.length, 1, 'The workspace gained a PDF during the blocked turn.');

  // ─── 2. The user grants what was missing, in the same session ────────────────────────────────────
  const continued = await run(USER_ANSWER, { permissionMode: 'full', approve: true });
  const reply = String(continued.reply ?? '');
  const pdfsAfterContinuation = await listPdfs();
  const deliverableName = pdfsAfterContinuation.find((name) => name !== SOURCE_FILE);
  assert(deliverableName,
    'The continuation turn produced no deliverable. reply: ' + reply.slice(0, 300)
    + ' tools: ' + JSON.stringify(await toolNames()));
  const deliverablePath = join(workspace, deliverableName);
  const deliverableBytes = await readFile(deliverablePath);
  const verification = await verifyDocument(deliverablePath, 'pdf');
  const delivered = await extractDocument(deliverablePath);
  const reasked = REASK_PATTERNS.find((pattern) => pattern.test(reply));
  const namedDeliverable = reply.includes(deliverableName);

  steps.push({
    step: '第二轮：同一会话内承接原目标并交付',
    evidence: {
      status: continued.status,
      reply: reply.slice(0, 320),
      deliverable: deliverableName,
      deliverableBytes: deliverableBytes.length,
      deliverableIsChinese: CJK.test(delivered.text),
      sourceEnglishSentenceRetained: delivered.text.includes(SOURCE_SENTENCE),
      deliverablePages: delivered.metadata?.pageCount ?? null,
      verification,
      replyNamesDeliverable: namedDeliverable,
      replyReasked: reasked ? String(reasked) : false,
      toolsCalled: await toolNames(),
    },
    result: namedDeliverable && !reasked && CJK.test(delivered.text) ? 'pass' : 'fail',
  });

  assert(!reasked, 'The final reply repeats the original request instead of delivering: ' + reply.slice(0, 240));
  assert(namedDeliverable, 'The final reply does not name the deliverable it produced: ' + reply.slice(0, 240));
  assert(CJK.test(delivered.text), 'The deliverable contains no Chinese text: ' + delivered.text.slice(0, 200));
  assert(!delivered.text.includes(SOURCE_SENTENCE),
    'The deliverable still contains the untranslated English sentence: ' + delivered.text.slice(0, 200));

  // ─── 3. Both turns live in one session and both user messages are persisted once ─────────────────
  const sessionLines = (await readFile(join(dataDir, 'sessions', `${session.id}.jsonl`), 'utf8'))
    .split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const firstUser = sessionLines.filter((record) => record.role === 'user' && record.content?.some((block) => block.text === FIRST_REQUEST));
  const answerUser = sessionLines.filter((record) => record.role === 'user' && record.content?.some((block) => block.text === USER_ANSWER));
  const continuationEvidence = continued.conversationContinuation ?? blocked.conversationContinuation ?? null;
  steps.push({
    step: '文本连续：同一会话、两条用户消息各一次',
    evidence: {
      sessionId: session.id,
      firstRequestStoredTimes: firstUser.length,
      answerStoredTimes: answerUser.length,
      conversationContinuation: continuationEvidence,
    },
    result: firstUser.length === 1 && answerUser.length === 1 ? 'pass' : 'fail',
  });
  assert.equal(firstUser.length, 1, 'The first request was not persisted exactly once.');
  assert.equal(answerUser.length, 1, 'The user answer was not persisted exactly once.');

  assert.equal(continuationEvidence?.resolution, 'none',
    'A fresh run reported a continuation binding: ' + JSON.stringify(continuationEvidence));

  const failed = steps.filter((step) => step.result !== 'pass');
  report = {
    ok: failed.length === 0,
    generatedAt: new Date().toISOString(),
    provider: 'deepseek',
    model: 'deepseek/deepseek-flash',
    dataRoot: { isolated: true, removedAfterRun: false },
    fixture: {
      source: SOURCE_FILE,
      sourceSha256: sha256(sourceBytes).slice(0, 16),
      sourceBytes: sourceBytes.length,
      sourceTextEnglish: true,
    },
    steps,
    limits: [
      'This drives the app\'s run API (the same /run/stream surface the desktop composer uses) rather than '
      + 'the window itself; the cross-restart, real-window reply continuity case is '
      + 'verify:electron-deepseek-reply-continuity.',
      'The current architecture does not park a run on a question, so no waiting-user checkpoint is created '
      + 'and the continuation evidence is expected to be "none": continuity here is the session transcript '
      + 'plus the user\'s answer. The parked-head resolution (CTC-P0-01..11) stays as a compatibility path '
      + 'for checkpoints on disk from earlier versions.',
      'The reply check is a delivery assertion plus a bounded re-ask refusal; a real model\'s prose is not '
      + 'semantically judged, and a run that fails it is a measurement of model behaviour against the '
      + 'runtime contract.',
    ],
    resources: { durationMs: Math.round((performance.now() - startedAt) * 100) / 100 },
  };
} catch (error) {
  failure = error;
} finally {
  if (originalDataDir === undefined) delete process.env.LITTLESHEEP_DATA_DIR;
  else process.env.LITTLESHEEP_DATA_DIR = originalDataDir;
  try { await runner?.shutdown(); } catch (error) { failure ??= error; }
  try { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch (error) { failure ??= error; }
}

if (report) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (failure) {
  process.stderr.write(`continuity gate failed: ${failure.message}\n`);
  process.exitCode = 1;
}
