// @littlesheep/cli — args.ts
// Minimal argv parser (no external dep). Supports -h/--help, -v/--version,
// -s/--session <id>, -m/--model <ref>, and a positional single-shot text.

export interface ParsedArgs {
  help: boolean;
  version: boolean;
  session?: string;
  model?: string;
  text?: string;
  unknown: string[];
  /** Raw argv for the 'memory rollback' subcommand (undefined if not requested). */
  memoryRollback?: string[];
  /** Raw argv for the 'memory experience decay' subcommand (undefined if not requested). */
  memoryExperience?: string[];
  /** Raw argv for the 'memory import-repo' subcommand (undefined if not requested). */
  memoryImportRepo?: string[];
  /** Recognized legacy command that must fail before loading providers or touching data. */
  retiredCommand?: 'memory archive';
}

export const USAGE = `Usage: littlesheep [options] [text]

  Options:
    -h, --help            Show this help
    -v, --version         Show version
    -s, --session <id>    Resume session <id>
    -m, --model <ref>     Override model (provider/model, e.g. openai/gpt-4o)
    --session=<id>        Session via = syntax
    --model=<ref>         Model via = syntax

  Subcommands:
    memory rollback       Restore memory from snapshots
                          (run 'littlesheep memory rollback' for details)
    memory experience decay
                          Decay experience confidence + prune low-confidence entries
    memory import-repo <path-or-url>
                          Distill a repo's knowledge into the experience DB via LLM

  If [text] is given, run single-shot and exit. Otherwise start REPL.`;

export const VERSION = '0.1.0';

/** Parse argv (without node binary + script path; caller passes process.argv.slice(2)). */
export function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { help: false, version: false, unknown: [] };

  // Subcommand: 'memory rollback ...' (consumes the rest of argv).
  if (argv[0] === 'memory' && argv[1] === 'rollback') {
    out.memoryRollback = argv.slice(2);
    return out;
  }

  // Subcommand: 'memory experience decay ...' (consumes the rest of argv).
  if (argv[0] === 'memory' && argv[1] === 'experience' && argv[2] === 'decay') {
    out.memoryExperience = argv.slice(3);
    return out;
  }

  // Memory v3 retired this command because it wrote a second summary/vector authority.
  if (argv[0] === 'memory' && argv[1] === 'archive') {
    out.retiredCommand = 'memory archive';
    return out;
  }

  // Subcommand: 'memory import-repo ...' (consumes the rest of argv).
  if (argv[0] === 'memory' && argv[1] === 'import-repo') {
    out.memoryImportRepo = argv.slice(2);
    return out;
  }

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined) continue;
    if (a === '-h' || a === '--help') {
      out.help = true;
    } else if (a === '-v' || a === '--version') {
      out.version = true;
    } else if (a === '-s' || a === '--session') {
      out.session = argv[++i] ?? '';
    } else if (a.startsWith('--session=')) {
      out.session = a.slice('--session='.length);
    } else if (a === '-m' || a === '--model') {
      out.model = argv[++i] ?? '';
    } else if (a.startsWith('--model=')) {
      out.model = a.slice('--model='.length);
    } else if (a.startsWith('-') && a.length > 1) {
      out.unknown.push(a);
    } else if (out.text === undefined) {
      out.text = a;
    }
  }
  return out;
}
