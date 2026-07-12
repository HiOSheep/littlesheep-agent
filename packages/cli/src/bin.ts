#!/usr/bin/env node
// @littlesheep/cli — bin.ts
// Binary entry point. Wires process.argv into runCli.
import { runCli } from './index.js';

runCli(process.argv.slice(2)).catch((err) => {
  process.stderr.write(`Fatal: ${(err as Error).message}\n`);
  process.exit(1);
});
