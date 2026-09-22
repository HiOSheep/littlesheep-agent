// Frozen manifest of the *long-interval* real task used to judge how the
// session-cumulative provider cache-hit ratio behaves as ONE session grows.
//
// WHY THIS SET EXISTS (and why the six frozen tasks are not enough):
//   `scripts/lib/real-long-task-manifest.mjs` freezes six real tasks of three
//   turns each. Three turns never reach session compaction (the production
//   threshold is 100 conversational messages) and never show whether the ratio
//   keeps rising, plateaus or collapses once a session is long. This module
//   freezes exactly ONE task of 24-32 turns on a single seeded project, so the
//   ratio can be read at several milestones of the SAME session.
//
// WHAT IS FROZEN HERE (and why re-deriving it later is a defect):
//   - the field names: identical to the six frozen tasks (`id`, `classId`,
//     `title`, `workspaceSeed`, `turns`, `nodes`, `acceptance`, `requiresWeb`),
//     so ONE driver runs both manifests without a second code path.
//   - the workload itself: the seeded files and their exact contents, the
//     consecutive user turns of one session, and the declarative acceptance
//     checks that describe the FINAL state of the project.
//   - the node positions: `nodes` are the business milestones at which the
//     cumulative ratio is read, and `turn` is the 1-based turn whose completion
//     reaches that milestone. They are frozen before any run, so a sample that
//     lands badly can never be rescued by moving the measurement point to a
//     later, warmer turn. The last node is always the last turn.
//   - capability envelope: the public web is not available in the acceptance
//     configuration, so `requiresWeb` is false and no turn depends on it.
//
// HOW THE TURNS ARE WRITTEN: every turn is one real user message of ONE session
// (feature request → run it → report what actually went wrong → ask for the next
// feature). The prompts never mention caching, tokens, measurement, compaction,
// budgets or how many turns are left; a prompt that reads like a test rig is a
// defect, not a stylistic choice.
//
// HOW THE SEEDED PROJECT IS SHAPED: a plain-Node expense/ledger CLI under
// `expenses/`, built up feature by feature. The seed runs (its own test file
// passes) and carries deliberate limitations (floating-point yuan amounts, no
// date handling at all); later turns fix those and the defects that the
// intermediate features leave behind. Acceptance checks are declared once and
// describe the final state, never an intermediate one.

export const LONG_INTERVAL_MANIFEST_VERSION = 1;

/** The business class of a long-interval task; one class, one task. */
export const LONG_INTERVAL_CLASS_ID = 'L';

export const LONG_INTERVAL_TASKS = Object.freeze([
  {
    id: 'L1',
    classId: 'L',
    title: '把一个记账小程序逐步做成可用工具',
    workspaceSeed: [
      {
        path: 'expenses/README.md',
        content: `# 记账小程序（expenses）

一个只用 Node 标准库的命令行记账工具，数据保存在 expenses/ledger.json。

## 现有命令

- node expenses/cli.mjs add <金额> <分类> [备注]：记一笔今天的支出。
- node expenses/cli.mjs list：按录入顺序列出全部记录。
- node expenses/cli.mjs total：打印全部支出的合计。

## 规则

1. 金额单位为元。
2. 分类是自定义文本，不做限制。
3. 每条记录包含金额、分类、备注和日期，按录入顺序保存。
4. 测试用 node expenses/test.mjs 运行。

## 已知问题

- 金额用小数直接相加，0.1 加 0.2 会得到 0.30000000000000004。
- 日期只能是今天，不能补录以前的账。
- 没有按月份筛选记录的能力。
- 记错了只能手工改 ledger.json，没有删除命令。
`,
      },
      {
        path: 'expenses/ledger.mjs',
        content: `// 账本读写与金额汇总。业务规则见 README.md。
import { readFileSync, writeFileSync } from 'node:fs';

export const DEFAULT_LEDGER_PATH = new URL('./ledger.json', import.meta.url);

export function loadLedger(path = DEFAULT_LEDGER_PATH) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function saveLedger(ledger, path = DEFAULT_LEDGER_PATH) {
  writeFileSync(path, JSON.stringify(ledger, null, 2));
  return ledger;
}

export function addEntry(ledger, entry) {
  ledger.entries.push(entry);
  return ledger;
}

export function listEntries(ledger) {
  return ledger.entries;
}

export function totalOf(entries) {
  return entries.reduce((sum, entry) => sum + entry.amount, 0);
}
`,
      },
      {
        path: 'expenses/cli.mjs',
        content: `// 记账命令行入口。用法见 README.md。
import { addEntry, listEntries, loadLedger, saveLedger, totalOf } from './ledger.mjs';

const [command, ...rest] = process.argv.slice(2);

function today() {
  return new Date().toISOString().slice(0, 10);
}

function usage() {
  console.log('用法：add <金额> <分类> [备注] | list | total');
}

if (command === 'add') {
  const amount = Number(rest[0]);
  const category = rest[1];
  const note = rest[2] ?? '';
  if (!Number.isFinite(amount) || amount <= 0 || !category) {
    console.error('金额必须是正数，分类不能为空');
    process.exitCode = 1;
  } else {
    const ledger = loadLedger();
    addEntry(ledger, { amount, category, note, date: today() });
    saveLedger(ledger);
    console.log('已记录 ' + amount.toFixed(2) + ' 元，分类 ' + category);
  }
} else if (command === 'list') {
  for (const entry of listEntries(loadLedger())) {
    console.log(entry.date + ' ' + entry.amount.toFixed(2) + ' ' + entry.category + ' ' + entry.note);
  }
} else if (command === 'total') {
  console.log(totalOf(loadLedger().entries).toFixed(2));
} else {
  usage();
  process.exitCode = 1;
}
`,
      },
      {
        path: 'expenses/test.mjs',
        content: `// 用 node expenses/test.mjs 运行。
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { addEntry, listEntries, loadLedger, saveLedger, totalOf } from './ledger.mjs';

function withTempLedger(body) {
  const dir = mkdtempSync(join(tmpdir(), 'expenses-'));
  try {
    body(join(dir, 'ledger.json'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('保存后能原样读回', () => {
  withTempLedger((path) => {
    saveLedger({ entries: [] }, path);
    assert.deepEqual(loadLedger(path), { entries: [] });
  });
});

test('addEntry 追加记录并保持录入顺序', () => {
  const ledger = { entries: [] };
  addEntry(ledger, { amount: 1.5, category: 'food', note: '午饭', date: '2026-08-15' });
  addEntry(ledger, { amount: 2.5, category: 'drink', note: '咖啡', date: '2026-08-15' });
  assert.equal(listEntries(ledger).length, 2);
  assert.equal(listEntries(ledger)[1].category, 'drink');
});

test('totalOf 累加全部金额', () => {
  assert.equal(totalOf([{ amount: 1.5 }, { amount: 2.25 }]), 3.75);
});
`,
      },
      {
        path: 'expenses/ledger.json',
        content: `{
  "entries": [
    { "amount": 12.5, "category": "food", "note": "午饭", "date": "2026-08-15" },
    { "amount": 3.2, "category": "drink", "note": "咖啡", "date": "2026-08-15" },
    { "amount": 88, "category": "food", "note": "聚餐", "date": "2026-09-02" }
  ]
}
`,
      },
    ],
    turns: [
      {
        prompt: '先读 expenses/README.md、expenses/ledger.mjs、expenses/cli.mjs 和 expenses/test.mjs，再运行 node expenses/test.mjs。然后告诉我这个工具现在能做什么，以及 README 里「已知问题」写的那几条是不是都还在。先不要改代码。',
      },
      {
        prompt: '金额现在用小数存，0.1 加 0.2 会算出 0.30000000000000004，看着很难受。请改成用整数分来存，展示的时候再转回元。账本里已有的数据也要能照常读出来，改完跑一遍测试。',
      },
      {
        prompt: '记账现在只能记今天，补录以前的账很麻烦。给 add 加一个 --date 选项，格式是 YYYY-MM-DD，不传就还是记今天。',
      },
      {
        prompt: '先跑一下测试，再用 add 记一笔 2026-08-15 的支出，然后 list 看看日期和金额显示得对不对。',
      },
      {
        prompt: '我试了 add --date 2026-13-40，它居然当成正常日期记进去了。请让它拒绝这种不存在的日期并给出提示，再补一个对应测试。',
      },
      {
        prompt: '记录一多就不好翻了。给 list 加一个 --month 选项，只列出指定月份的记录，比如 --month 2026-08。',
      },
      {
        prompt: '我用 --month 2026-08 过滤，结果 2026-09 的记录也混在里面了。请修掉这个问题，并且补一个跨月份的测试用例把它钉住。',
      },
      {
        prompt: '跑一遍测试确认全绿，然后把账本完整列出来给我看看现在有多少条、合计多少。',
      },
      {
        prompt: '我想知道钱主要花在哪一类上。加一个 summary 子命令，按分类汇总金额，从大到小排序，每行显示分类、合计和条数。',
      },
      {
        prompt: 'summary 里 food 和 Food 被拆成了两行，明明是一类。请把分类名统一按小写来汇总。',
      },
      {
        prompt: '现在只能看不能改。请给每条记录一个稳定的编号，list 每行把编号显示出来，再加一个 delete <编号> 子命令用来删除一条。账本里已有的记录按顺序补上编号就行，删除之后剩下的编号不要重排。',
      },
      {
        prompt: '删一笔再 list，确认编号没有跟着变；然后跑一遍测试。',
      },
      {
        prompt: 'add 现在只能带一个词的备注。请让备注支持带空格的一整句，比如「午饭 和 咖啡」要原样存进去。',
      },
      {
        prompt: '我记了一条备注是「午饭 和 咖啡」，读出来只剩「午饭」了。请修掉这个截断问题并补一个测试。',
      },
      {
        prompt: 'cli.mjs 里的参数解析越来越长了。请把参数解析抽到 expenses/args.mjs，cli.mjs 只保留命令分发，行为保持不变。',
      },
      {
        prompt: '抽完之后跑一遍测试，再手工走一遍 add、list、summary、delete，确认和之前的行为一样。',
      },
      {
        prompt: '记账的时候想顺手按分类看看。给 list 加一个 --category 选项，只看指定分类的记录。',
      },
      {
        prompt: '用 --category Food 过滤时一条都出不来，可 summary 里明明写的是 food。请让分类过滤和汇总的大小写口径保持一致。',
      },
      {
        prompt: '我想把账本导出去用表格软件打开。加一个 export 子命令，把全部记录按 CSV 打到标准输出，表头是 id,date,category,amount,note。',
      },
      {
        prompt: '备注里带逗号或者双引号的时候，导出的 CSV 列会串位。请按 CSV 的规则给字段加引号转义，再补一个带逗号和双引号的测试。',
      },
      {
        prompt: '我还想按时间段看账。给 list 加 --from 和 --to 两个选项，都是 YYYY-MM-DD，只列出这个区间内的记录，两端都算在内。',
      },
      {
        prompt: '如果 --from 比 --to 还晚，现在什么都不报就返回空列表了。请改成明确报错并给非零退出码，再补一个测试。',
      },
      {
        prompt: '金额格式化的 toFixed 现在散在好几个地方。请统一到一个函数里，只保留一处，其他地方都调它。',
      },
      {
        prompt: '请把 README 更新到现在的实际行为：删掉「已知问题」里已经解决的条目，写清楚金额按整数分存储，并补一节命令一览，把 add、list、total、summary、delete、export 以及 --date、--month、--category、--from、--to 都写进去，每行给一条可以直接照抄的完整命令。',
      },
      {
        prompt: '按 README 里的每条命令示例逐条跑一遍，看看和实际行为是否一致；不一致就改 README，改完告诉我哪里对不上。',
      },
      {
        prompt: '补一个空账本的测试：没有任何记录的时候，list、summary 和 export 都要能正常结束，退出码为 0。',
      },
      {
        prompt: '空账本时 summary 打印出来是 NaN，export 也少了一行表头。请修掉这两处，让空账本也能正常输出。',
      },
      {
        prompt: '最后做一次完整验收：跑 node expenses/test.mjs，再按 README 从头走一遍（记三笔、看汇总、导出 CSV），把每一步的实际输出贴给我确认。',
      },
    ],
    nodes: [
      {
        id: 'survey',
        turn: 1,
        label: '调查完成：说清现有命令、README 已知问题与测试状态',
      },
      {
        id: 'ledger-basics',
        turn: 8,
        label: '金额改为整数分、日期可指定且非法日期被拒、月份筛选正确，测试全绿',
      },
      {
        id: 'core-and-refactor',
        turn: 16,
        label: '分类汇总、稳定编号与删除、备注完整保留、参数模块抽取完成并回归通过',
      },
      {
        id: 'range-and-export',
        turn: 22,
        label: '分类过滤、CSV 导出与日期区间筛选可用，非法区间明确报错',
      },
      {
        id: 'docs-aligned',
        turn: 25,
        label: 'README 的每条命令示例都与命令行实际行为逐条对齐',
      },
      {
        id: 'final-verification',
        turn: 28,
        label: '自然完成：测试通过并按 README 走完整流程',
      },
    ],
    acceptance: [
      {
        kind: 'command',
        argv: ['node', 'expenses/test.mjs'],
        expectExitCode: 0,
        label: '最终测试脚本退出码为 0',
      },
      {
        kind: 'command',
        argv: ['node', 'expenses/cli.mjs', 'list'],
        expectExitCode: 0,
        label: '记账命令行的 list 子命令可正常结束',
      },
      {
        kind: 'command',
        argv: ['node', 'expenses/cli.mjs', 'export'],
        expectExitCode: 0,
        label: 'CSV 导出子命令可正常结束',
      },
      {
        kind: 'file_exists',
        path: 'expenses/args.mjs',
        label: '参数解析已抽到独立模块',
      },
      {
        kind: 'file_contains',
        path: 'expenses/README.md',
        text: '整数分',
        label: 'README 说明了金额按整数分存储',
      },
      {
        kind: 'file_contains',
        path: 'expenses/README.md',
        text: '--from',
        label: 'README 记录了日期区间选项 --from',
      },
    ],
    requiresWeb: false,
  },
].map((task) => deepFreeze(task)));

const ACCEPTANCE_KINDS = Object.freeze(['file_exists', 'file_contains', 'file_not_contains', 'command']);

/** Long-interval task ids keep the frozen `L` class letter plus a number. */
const TASK_ID_PATTERN = /^L[0-9]+$/;

const MIN_TURNS = 24;
const MAX_TURNS = 32;

const MIN_NODES = 4;

const MIN_SEED_FILES = 3;
const MAX_SEED_FILES = 8;
const SEED_CONTENT_LIMIT = 2000;

/** Characters that only mean something to cmd.exe / PowerShell / a shell. */
const SHELL_METACHARACTERS = /[&|<>^;`$"'%]/;

/**
 * A long-interval prompt must read like a real user message. Anything that
 * reveals the measurement rig (or counts the remaining work) is a defect.
 */
const FORBIDDEN_PROMPT_PATTERNS = Object.freeze([
  { pattern: /缓存|命中率|cache/i, reason: '不得提及缓存或命中率' },
  { pattern: /token/i, reason: '不得提及 token' },
  { pattern: /测量|指标|manifest|基准/i, reason: '不得提及测量口径' },
  { pattern: /契约|清单文件/, reason: '不得提及清单本身的实现' },
  { pattern: /回合|轮次|最后一轮|还剩/, reason: '不得提及回合编号或剩余条数' },
  { pattern: /预算额度|token 预算|budget/i, reason: '不得提及额度或预算口径' },
]);

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function quoted(value) {
  if (typeof value !== 'string') return String(value);
  return JSON.stringify(value.length > 48 ? `${value.slice(0, 48)}…` : value);
}

/** A workspace-relative path the driver can join onto the seeded workspace. */
function pathProblem(path) {
  if (!isNonEmptyString(path)) return '必须是非空字符串路径';
  if (path.includes('\\')) return '必须使用正斜杠（/）而不是反斜杠';
  if (path.startsWith('/')) return '必须是相对工作区的路径，不能以 / 开头';
  if (/^[A-Za-z]:/.test(path)) return '必须是相对工作区的路径，不能带盘符';
  if (path.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return '不能包含空目录段、. 或 ..';
  }
  return undefined;
}

function seedErrors(taskId, seed) {
  const errors = [];
  if (!Array.isArray(seed)) {
    errors.push(`${taskId}.workspaceSeed: 必须是数组（${MIN_SEED_FILES}-${MAX_SEED_FILES} 个小文件）`);
    return errors;
  }
  if (seed.length < MIN_SEED_FILES || seed.length > MAX_SEED_FILES) {
    errors.push(`${taskId}.workspaceSeed: 文件数必须在 ${MIN_SEED_FILES}-${MAX_SEED_FILES} 之间，当前 ${seed.length}`);
  }
  const seen = new Set();
  seed.forEach((file, index) => {
    const at = `${taskId}.workspaceSeed[${index}]`;
    if (!isPlainObject(file)) {
      errors.push(`${at}: 必须形如 { path, content }`);
      return;
    }
    const problem = pathProblem(file.path);
    if (problem) {
      errors.push(`${at}.path: ${problem}（当前 ${quoted(file.path)}）`);
    } else if (seen.has(file.path)) {
      errors.push(`${at}.path: 路径重复 ${quoted(file.path)}`);
    } else {
      seen.add(file.path);
    }
    if (typeof file.content !== 'string' || file.content === '') {
      errors.push(`${at}.content: 必须是非空字符串`);
    } else if (file.content.length >= SEED_CONTENT_LIMIT) {
      errors.push(`${at}.content: 必须小于 ${SEED_CONTENT_LIMIT} 字符，当前 ${file.content.length}`);
    }
  });
  return errors;
}

function promptErrors(at, prompt) {
  const errors = [];
  if (!isNonEmptyString(prompt)) return [`${at}.prompt: 必须是非空字符串`];
  for (const { pattern, reason } of FORBIDDEN_PROMPT_PATTERNS) {
    if (pattern.test(prompt)) errors.push(`${at}.prompt: ${reason}（当前 ${quoted(prompt)}）`);
  }
  return errors;
}

function turnErrors(taskId, turns) {
  const errors = [];
  if (!Array.isArray(turns)) {
    errors.push(`${taskId}.turns: 必须是数组（同一会话里 ${MIN_TURNS}-${MAX_TURNS} 条连续用户消息）`);
    return errors;
  }
  if (turns.length < MIN_TURNS || turns.length > MAX_TURNS) {
    errors.push(`${taskId}.turns: 条数必须在 ${MIN_TURNS}-${MAX_TURNS} 之间，当前 ${turns.length}`);
  }
  const seen = new Set();
  turns.forEach((turn, index) => {
    const at = `${taskId}.turns[${index}]`;
    if (!isPlainObject(turn)) {
      errors.push(`${at}: 必须形如 { prompt }`);
      return;
    }
    errors.push(...promptErrors(at, turn.prompt));
    if (typeof turn.prompt === 'string') {
      if (seen.has(turn.prompt)) errors.push(`${at}.prompt: 与同一任务的另一条提示重复`);
      seen.add(turn.prompt);
    }
  });
  return errors;
}

function nodeErrors(taskId, nodes, turnCount) {
  const errors = [];
  if (!Array.isArray(nodes)) {
    errors.push(`${taskId}.nodes: 必须是数组（至少 ${MIN_NODES} 个冻结业务节点）`);
    return errors;
  }
  if (nodes.length < MIN_NODES) {
    errors.push(`${taskId}.nodes: 节点数不能少于 ${MIN_NODES}，当前 ${nodes.length}`);
  }
  const seen = new Set();
  let previousTurn = 0;
  let completionNode = false;
  nodes.forEach((node, index) => {
    const at = `${taskId}.nodes[${index}]`;
    if (!isPlainObject(node)) {
      errors.push(`${at}: 必须形如 { id, turn, label }`);
      return;
    }
    if (!isNonEmptyString(node.id)) {
      errors.push(`${at}.id: 必须是非空字符串`);
    } else if (seen.has(node.id)) {
      errors.push(`${at}.id: 同一任务内节点 id 重复 ${quoted(node.id)}`);
    } else {
      seen.add(node.id);
    }
    if (!isNonEmptyString(node.label)) errors.push(`${at}.label: 必须是非空字符串`);
    if (!Number.isInteger(node.turn)) {
      errors.push(`${at}.turn: 必须是整数回合号`);
      return;
    }
    if (turnCount > 0 && (node.turn < 1 || node.turn > turnCount)) {
      errors.push(`${at}.turn: 必须在 1..${turnCount} 之间，当前 ${node.turn}`);
    }
    if (index > 0 && node.turn <= previousTurn) {
      errors.push(`${at}.turn: 节点回合必须严格递增（按数组顺序），当前 ${node.turn} 未大于前一个 ${previousTurn}`);
    }
    previousTurn = node.turn;
    if (turnCount > 0 && node.turn === turnCount) completionNode = true;
  });
  if (turnCount > 0 && nodes.length > 0 && !completionNode) {
    errors.push(`${taskId}.nodes: 必须有一个节点落在最后一个回合（第 ${turnCount} 回合，自然完成节点）`);
  }
  if (turnCount > 0 && nodes.length > 0 && isPlainObject(nodes.at(-1)) && nodes.at(-1).turn !== turnCount) {
    errors.push(`${taskId}.nodes: 最后一个节点必须落在最后一个回合（第 ${turnCount} 回合），当前 ${quoted(nodes.at(-1).turn)}`);
  }
  return errors;
}

function acceptanceErrors(taskId, acceptance) {
  const errors = [];
  if (!Array.isArray(acceptance) || acceptance.length === 0) {
    errors.push(`${taskId}.acceptance: 必须是非空数组`);
    return errors;
  }
  acceptance.forEach((check, index) => {
    const at = `${taskId}.acceptance[${index}]`;
    if (!isPlainObject(check)) {
      errors.push(`${at}: 必须是对象`);
      return;
    }
    if (!isNonEmptyString(check.label)) errors.push(`${at}.label: 必须有简短中文说明`);
    if (!ACCEPTANCE_KINDS.includes(check.kind)) {
      errors.push(`${at}.kind: 未知验收类型 ${quoted(check.kind)}；只允许 ${ACCEPTANCE_KINDS.join(' / ')}`);
      return;
    }
    if (check.kind === 'command') {
      if (!Array.isArray(check.argv) || check.argv.length === 0) {
        errors.push(`${at}.argv: 必须是非空参数数组`);
      } else {
        check.argv.forEach((argument, argumentIndex) => {
          if (!isNonEmptyString(argument)) {
            errors.push(`${at}.argv[${argumentIndex}]: 必须是非空字符串`);
            return;
          }
          if (SHELL_METACHARACTERS.test(argument)) {
            errors.push(`${at}.argv[${argumentIndex}]: 不能包含 shell 元字符（${quoted(argument)}）`);
          }
        });
        if (check.argv[0] !== 'node') {
          errors.push(`${at}.argv[0]: 必须是 node（Windows 上用普通 node 直接运行，不借 shell）`);
        }
      }
      if (!Number.isInteger(check.expectExitCode)) {
        errors.push(`${at}.expectExitCode: 必须是整数退出码`);
      }
      if (check.timeoutMs !== undefined
        && (!Number.isInteger(check.timeoutMs) || check.timeoutMs <= 0)) {
        errors.push(`${at}.timeoutMs: 可选的超时必须是正整数毫秒`);
      }
      return;
    }
    const problem = pathProblem(check.path);
    if (problem) errors.push(`${at}.path: ${problem}（当前 ${quoted(check.path)}）`);
    if (check.kind === 'file_contains' || check.kind === 'file_not_contains') {
      if (!isNonEmptyString(check.text)) errors.push(`${at}.text: 必须是非空字符串`);
    }
  });
  return errors;
}

function taskErrors(task, taskId, index) {
  const at = taskId ?? `#${index + 1}`;
  if (!isPlainObject(task)) return [`${at}: 任务必须是对象`];
  const errors = [];
  if (!isNonEmptyString(task.id) || !TASK_ID_PATTERN.test(task.id)) {
    errors.push(`${at}.id: 必须是长任务类别字母加数字（如 L1），当前 ${quoted(task.id)}`);
  }
  if (task.classId !== LONG_INTERVAL_CLASS_ID) {
    errors.push(`${at}.classId: 必须是 ${quoted(LONG_INTERVAL_CLASS_ID)}，当前 ${quoted(task.classId)}`);
  }
  if (!isNonEmptyString(task.title)) errors.push(`${at}.title: 必须是简短中文标题`);
  if (task.requiresWeb !== false) {
    errors.push(`${at}.requiresWeb: 必须显式为 false`
      + '（冻结配置里 web.enabled=false 且 web.providers=[]，任务不得依赖公共 Web）');
  }
  errors.push(...seedErrors(at, task.workspaceSeed));
  errors.push(...turnErrors(at, task.turns));
  const turnCount = Array.isArray(task.turns) ? task.turns.length : 0;
  errors.push(...nodeErrors(at, task.nodes, turnCount));
  errors.push(...acceptanceErrors(at, task.acceptance));
  return errors;
}

/** The long-interval set is exactly one task of class `L`. */
function coverageErrors(tasks) {
  const errors = [];
  const owned = tasks.filter((task) => isPlainObject(task) && task.classId === LONG_INTERVAL_CLASS_ID);
  if (owned.length !== 1) {
    errors.push(`manifest.classes: 类别 ${LONG_INTERVAL_CLASS_ID} 必须有 1 项任务，当前 ${owned.length}`);
  }
  return errors;
}

/**
 * Check the frozen long-interval manifest (or a caller-supplied slice of it).
 * Never throws: the result is always `{ ok, errors }`, and a broken task yields
 * the concrete reason prefixed with its id. Set-level coverage is judged when a
 * full-size list is passed, so a driver can still validate one task on its own.
 */
export function validateLongIntervalManifest(tasks = LONG_INTERVAL_TASKS) {
  if (!Array.isArray(tasks)) {
    return { ok: false, errors: ['manifest: 任务清单必须是数组'] };
  }
  if (tasks.length === 0) {
    return { ok: false, errors: ['manifest: 任务清单不能为空（至少要有 L1）'] };
  }
  const errors = [];
  const firstIndexById = new Map();
  tasks.forEach((task, index) => {
    const taskId = isPlainObject(task) && isNonEmptyString(task.id) ? task.id : undefined;
    errors.push(...taskErrors(task, taskId, index));
    if (!taskId) return;
    if (firstIndexById.has(taskId)) {
      errors.push(`${taskId}.id: 与第 ${firstIndexById.get(taskId)} 项任务重复，id 必须唯一`);
      return;
    }
    firstIndexById.set(taskId, index + 1);
  });
  if (tasks.length === LONG_INTERVAL_TASKS.length) errors.push(...coverageErrors(tasks));
  return { ok: errors.length === 0, errors };
}

/** Look one task up by id; an unknown id is a programming error, not a lookup miss. */
export function longIntervalTaskById(id) {
  const task = LONG_INTERVAL_TASKS.find((entry) => entry.id === id);
  if (!task) {
    const known = LONG_INTERVAL_TASKS.map((entry) => entry.id).join(', ');
    throw new Error(`未知的长间隔任务 id：${quoted(id)}；已知 id：${known}`);
  }
  return task;
}
