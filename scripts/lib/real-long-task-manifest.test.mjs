import { describe, expect, it } from 'vitest';
import {
  FROZEN_CONFIG,
  FROZEN_MODEL,
  FROZEN_PROVIDER,
  LONG_TASK_CLASSES,
  MANIFEST_VERSION,
  REAL_LONG_TASKS,
  frozenPlanFor,
  longTaskById,
  validateManifest,
} from './real-long-task-manifest.mjs';

const ALLOWED_KINDS = ['file_exists', 'file_contains', 'file_not_contains', 'command'];
const CLASS_IDS = LONG_TASK_CLASSES.map((entry) => entry.id);

function cloneTask(task, patch = {}) {
  return { ...structuredClone(task), ...patch };
}

/** Patch one task of a full-size copy so set-level coverage keeps holding. */
function withBrokenTask(taskId, patch) {
  return REAL_LONG_TASKS.map((task) => (task.id === taskId ? cloneTask(task, patch) : structuredClone(task)));
}

function expectBroken(tasks) {
  const result = validateManifest(tasks);
  expect(result.ok).toBe(false);
  return result.errors.join('\n');
}

describe('冻结事实', () => {
  it('记录清单版本、已校准 provider/model 与配置冻结值', () => {
    expect(MANIFEST_VERSION).toBe(1);
    expect(FROZEN_PROVIDER).toBe('deepseek');
    expect(FROZEN_MODEL).toBe('deepseek/deepseek-flash');
    expect(FROZEN_CONFIG).toEqual({
      maxModelCallsPerRun: 32,
      contextCompressionThresholdRatio: 0.8,
      compaction: { threshold: 100, keepRecent: 20, background: false },
    });
  });

  it('冻结对象不可被就地改写', () => {
    expect(Object.isFrozen(REAL_LONG_TASKS)).toBe(true);
    expect(Object.isFrozen(FROZEN_CONFIG)).toBe(true);
    expect(Object.isFrozen(FROZEN_CONFIG.compaction)).toBe(true);
    expect(REAL_LONG_TASKS.every((task) => Object.isFrozen(task))).toBe(true);
    expect(REAL_LONG_TASKS.every((task) => Object.isFrozen(task.turns))).toBe(true);
    expect(REAL_LONG_TASKS.every((task) => Object.isFrozen(task.workspaceSeed))).toBe(true);
  });

  it('三个业务类别，每类两项任务，共六项', () => {
    expect(LONG_TASK_CLASSES.map((entry) => entry.id)).toEqual(['A', 'B', 'C']);
    expect(REAL_LONG_TASKS).toHaveLength(6);
    for (const classId of CLASS_IDS) {
      expect(REAL_LONG_TASKS.filter((task) => task.classId === classId)).toHaveLength(2);
    }
    expect(new Set(REAL_LONG_TASKS.map((task) => task.id)).size).toBe(REAL_LONG_TASKS.length);
  });
});

describe('已交付清单的自校验', () => {
  it('validateManifest() 对冻结清单返回 ok', () => {
    const result = validateManifest();
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });
});

describe('每个任务的结构契约', () => {
  it('id 唯一、类别已知、requiresWeb 一律为 false', () => {
    const ids = REAL_LONG_TASKS.map((task) => task.id);
    expect(ids).toEqual(['A1', 'A2', 'B1', 'B2', 'C1', 'C2']);
    for (const task of REAL_LONG_TASKS) {
      expect(task.id).toMatch(/^[A-Z][0-9]+$/);
      expect(CLASS_IDS).toContain(task.classId);
      expect(task.id.startsWith(task.classId)).toBe(true);
      expect(task.requiresWeb).toBe(false);
      expect(task.title.length).toBeGreaterThan(0);
    }
  });

  it('turns 为 2-4 条同会话连续用户消息，且不提及测量口径', () => {
    for (const task of REAL_LONG_TASKS) {
      expect(task.turns.length).toBeGreaterThanOrEqual(2);
      expect(task.turns.length).toBeLessThanOrEqual(4);
      const prompts = task.turns.map((turn) => turn.prompt);
      expect(new Set(prompts).size).toBe(prompts.length);
      for (const prompt of prompts) {
        expect(typeof prompt).toBe('string');
        expect(prompt.trim().length).toBeGreaterThan(0);
        // A prompt must read like a real user request, not like a measurement rig.
        expect(prompt).not.toMatch(/缓存|命中率|cache|token|tokens|测量|指标|manifest/i);
        expect(prompt).not.toMatch(/回合|最后一轮|还剩几轮/);
        const sentences = prompt.split(/[。！？]/).filter((part) => part.trim() !== '');
        expect(sentences.length).toBeGreaterThanOrEqual(1);
        expect(sentences.length).toBeLessThanOrEqual(3);
      }
    }
  });

  it('workspaceSeed 为 2-6 个小文件，路径相对且唯一，内容非空且短于 2000 字符', () => {
    for (const task of REAL_LONG_TASKS) {
      expect(task.workspaceSeed.length).toBeGreaterThanOrEqual(2);
      expect(task.workspaceSeed.length).toBeLessThanOrEqual(6);
      const paths = task.workspaceSeed.map((file) => file.path);
      expect(new Set(paths).size).toBe(paths.length);
      for (const file of task.workspaceSeed) {
        expect(file.path.startsWith('/')).toBe(false);
        expect(file.path.includes('\\')).toBe(false);
        expect(file.path).not.toMatch(/^[A-Za-z]:/);
        expect(file.path.split('/')).not.toContain('..');
        expect(typeof file.content).toBe('string');
        expect(file.content.length).toBeGreaterThan(0);
        expect(file.content.length).toBeLessThan(2000);
      }
    }
  });

  it('nodes 落在 1..turns.length 内、递增或相等，并且含自然完成节点', () => {
    for (const task of REAL_LONG_TASKS) {
      expect(task.nodes.length).toBeGreaterThanOrEqual(1);
      expect(task.nodes.length).toBeLessThanOrEqual(3);
      expect(new Set(task.nodes.map((node) => node.id)).size).toBe(task.nodes.length);
      let previous = 0;
      for (const node of task.nodes) {
        expect(Number.isInteger(node.turn)).toBe(true);
        expect(node.turn).toBeGreaterThanOrEqual(1);
        expect(node.turn).toBeLessThanOrEqual(task.turns.length);
        expect(node.turn).toBeGreaterThanOrEqual(previous);
        expect(node.label.trim().length).toBeGreaterThan(0);
        previous = node.turn;
      }
      expect(task.nodes.some((node) => node.turn === task.turns.length)).toBe(true);
      expect(task.nodes.at(-1).turn).toBe(task.turns.length);
    }
  });

  it('acceptance 每项都有中文说明并使用允许的验收类型', () => {
    for (const task of REAL_LONG_TASKS) {
      expect(task.acceptance.length).toBeGreaterThan(0);
      for (const check of task.acceptance) {
        expect(ALLOWED_KINDS).toContain(check.kind);
        expect(typeof check.label).toBe('string');
        expect(check.label.trim().length).toBeGreaterThan(0);
        if (check.kind === 'command') {
          expect(Array.isArray(check.argv)).toBe(true);
          expect(check.argv[0]).toBe('node');
          expect(Number.isInteger(check.expectExitCode)).toBe(true);
          for (const argument of check.argv) {
            // Plain node argv only: no shell syntax, no quoting tricks.
            expect(argument).not.toMatch(/[&|<>^;`$"'%]/);
          }
        } else {
          expect(check.path.startsWith('/')).toBe(false);
          expect(check.path.includes('\\')).toBe(false);
          if (check.kind !== 'file_exists') expect(check.text.length).toBeGreaterThan(0);
        }
      }
    }
  });

  it('两类代码任务的交付物由可运行的 node 命令验收', () => {
    const codeTasks = REAL_LONG_TASKS.filter((task) => task.classId === 'A');
    expect(codeTasks).toHaveLength(2);
    for (const task of codeTasks) {
      const commands = task.acceptance.filter((check) => check.kind === 'command');
      expect(commands.length).toBeGreaterThanOrEqual(1);
      for (const command of commands) {
        expect(command.expectExitCode).toBe(0);
      }
    }
    expect(codeTasks.flatMap((task) => task.acceptance)
      .filter((check) => check.kind === 'command')
      .map((check) => check.argv.join(' ')))
      .toEqual(['node test/cart.test.mjs', 'node --test']);
  });
});

describe('validateManifest 拒绝破损任务', () => {
  it('requiresWeb 非 false', () => {
    expect(expectBroken(withBrokenTask('C2', { requiresWeb: true }))).toMatch(/C2\.requiresWeb/);
    expect(expectBroken(withBrokenTask('B1', { requiresWeb: undefined }))).toMatch(/B1\.requiresWeb/);
  });

  it('turns 为空或超长', () => {
    expect(expectBroken(withBrokenTask('A1', { turns: [] }))).toMatch(/A1\.turns/);
    expect(expectBroken(withBrokenTask('A1', { turns: [{ prompt: '只有一条' }] }))).toMatch(/条数必须在 2-4/);
    expect(expectBroken([cloneTask(longTaskById('B2'), {
      turns: [{ prompt: '一' }, { prompt: '二' }, { prompt: '三' }, { prompt: '四' }, { prompt: '五' }],
    })])).toMatch(/条数必须在 2-4/);
  });

  it('node 回合越界或缺少自然完成节点', () => {
    const outOfRange = cloneTask(longTaskById('A1'), { nodes: [{ id: 'x', turn: 9, label: '越界' }] });
    expect(expectBroken([outOfRange])).toMatch(/A1\.nodes\[0\]\.turn: 必须在 1\.\.3 之间/);

    const noCompletion = cloneTask(longTaskById('B1'), {
      nodes: [{ id: 'only', turn: 1, label: '只到第一回合' }],
    });
    expect(expectBroken([noCompletion])).toMatch(/自然完成节点/);

    const decreasing = cloneTask(longTaskById('C1'), {
      nodes: [{ id: 'late', turn: 3, label: '晚' }, { id: 'early', turn: 1, label: '早' }],
    });
    expect(expectBroken([decreasing])).toMatch(/递增或相等/);
  });

  it('未知验收类型或缺少 label', () => {
    const unknownKind = cloneTask(longTaskById('B2'), {
      acceptance: [{ kind: 'filesystem_probe', path: 'report/reconcile.md', label: '自造类型' }],
    });
    expect(expectBroken([unknownKind])).toMatch(/B2\.acceptance\[0\]\.kind: 未知验收类型/);

    const noLabel = cloneTask(longTaskById('B2'), {
      acceptance: [{ kind: 'file_exists', path: 'report/reconcile.md' }],
    });
    expect(expectBroken([noLabel])).toMatch(/B2\.acceptance\[0\]\.label/);

    const shellCommand = cloneTask(longTaskById('A1'), {
      acceptance: [{ kind: 'command', argv: ['node', 'test/cart.test.mjs', '&&', 'echo'], expectExitCode: 0, label: '带 shell 语法' }],
    });
    expect(expectBroken([shellCommand])).toMatch(/shell 元字符/);
  });

  it('重复 id 与未知业务类别', () => {
    const duplicated = [cloneTask(longTaskById('A1')), cloneTask(longTaskById('A1'))];
    expect(expectBroken(duplicated)).toMatch(/A1\.id: .*重复/);

    expect(expectBroken(withBrokenTask('C1', { classId: 'D' }))).toMatch(/C1\.classId: 未知业务类别/);
  });

  it('文件种子与类别覆盖也被校验', () => {
    const badSeed = cloneTask(longTaskById('A2'), {
      workspaceSeed: [
        { path: '../escape.mjs', content: 'x' },
        { path: 'test/stock.test.mjs', content: 'x' },
        { path: 'C:/tmp/pwn.mjs', content: 'x' },
        { path: '', content: '' },
        { path: 'big.md', content: 'x'.repeat(2000) },
      ],
    });
    const seedErrors = expectBroken([badSeed]);
    expect(seedErrors).toMatch(/A2\.workspaceSeed\[0\]\.path/);
    expect(seedErrors).toMatch(/A2\.workspaceSeed\[2\]\.path/);
    expect(seedErrors).toMatch(/A2\.workspaceSeed\[3\]\.content/);
    expect(seedErrors).toMatch(/A2\.workspaceSeed\[4\]\.content: 必须小于 2000 字符/);

    const duplicatedPath = cloneTask(longTaskById('A2'), {
      workspaceSeed: [
        { path: 'README.md', content: 'a' },
        { path: 'README.md', content: 'b' },
      ],
    });
    expect(expectBroken([duplicatedPath])).toMatch(/路径重复/);

    const missingClass = withBrokenTask('C1', { classId: 'A' });
    const alsoMissing = missingClass.map((task) => (task.id === 'C2' ? { ...task, classId: 'A' } : task));
    const coverageErrors = expectBroken(alsoMissing);
    expect(coverageErrors).toMatch(/类别 C（记忆与本地来源结合的研究交付）必须有 2 项任务，当前 0/);
  });
});

describe('longTaskById', () => {
  it('按 id 取回任务', () => {
    const task = longTaskById('A1');
    expect(task.id).toBe('A1');
    expect(task.classId).toBe('A');
    expect(task).toBe(REAL_LONG_TASKS[0]);
  });

  it('未知 id 抛出列出已知 id 的错误', () => {
    expect(() => longTaskById('Z9')).toThrow(/未知的长任务 id/);
    expect(() => longTaskById('Z9')).toThrow(/A1, A2, B1, B2, C1, C2/);
    expect(() => longTaskById(undefined)).toThrow(/未知的长任务 id/);
  });
});

describe('frozenPlanFor', () => {
  it('产出驱动计划：模型、配置、回合编号、节点、验收与种子', () => {
    const task = longTaskById('B1');
    const plan = frozenPlanFor(task);

    expect(plan.taskId).toBe('B1');
    expect(plan.model).toBe('deepseek/deepseek-flash');
    expect(plan.config).toBe(FROZEN_CONFIG);
    expect(plan.turns).toEqual(task.turns.map((turn, index) => ({ turn: index + 1, prompt: turn.prompt })));
    expect(plan.nodes).toEqual(task.nodes);
    expect(plan.acceptance).toEqual(task.acceptance);
    expect(plan.workspaceSeed).toEqual(task.workspaceSeed);
    expect(plan.turns.at(-1).turn).toBe(task.turns.length);
  });

  it('深拷贝：改写计划不会影响冻结清单', () => {
    const task = longTaskById('C1');
    const originalPrompt = task.turns[0].prompt;
    const originalNode = { ...task.nodes[0] };
    const originalCheck = { ...task.acceptance[0] };
    const originalSeed = { ...task.workspaceSeed[0] };

    const plan = frozenPlanFor(task);
    plan.turns[0].prompt = '被改写的提示';
    plan.turns.push({ turn: 99, prompt: '多加一轮' });
    plan.nodes[0].turn = 99;
    plan.nodes[0].label = '被改写';
    plan.nodes.pop();
    plan.acceptance[0].label = '被改写';
    plan.acceptance.push({ kind: 'file_exists', path: 'evil.md', label: '多加一条' });
    plan.workspaceSeed[0].content = '被改写';

    expect(task.turns[0].prompt).toBe(originalPrompt);
    expect(task.turns).toHaveLength(3);
    expect(task.nodes[0]).toEqual(originalNode);
    expect(task.nodes).toHaveLength(3);
    expect(task.acceptance[0]).toEqual(originalCheck);
    expect(task.acceptance).toHaveLength(6);
    expect(task.workspaceSeed[0]).toEqual(originalSeed);
    expect(REAL_LONG_TASKS.find((entry) => entry.id === 'C1').turns[0].prompt).toBe(originalPrompt);

    const again = frozenPlanFor(task);
    expect(again.turns[0].prompt).toBe(originalPrompt);
    expect(again.nodes[0]).toEqual(originalNode);
  });

  it('拷贝 argv 数组，命令行计划同样不可回写', () => {
    const task = longTaskById('A2');
    const plan = frozenPlanFor(task);
    const [command] = plan.acceptance.filter((check) => check.kind === 'command');

    expect(command.argv).not.toBe(task.acceptance.find((check) => check.kind === 'command').argv);
    command.argv.push('--evil');
    expect(longTaskById('A2').acceptance.find((check) => check.kind === 'command').argv)
      .toEqual(['node', '--test']);
  });

  it('任务形状不完整时抛出清晰错误', () => {
    expect(() => frozenPlanFor(undefined)).toThrow(/需要一个任务对象/);
    expect(() => frozenPlanFor({ id: 'X1', turns: [], nodes: [], acceptance: [], workspaceSeed: {} }))
      .toThrow(/workspaceSeed/);
  });
});
