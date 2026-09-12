import { describe, expect, it } from 'vitest';
import { parseDsmlToolCalls } from './dsml-tool-calls.js';

describe('DeepSeek DSML fallback parser', () => {
  it('recovers a duplicated-delimiter V4.1 envelope as structured calls', () => {
    const content = '<｜｜DSML｜｜ calls>\n<｜｜DSML｜｜ invoke name="exec">\n<｜｜DSML｜｜ parameter name="cmd" string="true">pwd &amp;&amp; ls -la</｜｜DSML｜｜ parameter>\n</｜｜DSML｜｜ invoke>\n</｜｜DSML｜｜ calls>';
    expect(parseDsmlToolCalls(content, new Set(['exec']))).toMatchObject({
      content: '',
      toolCalls: [{
        type: 'function',
        function: { name: 'exec', arguments: JSON.stringify({ cmd: 'pwd && ls -la' }) },
      }],
    });
  });

  it('keeps prose before a complete trailing envelope', () => {
    const call = '<｜DSML｜ calls><｜DSML｜ invoke name="exec"><｜DSML｜ parameter name="cmd" string="true">pwd</｜DSML｜ parameter></｜DSML｜ invoke></｜DSML｜ calls>';
    expect(parseDsmlToolCalls(`我先检查工作区。\n\n${call}`, new Set(['exec']))).toMatchObject({
      content: '我先检查工作区。',
      toolCalls: [{ function: { name: 'exec' } }],
    });
  });

  it('rejects prose, unknown tools and incomplete envelopes', () => {
    const call = '<｜DSML｜ calls><｜DSML｜ invoke name="exec"><｜DSML｜ parameter name="cmd" string="true">pwd</｜DSML｜ parameter></｜DSML｜ invoke></｜DSML｜ calls>';
    expect(parseDsmlToolCalls(`${call}\ntext after`, new Set(['exec']))).toBeUndefined();
    expect(parseDsmlToolCalls(call, new Set(['read']))).toBeUndefined();
    expect(parseDsmlToolCalls(call.slice(0, -10), new Set(['exec']))).toBeUndefined();
  });
});
