// Frozen manifest of the *real* long tasks used to judge the session-cumulative
// cache red line (acceptance "真实长任务现行红线", 2026-09-22; taskbook LT-00, retired
// 2026-09-24 — `git log --follow -- docs/taskbooks/real-long-task-cache-taskbook-2026-09-22.md`).
//
// The red line is the ratio the DeepSeek Harness front end shows for one session:
//
//   H_ui = Σ cacheRead / Σ (uncachedInput + cacheRead + cacheWrite)
//
// and it is judged on real long tasks, never on a pile of short Q&A. This module
// is the frozen workload: three business classes, two real tasks per class, each
// task run twice later (12+ runs), each run in its own fresh session.
//
// WHAT IS FROZEN HERE (and why re-deriving it later is a defect):
//   - provider/model: `deepseek` + `deepseek/deepseek-flash`, the accepted,
//     calibrated combination. No other model may be substituted inside the set.
//   - config freeze: maxModelCallsPerRun 32, contextCompressionThresholdRatio
//     0.8, and session compaction { threshold: 100, keepRecent: 20,
//     background: false }. These are the effective values of the acceptance data
//     root, read from the real configuration; the repository defaults differ
//     (compaction defaults to 400/200), so recomputing them at run time would
//     silently change the measured load.
//   - capability envelope: the public web capability is NOT available in the
//     frozen configuration (web.enabled = false, web.providers = []). No task may
//     require the public web, `requiresWeb` is asserted false for every task, and
//     nothing in this manifest pretends a web-backed task ever ran.
//   - the workload itself: seeded workspace files and their exact contents, the
//     consecutive user turns of one session, and the declarative acceptance
//     checks (counts, amounts and fixed phrases).
//
// WHY THE NODES ARE FROZEN BEFORE THE RUN:
//   `nodes` are the business milestones (调查 → 执行 → 验证 → 交付) at which the
//   cumulative H_ui is read, and `turn` is the 1-based turn whose completion
//   reaches that milestone. They are fixed here, before any run, so a sample that
//   lands below the red line can never be rescued by moving the measurement point
//   to a later, warmer turn. The node set always contains the natural completion
//   node (the last turn). `frozenPlanFor` hands the driver this exact plan; the
//   driver must not renumber, re-derive or reorder it.
//
// HOW THE RED LINE IS JUDGED: on the exact values reached at those nodes. The
// acceptance checks below are therefore exact-value checks, not prose: a count, an
// amount or a dictated phrase that a careless pass gets wrong (an extended due
// date ignored, a duplicated invoice counted twice, a session-only premise
// invented, a failing test "fixed" by rewriting the expected number). Restating a
// wrong number in a confident sentence is a failure, not a rounding difference.
//
// HOW THE TASKS RUN: inside an isolated LittleSheep data root whose default
// workspace is a temp directory. Each task seeds that workspace with the small
// files below, then the driver sends the turns as consecutive user messages of ONE
// session, so the cache prefix is reused the way a real session reuses it; no
// artificial warm-up, no filler context, no re-run until it passes.
//
// Recorded deviation, on purpose: `frozenPlanFor().model` is the frozen model ref
// `deepseek/deepseek-flash` itself (the provider id and the model id already form
// that one ref). Interpolating `${FROZEN_PROVIDER}/${FROZEN_MODEL}` would double
// the provider prefix and configure a model that does not exist.

export const MANIFEST_VERSION = 1;

export const FROZEN_PROVIDER = 'deepseek';

export const FROZEN_MODEL = 'deepseek/deepseek-flash';

export const FROZEN_CONFIG = Object.freeze({
  maxModelCallsPerRun: 32,
  contextCompressionThresholdRatio: 0.8,
  compaction: Object.freeze({ threshold: 100, keepRecent: 20, background: false }),
});

export const LONG_TASK_CLASSES = Object.freeze([
  {
    id: 'A',
    title: '多文件修改与验证',
    goal: '在多个源文件里定位真实缺陷，按业务规则修复并让测试通过，再补边界用例。',
  },
  {
    id: 'B',
    title: '多文件资料整理交付',
    goal: '把多份本地来源按冻结口径汇总成一份交付物，条数与金额必须与来源完全一致。',
  },
  {
    id: 'C',
    title: '记忆与本地来源结合的研究交付',
    goal: '先听懂并记住本轮口头给出的前提，再与本地材料结合完成研究并交付结论。',
  },
].map((entry) => Object.freeze(entry)));

export const REAL_LONG_TASKS = Object.freeze([
  {
    id: 'A1',
    classId: 'A',
    title: '修复购物车优惠券计税并补测试',
    workspaceSeed: [
      {
        path: 'README.md',
        content: `# 购物车结算规则

金额单位为元，保留两位小数。

1. 小计 = 各商品（单价 × 数量）之和。
2. 满 100 元减 15 元：优惠券在小计上扣减，扣减后的小计不得为负。
3. 税费按 8% 计算，必须按扣券后的小计计税。
4. 最终应付 = 扣券后小计 × 1.08，四舍五入到分。

test/cart.test.mjs 里的期望值是需求方给出的验收数字，不要改动。
`,
      },
      {
        path: 'src/cart.mjs',
        content: `// 购物车金额计算。业务规则见 README.md。
const TAX_RATE = 0.08;
const COUPON_MIN_SUBTOTAL = 100;
const COUPON_AMOUNT = 15;

export function round2(value) {
  return Math.round(value * 100) / 100;
}

export function subtotalOf(items) {
  return round2(items.reduce((sum, item) => sum + item.price * item.quantity, 0));
}

export function couponFor(subtotal) {
  return subtotal >= COUPON_MIN_SUBTOTAL ? COUPON_AMOUNT : 0;
}

export function cartTotal(items) {
  const subtotal = subtotalOf(items);
  const taxed = round2(subtotal * (1 + TAX_RATE));
  return round2(taxed - couponFor(subtotal));
}
`,
      },
      {
        path: 'test/cart.test.mjs',
        content: `import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cartTotal, couponFor, subtotalOf } from '../src/cart.mjs';

// 需求方给出的验收数字，不得改写。
const EXPECTED_TOTAL_WITHOUT_COUPON = 43.2;
const EXPECTED_TOTAL_WITH_COUPON = 113.4;

test('不满 100 元只计税', () => {
  const items = [{ price: 20, quantity: 2 }];
  assert.equal(subtotalOf(items), 40);
  assert.equal(couponFor(40), 0);
  assert.equal(cartTotal(items), EXPECTED_TOTAL_WITHOUT_COUPON);
});

test('满 100 元按扣券后小计计税', () => {
  const items = [{ price: 60, quantity: 2 }];
  assert.equal(subtotalOf(items), 120);
  assert.equal(couponFor(120), 15);
  assert.equal(cartTotal(items), EXPECTED_TOTAL_WITH_COUPON);
});

test('空购物车为 0', () => {
  assert.equal(cartTotal([]), 0);
});
`,
      },
    ],
    turns: [
      {
        prompt: '先读懂 src/cart.mjs 和 test/cart.test.mjs，再对照 README.md 的结算规则，告诉我优惠券是在税前还是税后扣减的，以及哪个用例会失败。先不要改代码。',
      },
      {
        prompt: '按 README.md 的规则修好它，然后运行测试确认全部通过，并说明你改了哪里。',
      },
      {
        prompt: '再补一个刚好达到满减门槛的用例，把期望值算清楚，然后重新运行测试。',
      },
    ],
    nodes: [
      { id: 'diagnosis', turn: 1, label: '调查完成：说清优惠券在税前还是税后扣减，并指出失败的用例' },
      { id: 'fix', turn: 2, label: '执行完成：按规则修复且原有测试全部通过' },
      { id: 'boundary', turn: 3, label: '自然完成：补上满减门槛用例并复跑通过' },
    ],
    acceptance: [
      {
        kind: 'command',
        argv: ['node', 'test/cart.test.mjs'],
        expectExitCode: 0,
        label: '修复后测试脚本退出码为 0',
      },
      {
        kind: 'file_contains',
        path: 'test/cart.test.mjs',
        text: 'EXPECTED_TOTAL_WITH_COUPON = 113.4',
        label: '需求方给出的 113.4 期望值仍然在测试里',
      },
      {
        kind: 'file_contains',
        path: 'src/cart.mjs',
        text: 'export function cartTotal',
        label: '金额计算仍由 src/cart.mjs 提供',
      },
    ],
    requiresWeb: false,
  },
  {
    id: 'A2',
    classId: 'A',
    title: '修复库存预留与订单取消并补测试',
    workspaceSeed: [
      {
        path: 'README.md',
        content: `# 库存预留模块

src/stock.mjs 在内存里维护预留量，src/order.mjs 负责下单与取消。

业务规则：

1. 同一 SKU 的多次预留累加，可用量 = 现货 − 已预留。
2. 预留超过现货时必须抛错，并且不得改变已预留量。
3. 取消订单只释放该订单占用的数量；释放量超过该 SKU 当前预留量时必须抛错，不得把预留量压成负数。
4. 同一订单重复取消必须幂等：第二次取消不得再释放任何库存。
5. 测试用 node --test 运行；期望值是需求方给出的验收数字，不要改动。
`,
      },
      {
        path: 'src/stock.mjs',
        content: `// 预留量账本。业务规则见 README.md。
const reservations = new Map();

export function reservedOf(sku) {
  return reservations.get(sku) ?? 0;
}

export function available(onHand, sku) {
  return onHand - reservedOf(sku);
}

export function reserve(sku, quantity, onHand) {
  const next = reservedOf(sku) + quantity;
  if (next > onHand) {
    throw new Error('库存不足：' + sku);
  }
  reservations.set(sku, next);
  return next;
}

export function release(sku, quantity) {
  const next = Math.max(0, reservedOf(sku) - quantity);
  reservations.set(sku, next);
  return next;
}

export function resetReservations() {
  reservations.clear();
}
`,
      },
      {
        path: 'src/order.mjs',
        content: `import { release, reserve } from './stock.mjs';

export function placeOrder(orderId, lines, onHandBySku) {
  const order = { orderId, lines: [] };
  for (const line of lines) {
    reserve(line.sku, line.quantity, onHandBySku[line.sku]);
    order.lines.push({ sku: line.sku, quantity: line.quantity });
  }
  return order;
}

export function cancelOrder(order) {
  for (const line of order.lines) {
    release(line.sku, line.quantity);
  }
  return order;
}
`,
      },
      {
        path: 'test/stock.test.mjs',
        content: `import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cancelOrder, placeOrder } from '../src/order.mjs';
import { available, release, reservedOf, resetReservations } from '../src/stock.mjs';

// 需求方给出的验收数字，不得改写。
const EXPECTED_RESERVED_AFTER_DOUBLE_CANCEL = 2;

test('同一 SKU 的预留累加，可用量随之减少', () => {
  resetReservations();
  const onHand = { A: 10 };
  placeOrder('O-1', [{ sku: 'A', quantity: 3 }], onHand);
  assert.equal(reservedOf('A'), 3);
  assert.equal(available(10, 'A'), 7);
  placeOrder('O-2', [{ sku: 'A', quantity: 2 }], onHand);
  assert.equal(reservedOf('A'), 5);
});

test('预留超过现货会被拒绝，且不改变已预留量', () => {
  resetReservations();
  assert.throws(() => placeOrder('O-3', [{ sku: 'A', quantity: 4 }], { A: 3 }));
  assert.equal(reservedOf('A'), 0);
});

test('重复取消同一订单不得释放其它订单的预留', () => {
  resetReservations();
  const onHand = { A: 10 };
  const first = placeOrder('O-4', [{ sku: 'A', quantity: 3 }], onHand);
  placeOrder('O-5', [{ sku: 'A', quantity: 2 }], onHand);
  cancelOrder(first);
  assert.equal(reservedOf('A'), 2);
  cancelOrder(first);
  assert.equal(reservedOf('A'), EXPECTED_RESERVED_AFTER_DOUBLE_CANCEL);
  // 规则 3：释放量超过当前预留量必须抛错，不能悄悄压成负数。
  assert.throws(() => release('A', 5));
});

test('空行项目下单不占用库存', () => {
  resetReservations();
  placeOrder('O-6', [], {});
  assert.equal(reservedOf('A'), 0);
});
`,
      },
    ],
    turns: [
      {
        prompt: '先读懂 src/stock.mjs、src/order.mjs 和 test/stock.test.mjs，对照 README.md 的规则告诉我失败的用例为什么会失败。先不要改代码。',
      },
      {
        prompt: '按 README.md 的规则修好它，运行测试确认全部通过，并说明改了哪些文件。',
      },
      {
        prompt: '再补一个“取消一次释放量刚好等于该订单预留量”的边界用例，重新运行测试。',
      },
    ],
    nodes: [
      { id: 'diagnosis', turn: 1, label: '调查完成：说清重复取消与释放越界两处不符合规则的地方' },
      { id: 'fix', turn: 2, label: '执行完成：两个模块按规则修好且测试全部通过' },
      { id: 'boundary', turn: 3, label: '自然完成：补上释放边界用例并复跑通过' },
    ],
    acceptance: [
      {
        kind: 'command',
        argv: ['node', '--test'],
        expectExitCode: 0,
        label: '测试运行器退出码为 0',
      },
      {
        kind: 'file_contains',
        path: 'test/stock.test.mjs',
        text: 'EXPECTED_RESERVED_AFTER_DOUBLE_CANCEL = 2',
        label: '需求方给出的 2 件期望值仍然在测试里',
      },
      {
        kind: 'file_contains',
        path: 'src/stock.mjs',
        text: 'export function release',
        label: '释放语义仍由 src/stock.mjs 提供',
      },
      {
        kind: 'file_exists',
        path: 'src/order.mjs',
        label: '订单模块仍然保留',
      },
    ],
    requiresWeb: false,
  },
  {
    id: 'B1',
    classId: 'B',
    title: '汇总逾期工单并交付逾期清单',
    workspaceSeed: [
      {
        path: 'data/policy.md',
        content: `# 本批次工单统计口径（2026-09-22 定稿）

1. 统计基准日就是定稿日 2026-09-22：截止日期早于该日算已到期，当天到期的按未到期处理。
2. 状态 closed 或 cancelled 的工单不再计入逾期；open 和 blocked 都算未关闭。
3. 截止日期缺失、或不是 YYYY-MM-DD 格式的工单不计入逾期，但必须作为数据问题列出。
4. notes/handover.md 里登记的新工单（编号以 T- 开头）同样属于本批次；同一编号在两处出现时，以 handover 里的延期说明为准。
5. 同一编号重复登记时只算一次；重复登记本身记为一条数据问题。
6. 逾期条数与数据问题条数都必须与来源完全一致，不接受估计或约等于。
`,
      },
      {
        path: 'data/tickets.csv',
        content: `id,title,owner,due,status
T-1001,同步供应商对账单,林岚,2026-08-30,open
T-1002,补录二月考勤,赵青,2026-09-19,open
T-1003,更换会议室投影灯泡,周衡,2026-09-25,open
T-1003,更换会议室投影灯泡,周衡,2026-09-25,open
T-1004,更新门禁白名单,赵青,2026-09-10,closed
T-1005,归档旧版合同,林岚,,open
T-1006,清理测试环境账号,周衡,2026-09-18,open
T-1007,补交消防演练记录,林岚,2026-09-12,open
T-1008,核对水电费账单,赵青,2026/09/15,open
T-1009,回复审计问询,周衡,2026-09-20,blocked
T-1010,整理季度培训材料,林岚,2026-09-21,open
T-1011,更新应急预案联系人,赵青,2026-09-22,open
T-1012,退租旧仓库钥匙,周衡,2026-09-05,cancelled
T-1013,迁移旧邮件归档,林岚,2026-09-14,cancelled
T-1014,核对差旅报销单,赵青,2026-09-16,open
`,
      },
      {
        path: 'notes/handover.md',
        content: `# 值班交接备注（2026-09-21 夜班，林岚）

- T-1007 补交消防演练记录：负责人反馈消防演练推迟到十月，截止日期同意延至 2026-10-06，不要再按逾期催办。
- T-1002 补录二月考勤：已与人事确认，截止日期维持 2026-09-19，没有变化。
- 新增工单 T-1021：补签年度保密协议，负责人赵青，截止日期 2026-09-08，状态 open，还没登记进 tickets.csv。
`,
      },
    ],
    turns: [
      {
        prompt: '先读 data/policy.md、data/tickets.csv 和 notes/handover.md，按 policy 里的口径告诉我：现在有几条逾期、有几条记录本身有问题。先不要写文件。',
      },
      {
        prompt: '按这个口径整理成 report/overdue.md：第一行写 逾期工单数：N；接着 ## 逾期清单，每行写 - 编号；再接着 ## 数据问题，每行写 - 编号 说明；最后一行写 数据问题：N。',
      },
      {
        prompt: '再把来源和报告对照一遍，确认两个数字与来源完全一致，有不一致就改掉报告，然后把最终数字告诉我。',
      },
    ],
    nodes: [
      { id: 'counts', turn: 1, label: '调查完成：说出逾期条数与数据问题条数' },
      { id: 'delivery', turn: 2, label: '执行完成：report/overdue.md 落盘且清单与数字齐全' },
      { id: 'reconciliation', turn: 3, label: '自然完成：报告与全部来源逐条核对一致' },
    ],
    acceptance: [
      { kind: 'file_exists', path: 'report/overdue.md', label: '逾期报告已交付' },
      {
        kind: 'file_contains',
        path: 'report/overdue.md',
        text: '逾期工单数：7',
        label: '逾期条数为 7（延期与当天到期都不计入）',
      },
      {
        kind: 'file_contains',
        path: 'report/overdue.md',
        text: '- T-1021',
        label: '交接备注里新增的 T-1021 也计入了',
      },
      {
        kind: 'file_contains',
        path: 'report/overdue.md',
        text: '- T-1009',
        label: 'blocked 状态仍算未关闭，T-1009 计入',
      },
      {
        kind: 'file_contains',
        path: 'report/overdue.md',
        text: '数据问题：3',
        label: '数据问题恰好 3 条',
      },
      {
        kind: 'file_contains',
        path: 'report/overdue.md',
        text: '- T-1005',
        label: '缺截止日期的 T-1005 作为数据问题列出',
      },
    ],
    requiresWeb: false,
  },
  {
    id: 'B2',
    classId: 'B',
    title: '核对供应商发票差异并交付对账报告',
    workspaceSeed: [
      {
        path: 'data/rules.md',
        content: `# 2026-07 批次供应商对账口径

1. 差异 = 订单金额 − 发票金额 − 红字通知单金额；红字通知单见 data/credit-notes.md。
2. 差异为 0 的订单视为已平，不计入差异笔数，也不计入差异合计。
3. 差异笔数 = 差异不为 0 的订单数，同一订单只算一次。
4. 差异合计 = 各订单差异金额的绝对值之和，单位元，必须是整数。
5. 本批次每张订单最多对应一张发票：同一订单出现多条发票记录时，该订单整体按数据问题列出，不计入差异。
6. 发票指向 orders.csv 里不存在的订单时，该发票按数据问题列出，不计入差异。
7. 两个数字都必须与来源完全一致，不接受估计或约等于。
`,
      },
      {
        path: 'data/orders.csv',
        content: `orderId,supplier,amountYuan,orderedOn
SO-2001,青禾包装,4200,2026-07-03
SO-2002,青禾包装,1800,2026-07-05
SO-2003,远山纸业,2600,2026-07-06
SO-2004,远山纸业,6400,2026-07-08
SO-2005,青禾包装,950,2026-07-09
SO-2006,蓝湾物流,3300,2026-07-10
SO-2007,远山纸业,2750,2026-07-12
SO-2008,蓝湾物流,1200,2026-07-14
SO-2009,青禾包装,5400,2026-07-15
SO-2010,蓝湾物流,880,2026-07-16
`,
      },
      {
        path: 'data/invoices.json',
        content: `{
  "batch": "2026-07",
  "invoices": [
    { "invoiceId": "INV-2001", "orderId": "SO-2001", "amountYuan": 4700 },
    { "invoiceId": "INV-2002", "orderId": "SO-2002", "amountYuan": 1800 },
    { "invoiceId": "INV-2003", "orderId": "SO-2003", "amountYuan": 2000 },
    { "invoiceId": "INV-2004", "orderId": "SO-2004", "amountYuan": 6400 },
    { "invoiceId": "INV-2005", "orderId": "SO-2005", "amountYuan": 830 },
    { "invoiceId": "INV-2006", "orderId": "SO-2006", "amountYuan": 3200 },
    { "invoiceId": "INV-2007", "orderId": "SO-2007", "amountYuan": 2750 },
    { "invoiceId": "INV-2008", "orderId": "SO-2008", "amountYuan": 1520 },
    { "invoiceId": "INV-2009", "orderId": "SO-2009", "amountYuan": 5400 },
    { "invoiceId": "INV-2010", "orderId": "SO-2009", "amountYuan": 5400 },
    { "invoiceId": "INV-2011", "orderId": "SO-2010", "amountYuan": 640 },
    { "invoiceId": "INV-2012", "orderId": "SO-2099", "amountYuan": 1100 }
  ]
}
`,
      },
      {
        path: 'data/credit-notes.md',
        content: `# 2026-07 批次红字通知单

- CN-01：对应订单 SO-2003，冲减 600 元，原因到货破损扣款，双方已确认。
`,
      },
    ],
    turns: [
      {
        prompt: '先读 data/rules.md、data/orders.csv、data/invoices.json 和 data/credit-notes.md，按 rules 的口径告诉我差异有几笔、合计多少元。先不要写文件。',
      },
      {
        prompt: '交付 report/reconcile.md，按这个格式：第一行写 差异笔数：N；接着 ## 差异明细，每行写 - 订单号 差异金额；再接着 ## 数据问题，每行写 - 编号 说明；最后三行依次写 数据问题：N、差异合计：<金额> 元、红字通知单：<编号>。',
      },
      {
        prompt: '再对照一遍来源：重复的发票记录和找不到对应订单的发票都要算数据问题，确认这两个数字没有被它们带偏，然后复述最终的差异笔数和合计。',
      },
    ],
    nodes: [
      { id: 'counts', turn: 1, label: '调查完成：说出差异笔数、合计金额与数据问题' },
      { id: 'delivery', turn: 2, label: '执行完成：report/reconcile.md 落盘且明细、数据问题与红字通知单齐全' },
      { id: 'reconciliation', turn: 3, label: '自然完成：重复发票与孤儿发票已排除在金额之外并复述一致' },
    ],
    acceptance: [
      { kind: 'file_exists', path: 'report/reconcile.md', label: '对账报告已交付' },
      {
        kind: 'file_contains',
        path: 'report/reconcile.md',
        text: '差异笔数：5',
        label: '差异恰好 5 笔',
      },
      {
        kind: 'file_contains',
        path: 'report/reconcile.md',
        text: '差异合计：1280',
        label: '差异合计为 1280 元（绝对值之和）',
      },
      {
        kind: 'file_contains',
        path: 'report/reconcile.md',
        text: '红字通知单：CN-01',
        label: '红字通知单 CN-01 已登记',
      },
      {
        kind: 'file_contains',
        path: 'report/reconcile.md',
        text: 'INV-2012',
        label: '找不到订单的发票 INV-2012 作为数据问题列出',
      },
      {
        kind: 'file_contains',
        path: 'report/reconcile.md',
        text: '数据问题：2',
        label: '数据问题恰好 2 条',
      },
    ],
    requiresWeb: false,
  },
  {
    id: 'C1',
    classId: 'C',
    title: '结合供应商材料与口头前提完成选型评审',
    workspaceSeed: [
      {
        path: 'notes/constraints.md',
        content: `# 立项约束（2026-09-22 评审会确定）

1. 运维期不短于 2 年：报价里只含 1 年运维的，按再付 1 年运维费计算总价。
2. 必须支持本地部署；只提供公有云（SaaS）的方案不参与本轮评审。
3. 总价 = 报价 + 运维费 × 需要补足的运维年数。
4. 预算比较一律用折后总价：折后总价 = 总价 × (1 − 折扣率)；折扣率由需求方在评审时口头给出，不写进本文件。
5. 交付周期超过 10 周的方案需要二次评审，但这不是淘汰条件。
6. 只有同时满足 1、2 且折后总价不超过预算上限的方案才算可行。
`,
      },
      {
        path: 'notes/vendor-a.md',
        content: `# 供应商 A（青禾系统）

- 报价：52000 元
- 运维：6000 元/年，报价含 1 年
- 部署：支持本地部署，已在两家子公司上线
- 交付周期：8 周
- 备注：接口文档齐全，联调大约需要 2 周
`,
      },
      {
        path: 'notes/vendor-b.md',
        content: `# 供应商 B（远山云）

- 报价：88000 元
- 运维：不收运维费，报价含 3 年
- 部署：仅公有云 SaaS，不提供本地部署
- 交付周期：4 周
- 备注：迁移工具成熟，但数据必须放在供应商机房
`,
      },
      {
        path: 'notes/vendor-c.md',
        content: `# 供应商 C（蓝湾信息）

- 报价：96000 元
- 运维：4000 元/年，报价含 1 年
- 部署：支持本地部署
- 交付周期：12 周
- 备注：交付周期偏长，需要二次评审
`,
      },
    ],
    turns: [
      {
        prompt: '先记住两个前提：这次预算上限是 86000 元，供应商折扣按 12% 算，后面的交付要用到。然后读 notes/constraints.md 和三份供应商材料，告诉我哪些方案不可行、各卡在哪一条。先不要写文件。',
      },
      {
        prompt: '交付 report/plan-review.md：第一行写 可行方案数：N；接着 ## 可行方案，每行写 - 供应商 <字母> <折后总价>；再接着 ## 不可行，每行写 - 供应商 <字母> <原因>。',
      },
      {
        prompt: '最后补一节 ## 前提，把我在开头给你的两个前提按 预算上限：<金额> 元 和 折扣率：<百分比> 两行写进去，再写一行 剩余额度：<金额> 元，说明可行方案离预算上限还剩多少。',
      },
    ],
    nodes: [
      { id: 'screening', turn: 1, label: '调查完成：说出三家方案的淘汰原因' },
      { id: 'delivery', turn: 2, label: '执行完成：可行方案与折后总价写入报告' },
      { id: 'memory-anchor', turn: 3, label: '自然完成：报告写入本轮口头给出的预算与折扣并算出剩余额度' },
    ],
    acceptance: [
      { kind: 'file_exists', path: 'report/plan-review.md', label: '选型评审报告已交付' },
      {
        kind: 'file_contains',
        path: 'report/plan-review.md',
        text: '可行方案数：1',
        label: '只有供应商 A 可行',
      },
      {
        kind: 'file_contains',
        path: 'report/plan-review.md',
        text: '- 供应商 A 51040',
        label: 'A 的折后总价 51040 元（52000 + 6000 再打 88 折）',
      },
      {
        kind: 'file_contains',
        path: 'report/plan-review.md',
        text: '预算上限：86000',
        label: '报告写入了本轮口头给出的预算上限',
      },
      {
        kind: 'file_contains',
        path: 'report/plan-review.md',
        text: '折扣率：12',
        label: '报告写入了本轮口头给出的折扣率',
      },
      {
        kind: 'file_contains',
        path: 'report/plan-review.md',
        text: '剩余额度：34960',
        label: '剩余额度 86000 − 51040 = 34960 元',
      },
    ],
    requiresWeb: false,
  },
  {
    id: 'C2',
    classId: 'C',
    title: '结合故障材料与口头前提完成复盘交付',
    workspaceSeed: [
      {
        path: 'notes/README.md',
        content: `# 网关故障材料说明（2026-09-22 整理）

- 本目录三份材料都来自 2026-09-18 的网关故障，口径并不完全一致。
- 权威时间线以 notes/gateway-log.md（监控系统原始日志）为准，其他材料只作对照。
- 同一事实项在不同材料里取值不一致时记为一条矛盾；时间类事实相差超过 2 分钟才算不一致，相差 2 分钟以内视为记录误差，不计矛盾。
- 矛盾条数按事实项计数：同一事实项在多份材料里不一致时只计一条。
- 对外口径由需求方口头给出，不写进本目录。
`,
      },
      {
        path: 'notes/gateway-log.md',
        content: `# 监控系统原始日志（网关 GW-3）

2026-09-18
- 09:41 网关 GW-3 连接重置率突升到 12%
- 09:43 自动扩容未触发，人工介入处理
- 10:07 连接重置率回落到 0.2%，服务恢复
- 10:20 值班确认告警解除

根因记录：配置推送后连接重置，回滚配置后恢复。
`,
      },
      {
        path: 'notes/ticket.md',
        content: `# 故障工单 WO-3182

- 报障时间：2026-09-18 09:40（客服转入）
- 恢复时间：2026-09-18 10:12（业务方确认）
- 影响面：约 2800 次请求失败，无数据丢失
- 根因：计划内配置变更引发连接重置，变更编号待回填
- 处理人：周衡
`,
      },
      {
        path: 'notes/vendor-statement.md',
        content: `# 供应商说明（远山云，2026-09-19）

- 开始时间：2026-09-18 09:20
- 恢复时间：2026-09-18 10:30
- 根因：机房侧网络抖动，与贵方的配置变更无关
- 建议：后续变更尽量避开业务高峰
`,
      },
    ],
    turns: [
      {
        prompt: '先记住两件事，后面交付要用到：这次网关故障是我们自己的计划内配置变更引起的，变更单编号 CHG-2291，不是供应商机房的问题；对外统一口径是「计划内变更引发的短时抖动」。然后读 notes/README.md、notes/gateway-log.md、notes/ticket.md 和 notes/vendor-statement.md，按 README 的口径告诉我几份材料之间有几条矛盾、分别是什么。先不要写文件。',
      },
      {
        prompt: '交付 report/incident-timeline.md：第一行写 矛盾条数：N；接着 ## 时间线，每行写 - <时间> <事件>，事件用监控日志的原文；再接着 ## 矛盾，每行写 - <事实项> <各材料的取值>。',
      },
      {
        prompt: '最后补一节 ## 对外口径，第一行写 变更单：<编号>，第二行写 口径：<原文>，用我开头告诉你的编号和原话，并指出哪份材料的说法和这个口径冲突。',
      },
    ],
    nodes: [
      { id: 'contradictions', turn: 1, label: '调查完成：说出矛盾条数与逐条内容' },
      { id: 'timeline', turn: 2, label: '执行完成：权威时间线与矛盾写入报告' },
      { id: 'disclosure', turn: 3, label: '自然完成：对外口径写入本轮口头给出的变更单编号与原话' },
    ],
    acceptance: [
      { kind: 'file_exists', path: 'report/incident-timeline.md', label: '故障复盘报告已交付' },
      {
        kind: 'file_contains',
        path: 'report/incident-timeline.md',
        text: '矛盾条数：3',
        label: '矛盾恰好 3 条（1 分钟的记录误差不算）',
      },
      {
        kind: 'file_contains',
        path: 'report/incident-timeline.md',
        text: '- 09:41',
        label: '时间线采用监控日志的 09:41',
      },
      {
        kind: 'file_contains',
        path: 'report/incident-timeline.md',
        text: '- 10:07',
        label: '时间线采用监控日志的 10:07 恢复时间',
      },
      {
        kind: 'file_contains',
        path: 'report/incident-timeline.md',
        text: '变更单：CHG-2291',
        label: '变更单编号来自本轮口头说明',
      },
      {
        kind: 'file_contains',
        path: 'report/incident-timeline.md',
        text: '口径：计划内变更引发的短时抖动',
        label: '对外口径与本轮口头原话一致',
      },
    ],
    requiresWeb: false,
  },
].map((task) => deepFreeze(task)));

const ACCEPTANCE_KINDS = Object.freeze(['file_exists', 'file_contains', 'file_not_contains', 'command']);

const ID_PATTERN = /^[A-Z][0-9]+$/;

/** Characters that only mean something to cmd.exe / PowerShell / a shell. */
const SHELL_METACHARACTERS = /[&|<>^;`$"'%]/;

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
    errors.push(`${taskId}.workspaceSeed: 必须是数组（2-6 个小文件）`);
    return errors;
  }
  if (seed.length < 2 || seed.length > 6) {
    errors.push(`${taskId}.workspaceSeed: 文件数必须在 2-6 之间，当前 ${seed.length}`);
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
    } else if (file.content.length >= 2000) {
      errors.push(`${at}.content: 必须小于 2000 字符，当前 ${file.content.length}`);
    }
  });
  return errors;
}

function turnErrors(taskId, turns) {
  const errors = [];
  if (!Array.isArray(turns)) {
    errors.push(`${taskId}.turns: 必须是数组（同一会话里 2-4 条连续用户消息）`);
    return errors;
  }
  if (turns.length < 2 || turns.length > 4) {
    errors.push(`${taskId}.turns: 条数必须在 2-4 之间，当前 ${turns.length}`);
  }
  const seen = new Set();
  turns.forEach((turn, index) => {
    const at = `${taskId}.turns[${index}]`;
    if (!isPlainObject(turn)) {
      errors.push(`${at}: 必须形如 { prompt }`);
      return;
    }
    if (!isNonEmptyString(turn.prompt)) {
      errors.push(`${at}.prompt: 必须是非空字符串`);
      return;
    }
    if (seen.has(turn.prompt)) errors.push(`${at}.prompt: 与同一任务的另一条提示重复`);
    seen.add(turn.prompt);
  });
  return errors;
}

function nodeErrors(taskId, nodes, turnCount) {
  const errors = [];
  if (!Array.isArray(nodes)) {
    errors.push(`${taskId}.nodes: 必须是数组（1-3 个冻结业务节点）`);
    return errors;
  }
  if (nodes.length < 1 || nodes.length > 3) {
    errors.push(`${taskId}.nodes: 节点数必须在 1-3 之间，当前 ${nodes.length}`);
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
    if (node.turn < previousTurn) {
      errors.push(`${at}.turn: 节点回合必须递增或相等（按数组顺序），当前 ${node.turn} 小于前一个 ${previousTurn}`);
    }
    previousTurn = node.turn;
    if (turnCount > 0 && node.turn === turnCount) completionNode = true;
  });
  if (turnCount > 0 && nodes.length > 0 && !completionNode) {
    errors.push(`${taskId}.nodes: 必须有一个节点落在最后一个回合（第 ${turnCount} 回合，自然完成节点）`);
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
  if (!isNonEmptyString(task.id) || !ID_PATTERN.test(task.id)) {
    errors.push(`${at}.id: 必须是业务类别字母加数字（如 A1），当前 ${quoted(task.id)}`);
  }
  const classIds = LONG_TASK_CLASSES.map((entry) => entry.id);
  if (!classIds.includes(task.classId)) {
    errors.push(`${at}.classId: 未知业务类别 ${quoted(task.classId)}；已知类别 ${classIds.join(' / ')}`);
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

/** Every class must carry exactly two real tasks (3 classes × 2 = 6 runs × 2 rounds). */
function coverageErrors(tasks) {
  const errors = [];
  for (const businessClass of LONG_TASK_CLASSES) {
    const owned = tasks.filter((task) => isPlainObject(task) && task.classId === businessClass.id);
    if (owned.length !== 2) {
      errors.push(`manifest.classes: 类别 ${businessClass.id}（${businessClass.title}）`
        + `必须有 2 项任务，当前 ${owned.length}`);
    }
  }
  if (tasks.length !== LONG_TASK_CLASSES.length * 2) {
    errors.push(`manifest: 必须共 ${LONG_TASK_CLASSES.length * 2} 项任务（每类 2 项），当前 ${tasks.length}`);
  }
  return errors;
}

/**
 * Check the frozen manifest (or a caller-supplied slice of it). Never throws: the
 * result is always `{ ok, errors }`, and a broken task yields the concrete reason
 * prefixed with its id. Set-level coverage is judged when a full-size list is
 * passed, so a driver can still validate a single task on its own.
 */
export function validateManifest(tasks = REAL_LONG_TASKS) {
  if (!Array.isArray(tasks)) {
    return { ok: false, errors: ['manifest: 任务清单必须是数组'] };
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
  if (tasks.length === REAL_LONG_TASKS.length) errors.push(...coverageErrors(tasks));
  return { ok: errors.length === 0, errors };
}

/** Look one task up by id; an unknown id is a programming error, not a lookup miss. */
export function longTaskById(id) {
  const task = REAL_LONG_TASKS.find((entry) => entry.id === id);
  if (!task) {
    const known = REAL_LONG_TASKS.map((entry) => entry.id).join(', ');
    throw new Error(`未知的长任务 id：${quoted(id)}；已知 id：${known}`);
  }
  return task;
}

/**
 * Project one frozen task into the driver plan. Every array and object is copied
 * (argv included), so a driver that annotates the plan cannot mutate the frozen
 * set; `config` is the shared frozen config object on purpose.
 */
export function frozenPlanFor(task) {
  if (!isPlainObject(task)) throw new TypeError('frozenPlanFor 需要一个任务对象');
  for (const field of ['turns', 'nodes', 'acceptance', 'workspaceSeed']) {
    if (!Array.isArray(task[field])) {
      throw new TypeError(`frozenPlanFor：任务 ${quoted(task.id)} 缺少数组字段 ${field}`);
    }
  }
  return {
    taskId: task.id,
    model: FROZEN_MODEL,
    config: FROZEN_CONFIG,
    turns: task.turns.map((turn, index) => ({ turn: index + 1, prompt: turn.prompt })),
    nodes: task.nodes.map((node) => ({ ...node })),
    acceptance: task.acceptance.map((check) => ({
      ...check,
      ...(Array.isArray(check.argv) ? { argv: [...check.argv] } : {}),
    })),
    workspaceSeed: task.workspaceSeed.map((file) => ({ ...file })),
  };
}
