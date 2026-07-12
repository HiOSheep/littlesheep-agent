import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// Workspace packages are symlinked into node_modules by pnpm, but vite's dep
// optimizer doesn't always follow them. Alias each @littlesheep/* to its
// source entry point so tests run against source (no rebuild needed) and
// pick up changes immediately.
const pkg = (name: string) =>
  fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

// Channel plugins live under packages/channels/<name>/ (one level deeper).
const channelPkg = (name: string) =>
  fileURLToPath(new URL(`./packages/channels/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  plugins: [
    {
      // node:sqlite is experimental (Node 22.5+) and not in Vite's static
      // built-in list. Vite strips the node: prefix → 'sqlite', then fails to
      // find a file. The resolveId hook normalizes the id to 'node:sqlite';
      // the load hook provides a virtual module that uses createRequire to
      // import the real node:sqlite at runtime (bypassing Vite's file loader).
      name: 'externalize-node-sqlite',
      enforce: 'pre',
      resolveId(source: string) {
        if (source === 'node:sqlite' || source === 'sqlite') {
          return 'node:sqlite';
        }
        return null;
      },
      load(id: string) {
        if (id === 'node:sqlite') {
          // createRequire bypasses ESM resolution — Node.js handles 'node:sqlite'
          // natively. Only DatabaseSync is a runtime import (StatementSync +
          // SQLInputValue are type-only and erased by esbuild).
          return [
            "import { createRequire as __cr } from 'node:module';",
            "const __require = __cr(import.meta.url);",
            "const __sqlite = __require('node:sqlite');",
            "export const DatabaseSync = __sqlite.DatabaseSync;",
          ].join('\n');
        }
        return null;
      },
    },
  ],
  resolve: {
    alias: {
      '@littlesheep/branding': pkg('branding'),
      '@littlesheep/classifier': pkg('classifier'),
      '@littlesheep/channel-webhook': channelPkg('webhook'),
      '@littlesheep/channel-telegram': channelPkg('telegram'),
      '@littlesheep/channel-feishu': channelPkg('feishu'),
      '@littlesheep/channel-qqbot': channelPkg('qqbot'),
      '@littlesheep/cli': pkg('cli'),
      '@littlesheep/config': pkg('config'),
      '@littlesheep/experience': pkg('experience'),
      '@littlesheep/gateway': pkg('gateway'),
      '@littlesheep/harness': pkg('harness'),
      '@littlesheep/llm': pkg('llm'),
      '@littlesheep/memory-core': pkg('memory-core'),
      '@littlesheep/memory-tree': pkg('memory-tree'),
      '@littlesheep/prompt': pkg('prompt'),
      '@littlesheep/safety': pkg('safety'),
      '@littlesheep/snapshot': pkg('snapshot'),
      '@littlesheep/session': pkg('session'),
      '@littlesheep/skills': pkg('skills'),
      '@littlesheep/tools': pkg('tools'),
      '@littlesheep/types': pkg('types'),
      '@littlesheep/vector': pkg('vector'),
    },
  },
  test: {
    include: ['packages/**/src/**/*.test.ts', 'test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    server: {
      deps: {
        // Belt-and-suspenders: never optimize/transform node:* built-ins.
        external: [/^node:/],
      },
    },
  },
});
