import { describe, expect, it } from 'vitest';
import { containsUnquotedDsmlControlMarkup, parseDsmlToolCalls } from './dsml-tool-calls.js';

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

  it('accepts ASCII delimiter variants without normalizing string parameter bytes', () => {
    const call = '< | | DSML | | calls>< | DSML | invoke name="exec">< | DSML | parameter name="cmd" string="true">  pwd &amp;&amp; echo ok\n</ | DSML | parameter></ | DSML | invoke></ | DSML | calls>';
    expect(parseDsmlToolCalls(call, new Set(['exec']))?.toolCalls[0]?.function.arguments)
      .toBe(JSON.stringify({ cmd: '  pwd && echo ok\n' }));
  });

  it('keeps fenced, inline and escaped DSML examples inert', () => {
    const call = '<｜DSML｜ calls><｜DSML｜ invoke name="exec"><｜DSML｜ parameter name="cmd" string="true">pwd</｜DSML｜ parameter></｜DSML｜ invoke></｜DSML｜ calls>';
    for (const quoted of [`\`\`\`xml\n${call}\n\`\`\``, `example: \`${call}\``, `\\${call}`]) {
      expect(parseDsmlToolCalls(quoted, new Set(['exec']))).toBeUndefined();
      expect(containsUnquotedDsmlControlMarkup(quoted)).toBe(false);
    }
    expect(containsUnquotedDsmlControlMarkup(call)).toBe(true);
  });

  it('rejects prose, unknown tools and incomplete envelopes', () => {
    const call = '<｜DSML｜ calls><｜DSML｜ invoke name="exec"><｜DSML｜ parameter name="cmd" string="true">pwd</｜DSML｜ parameter></｜DSML｜ invoke></｜DSML｜ calls>';
    expect(parseDsmlToolCalls(`${call}\ntext after`, new Set(['exec']))).toBeUndefined();
    expect(parseDsmlToolCalls(call, new Set(['read']))).toBeUndefined();
    expect(parseDsmlToolCalls(call.slice(0, -10), new Set(['exec']))).toBeUndefined();
  });

  it('HA-01-09 preserves multiple valid calls in source order', () => {
    const invoke = (command: string) => `<｜DSML｜ invoke name="exec"><｜DSML｜ parameter name="cmd" string="true">${command}</｜DSML｜ parameter></｜DSML｜ invoke>`;
    const parsed = parseDsmlToolCalls(`<｜DSML｜ calls>${invoke('one')}${invoke('two')}</｜DSML｜ calls>`, new Set(['exec']));
    expect(parsed?.toolCalls.map((call) => call.function.arguments)).toEqual([
      JSON.stringify({ cmd: 'one' }),
      JSON.stringify({ cmd: 'two' }),
    ]);
  });
});
