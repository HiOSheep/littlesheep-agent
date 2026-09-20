import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
const dir = join(process.argv[2], 'execution-logs');
for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
  let log; try { log = JSON.parse(readFileSync(join(dir, f), 'utf8')); } catch { continue; }
  const trace = (log.trace ?? [])[0];
  const req = (log.modelRequests ?? [])[0];
  const events = (log.runtimeEventQueue ?? [])[0];
  console.log('trace[0]: ' + (trace ? Object.keys(trace).join(', ') : 'none'));
  console.log('modelRequests[0]: ' + (req ? Object.keys(req).join(', ') : 'none'));
  console.log('runtimeEventQueue[0]: ' + (events ? Object.keys(events).join(', ') : 'none'));
  if (trace) console.log('trace[0] sample: ' + JSON.stringify(trace).slice(0, 300));
  if (req) console.log('req timestamps: ' + JSON.stringify({ startedAt: req.startedAt, at: req.at, timestamp: req.timestamp, createdAt: req.createdAt }));
  break;
}