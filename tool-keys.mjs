import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
const dir = join(process.argv[2], 'execution-logs');
for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
  let log; try { log = JSON.parse(readFileSync(join(dir, f), 'utf8')); } catch { continue; }
  const inv = (log.toolInvocations ?? [])[0];
  const call = (log.toolCalls ?? [])[0];
  console.log('toolInvocations[0] keys: ' + (inv ? Object.keys(inv).join(', ') : 'none'));
  console.log('toolCalls[0] keys: ' + (call ? Object.keys(call).join(', ') : 'none'));
  console.log('log startedAt: ' + log.startedAt + '  durationMs: ' + log.durationMs);
  break;
}