import { describe, expect, it } from 'vitest';
import {
  LONG_INTERVAL_MANIFEST_VERSION,
  LONG_INTERVAL_TASKS,
  longIntervalTaskById,
  validateLongIntervalManifest,
} from './long-interval-task.mjs';

const ALLOWED_KINDS = ['file_exists', 'file_contains', 'file_not_contains', 'command'];
const MIN_TURNS = 24;
const MAX_TURNS = 32;
const MIN_NODES = 4;
const SHELL_METACHARACTERS = /[&|<>^;`$"'%]/;

const [TASK] = LONG_INTERVAL_TASKS;

function cloneTask(patch = {}) {
  return { ...structuredClone(TASK), ...patch };
}

function expectBroken(tasks) {
  const result = validateLongIntervalManifest(tasks);
  expect(result.ok).toBe(false);
  return result.errors.join('\n');
}

describe('冻结事实', () => {
  it('清单版本为 1，且只冻结一项长间隔任务', () => {
    expect(LONG_INTERVAL_MANIFEST_VERSION).toBe(1);
    expect(LONG_INTERVAL_TASKS).toHaveLength(1);
    expect(TASK.id).toBe('L1');
    expect(TASK.classId).toBe('L');
    expect(TASK.title.length).toBeGreaterThan(0);
    expect(TASK.requiresWeb).toBe(false);
  });

  it('冻结对象不可被就地改写', () => {
    expect(Object.isFrozen(LONG_INTERVAL_TASKS)).toBe(true);
    expect(Object.isFrozen(TASK)).toBe(true);
    expect(Object.isFrozen(TASK.turns)).toBe(true);
    expect(Object.isFrozen(TASK.nodes)).toBe(true);
    expect(Object.isFrozen(TASK.acceptance)).toBe(true);
    expect(Object.isFrozen(TASK.workspaceSeed)).toBe(true);
    expect(TASK.workspaceSeed.every((file) => Object.isFrozen(file))).toBe(true);
    expect(TASK.turns.every((turn) => Object.isFrozen(turn))).toBe(true);
  });
});

describe('已交付清单的自校验', () => {
  it('validateLongIntervalManifest() 对冻结清单返回 ok', () => {
    const result = validateLongIntervalManifest();
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('单任务切片也能单独校验', () => {
    const result = validateLongIntervalManifest([TASK]);
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });
});

describe('任务的结构契约', () => {
  it('turns 为 24-32 条同会话连续用户消息', () => {
    expect(TASK.turns.length).toBeGreaterThanOrEqual(MIN_TURNS);
    expect(TASK.turns.length).toBeLessThanOrEqual(MAX_TURNS);
    const prompts = TASK.turns.map((turn) => turn.prompt);
    expect(new Set(prompts).size).toBe(prompts.length);
    for (const prompt of prompts) {
      expect(typeof prompt).toBe('string');
      expect(prompt.trim().length).toBeGreaterThan(0);
      // 一条用户消息读起来像真实请求，不像测量装置。
      const sentences = prompt.split(/[。！？]/).filter((part) => part.trim() !== '');
      expect(sentences.length).toBeGreaterThanOrEqual(1);
      expect(sentences.length).toBeLessThanOrEqual(3);
    }
  });

  it('nodes 至少 4 个、严格递增、落在回合范围内且最后一个节点就是最后一回合', () => {
    expect(TASK.nodes.length).toBeGreaterThanOrEqual(MIN_NODES);
    expect(new Set(TASK.nodes.map((node) => node.id)).size).toBe(TASK.nodes.length);
    let previous = 0;
    for (const node of TASK.nodes) {
      expect(Number.isInteger(node.turn)).toBe(true);
      expect(node.turn).toBeGreaterThanOrEqual(1);
      expect(node.turn).toBeLessThanOrEqual(TASK.turns.length);
      expect(node.turn).toBeGreaterThan(previous);
      expect(node.label.trim().length).toBeGreaterThan(0);
      previous = node.turn;
    }
    expect(TASK.nodes.at(-1).turn).toBe(TASK.turns.length);
  });

  it('workspaceSeed 为 3-8 个相对路径唯一的小文件', () => {
    expect(TASK.workspaceSeed.length).toBeGreaterThanOrEqual(3);
    expect(TASK.workspaceSeed.length).toBeLessThanOrEqual(8);
    const paths = TASK.workspaceSeed.map((file) => file.path);
    expect(new Set(paths).size).toBe(paths.length);
    for (const file of TASK.workspaceSeed) {
      expect(file.path.startsWith('/')).toBe(false);
      expect(file.path.includes('\\')).toBe(false);
      expect(file.path).not.toMatch(/^[A-Za-z]:/);
      expect(file.path.split('/')).not.toContain('..');
      expect(file.path.split('/')).not.toContain('.');
      expect(file.path.split('/')).not.toContain('');
      expect(typeof file.content).toBe('string');
      expect(file.content.length).toBeGreaterThan(0);
      expect(file.content.length).toBeLessThan(2000);
    }
  });

  it('种子项目自带一个可运行的测试文件，且都是纯 Node 标准库', () => {
    const paths = TASK.workspaceSeed.map((file) => file.path);
    expect(paths).toContain('expenses/README.md');
    expect(paths).toContain('expenses/test.mjs');
    expect(paths.some((path) => path.endsWith('cli.mjs'))).toBe(true);
    expect(paths.some((path) => path.endsWith('ledger.json'))).toBe(true);
  });

  it('acceptance 每项都有中文说明并使用允许的验收类型', () => {
    expect(TASK.acceptance.length).toBeGreaterThanOrEqual(3);
    expect(TASK.acceptance.length).toBeLessThanOrEqual(6);
    for (const check of TASK.acceptance) {
      expect(ALLOWED_KINDS).toContain(check.kind);
      expect(typeof check.label).toBe('string');
      expect(check.label.trim().length).toBeGreaterThan(0);
      if (check.kind === 'command') {
        expect(Array.isArray(check.argv)).toBe(true);
        expect(check.argv[0]).toBe('node');
        expect(Number.isInteger(check.expectExitCode)).toBe(true);
        for (const argument of check.argv) {
          // 只允许普通 node 参数：没有 shell 语法，也没有引号技巧。
          expect(argument).not.toMatch(SHELL_METACHARACTERS);
          expect(argument.trim().length).toBeGreaterThan(0);
        }
      } else {
        expect(check.path.startsWith('/')).toBe(false);
        expect(check.path.includes('\\')).toBe(false);
        if (check.kind !== 'file_exists') expect(check.text.length).toBeGreaterThan(0);
      }
    }
  });

  it('验收检查描述最终状态：命令行可运行，且 README 记录了最终能力', () => {
    const commands = TASK.acceptance.filter((check) => check.kind === 'command');
    expect(commands.length).toBeGreaterThanOrEqual(2);
    for (const command of commands) expect(command.expectExitCode).toBe(0);
    expect(commands.map((check) => check.argv.join(' '))).toContain('node expenses/test.mjs');

    const readmeTexts = TASK.acceptance
      .filter((check) => check.kind === 'file_contains' && check.path === 'expenses/README.md')
      .map((check) => check.text);
    expect(readmeTexts).toContain('整数分');
    expect(readmeTexts).toContain('--from');
  });
});

describe('提示文本不暴露测量口径', () => {
  const prompts = TASK.turns.map((turn) => turn.prompt);

  it('不提及缓存、token、测量或清单本身', () => {
    for (const prompt of prompts) {
      expect(prompt).not.toMatch(/缓存|命中率|cache/i);
      expect(prompt).not.toMatch(/token/i);
      expect(prompt).not.toMatch(/测量|指标|manifest|基准/);
    }
  });

  it('不提及回合编号，也不数还剩多少条', () => {
    for (const prompt of prompts) {
      expect(prompt).not.toMatch(/回合|轮次|最后一轮/);
      expect(prompt).not.toMatch(/(共|一共|还有|还剩)\s*\d+\s*(条|轮|回合|步)/);
      expect(prompt).not.toMatch(/\d+\s*(轮|回合)/);
      expect(prompt).not.toContain(String(TASK.turns.length));
    }
  });
});

describe('validateLongIntervalManifest 拒绝破损任务', () => {
  it('回合太少或太多', () => {
    expect(expectBroken([cloneTask({ turns: TASK.turns.slice(0, 10) })]))
      .toMatch(/L1\.turns: 条数必须在 24-32 之间，当前 10/);
    expect(expectBroken([cloneTask({ turns: [] })]))
      .toMatch(/L1\.turns: 条数必须在 24-32 之间，当前 0/);
    const tooMany = [...TASK.turns, ...Array.from({ length: 6 }, (_, index) => ({ prompt: `多余的请求 ${index}` }))];
    expect(expectBroken([cloneTask({ turns: tooMany })]))
      .toMatch(/条数必须在 24-32 之间，当前 34/);
  });

  it('节点越界或缺少自然完成节点', () => {
    const outOfRange = cloneTask({ nodes: [{ id: 'x', turn: 99, label: '越界' }] });
    expect(expectBroken([outOfRange])).toMatch(/L1\.nodes\[0\]\.turn: 必须在 1\.\.28 之间/);

    const noCompletion = cloneTask({
      nodes: [
        { id: 'a', turn: 1, label: '一' },
        { id: 'b', turn: 8, label: '二' },
        { id: 'c', turn: 16, label: '三' },
        { id: 'd', turn: 22, label: '四' },
      ],
    });
    expect(expectBroken([noCompletion])).toMatch(/自然完成节点/);

    const decreasing = cloneTask({
      nodes: [
        { id: 'late', turn: 22, label: '晚' },
        { id: 'early', turn: 8, label: '早' },
        { id: 'mid', turn: 16, label: '中' },
        { id: 'last', turn: 28, label: '终' },
      ],
    });
    expect(expectBroken([decreasing])).toMatch(/严格递增/);

    const tooFew = cloneTask({ nodes: [{ id: 'only', turn: 28, label: '只有一个' }] });
    expect(expectBroken([tooFew])).toMatch(/L1\.nodes: 节点数不能少于 4/);
  });

  it('未知验收类型、缺少 label 或命令带 shell 语法', () => {
    const unknownKind = cloneTask({
      acceptance: [{ kind: 'filesystem_probe', path: 'expenses/README.md', label: '自造类型' }],
    });
    expect(expectBroken([unknownKind])).toMatch(/L1\.acceptance\[0\]\.kind: 未知验收类型/);

    const noLabel = cloneTask({
      acceptance: [{ kind: 'file_exists', path: 'expenses/README.md' }],
    });
    expect(expectBroken([noLabel])).toMatch(/L1\.acceptance\[0\]\.label/);

    const shellCommand = cloneTask({
      acceptance: [{
        kind: 'command',
        argv: ['node', 'expenses/test.mjs', '&&', 'echo'],
        expectExitCode: 0,
        label: '带 shell 语法',
      }],
    });
    expect(expectBroken([shellCommand])).toMatch(/shell 元字符/);

    const notNode = cloneTask({
      acceptance: [{ kind: 'command', argv: ['pwsh', 'expenses/test.mjs'], expectExitCode: 0, label: '不是 node' }],
    });
    expect(expectBroken([notNode])).toMatch(/L1\.acceptance\[0\]\.argv\[0\]: 必须是 node/);

    const noExitCode = cloneTask({
      acceptance: [{ kind: 'command', argv: ['node', 'expenses/test.mjs'], label: '缺退出码' }],
    });
    expect(expectBroken([noExitCode])).toMatch(/expectExitCode/);
  });

  it('种子路径重复、越界或内容超长', () => {
    const duplicatedPath = cloneTask({
      workspaceSeed: [
        { path: 'expenses/README.md', content: 'a' },
        { path: 'expenses/README.md', content: 'b' },
        { path: 'expenses/cli.mjs', content: 'c' },
      ],
    });
    expect(expectBroken([duplicatedPath])).toMatch(/路径重复/);

    const badPaths = cloneTask({
      workspaceSeed: [
        { path: '../escape.mjs', content: 'x' },
        { path: 'C:/tmp/pwn.mjs', content: 'x' },
        { path: '', content: '' },
        { path: 'big.md', content: 'x'.repeat(2000) },
      ],
    });
    const errors = expectBroken([badPaths]);
    expect(errors).toMatch(/L1\.workspaceSeed\[0\]\.path/);
    expect(errors).toMatch(/L1\.workspaceSeed\[1\]\.path/);
    expect(errors).toMatch(/L1\.workspaceSeed\[2\]\.path/);
    expect(errors).toMatch(/L1\.workspaceSeed\[2\]\.content/);
    expect(errors).toMatch(/L1\.workspaceSeed\[3\]\.content: 必须小于 2000 字符/);

    const tooFewFiles = cloneTask({
      workspaceSeed: [{ path: 'only.md', content: 'x' }],
    });
    expect(expectBroken([tooFewFiles])).toMatch(/文件数必须在 3-8 之间/);
  });

  it('requiresWeb 非 false、类别错误或 id 重复', () => {
    expect(expectBroken([cloneTask({ requiresWeb: true })])).toMatch(/L1\.requiresWeb/);
    expect(expectBroken([cloneTask({ requiresWeb: undefined })])).toMatch(/L1\.requiresWeb/);
    expect(expectBroken([cloneTask({ classId: 'A' })])).toMatch(/L1\.classId/);
    expect(expectBroken([cloneTask({ id: 'X1' })])).toMatch(/X1\.id: 必须是长任务类别字母加数字/);
    expect(expectBroken([cloneTask({ id: 'L1' }), cloneTask({ id: 'L1' })]))
      .toMatch(/L1\.id: .*重复/);
  });

  it('空清单与非法入参不抛错，只返回 errors', () => {
    expect(validateLongIntervalManifest([]).ok).toBe(false);
    expect(validateLongIntervalManifest([]).errors.join('\n')).toMatch(/不能为空/);
    expect(validateLongIntervalManifest(undefined).ok).toBe(true);
    expect(validateLongIntervalManifest('nope').ok).toBe(false);
    expect(validateLongIntervalManifest(null).ok).toBe(false);
  });

  it('提示文本出现测量口径时被拒绝', () => {
    const fabricated = cloneTask({
      turns: TASK.turns.map((turn, index) => (
        index === 3 ? { prompt: '这一轮的缓存命中率是多少？' } : { prompt: turn.prompt }
      )),
    });
    expect(expectBroken([fabricated])).toMatch(/L1\.turns\[3\]\.prompt: 不得提及缓存/);

    const counting = cloneTask({
      turns: TASK.turns.map((turn, index) => (
        index === 5 ? { prompt: '还剩 22 条要求，请继续。' } : { prompt: turn.prompt }
      )),
    });
    expect(expectBroken([counting])).toMatch(/不得提及回合编号或剩余条数/);
  });
});

describe('longIntervalTaskById', () => {
  it('按 id 取回任务', () => {
    const task = longIntervalTaskById('L1');
    expect(task.id).toBe('L1');
    expect(task.classId).toBe('L');
    expect(task).toBe(LONG_INTERVAL_TASKS[0]);
  });

  it('未知 id 抛出列出已知 id 的错误', () => {
    expect(() => longIntervalTaskById('L2')).toThrow(/未知的长间隔任务 id/);
    expect(() => longIntervalTaskById('L2')).toThrow(/已知 id：L1/);
    expect(() => longIntervalTaskById(undefined)).toThrow(/未知的长间隔任务 id/);
  });
});
