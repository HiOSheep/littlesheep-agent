// vitest.config.ts
import { defineConfig } from "file:///D:/Repositories/littlesheep/node_modules/.pnpm/vitest@2.1.9_@types+node@22.20.0/node_modules/vitest/dist/config.js";
import { fileURLToPath } from "node:url";
var __vite_injected_original_import_meta_url = "file:///D:/Repositories/littlesheep/vitest.config.ts";
var pkg = (name) => fileURLToPath(new URL(`./packages/${name}/src/index.ts`, __vite_injected_original_import_meta_url));
var pkgFile = (name, file) => fileURLToPath(new URL(`./packages/${name}/src/${file}.ts`, __vite_injected_original_import_meta_url));
var channelPkg = (name) => fileURLToPath(new URL(`./packages/channels/${name}/src/index.ts`, __vite_injected_original_import_meta_url));
var vitest_config_default = defineConfig({
  plugins: [
    {
      // node:sqlite is experimental (Node 22.5+) and not in Vite's static
      // built-in list. Vite strips the node: prefix → 'sqlite', then fails to
      // find a file. The resolveId hook normalizes the id to 'node:sqlite';
      // the load hook provides a virtual module that uses createRequire to
      // import the real node:sqlite at runtime (bypassing Vite's file loader).
      name: "externalize-node-sqlite",
      enforce: "pre",
      resolveId(source) {
        if (source === "node:sqlite" || source === "sqlite") {
          return "node:sqlite";
        }
        return null;
      },
      load(id) {
        if (id === "node:sqlite") {
          return [
            "import { createRequire as __cr } from 'node:module';",
            "const __require = __cr(import.meta.url);",
            "const __sqlite = __require('node:sqlite');",
            "export const DatabaseSync = __sqlite.DatabaseSync;"
          ].join("\n");
        }
        return null;
      }
    }
  ],
  resolve: {
    alias: {
      "@littlesheep/branding": pkg("branding"),
      "@littlesheep/classifier": pkg("classifier"),
      "@littlesheep/channel-webhook": channelPkg("webhook"),
      "@littlesheep/channel-telegram": channelPkg("telegram"),
      "@littlesheep/channel-feishu": channelPkg("feishu"),
      "@littlesheep/channel-qqbot": channelPkg("qqbot"),
      "@littlesheep/cli": pkg("cli"),
      "@littlesheep/config/model-capabilities": pkgFile("config", "model-capabilities"),
      "@littlesheep/config": pkg("config"),
      "@littlesheep/context": pkg("context"),
      "@littlesheep/experience": pkg("experience"),
      "@littlesheep/plugins": pkg("plugins"),
      "@littlesheep/harness": pkg("harness"),
      "@littlesheep/llm": pkg("llm"),
      "@littlesheep/memory-core": pkg("memory-core"),
      "@littlesheep/memory-tree": pkg("memory-tree"),
      "@littlesheep/prompt": pkg("prompt"),
      "@littlesheep/runner": pkg("runner"),
      "@littlesheep/safety/verified-asset": pkgFile("safety", "verified-asset"),
      "@littlesheep/safety": pkg("safety"),
      "@littlesheep/snapshot": pkg("snapshot"),
      "@littlesheep/session": pkg("session"),
      "@littlesheep/skills": pkg("skills"),
      "@littlesheep/tools": pkg("tools"),
      "@littlesheep/types": pkg("types"),
      "@littlesheep/vector": pkg("vector")
    }
  },
  test: {
    include: ["packages/**/src/**/*.test.ts", "test/**/*.test.ts", "scripts/**/*.test.mjs"],
    environment: "node",
    testTimeout: 3e4,
    // SQLite, shadow Git and Memory v3 integration suites contend heavily on
    // an 8 GiB Windows host at four workers and can starve otherwise small
    // Runner cases past the unchanged 30 s test ceiling. Three keeps the full
    // gate resource-bounded while preserving useful file parallelism.
    maxWorkers: 3,
    minWorkers: 1,
    server: {
      deps: {
        // Belt-and-suspenders: never optimize/transform node:* built-ins.
        external: [/^node:/]
      }
    }
  }
});
export {
  vitest_config_default as default
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsidml0ZXN0LmNvbmZpZy50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiY29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2Rpcm5hbWUgPSBcIkQ6XFxcXFJlcG9zaXRvcmllc1xcXFxsaXR0bGVzaGVlcFwiO2NvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9maWxlbmFtZSA9IFwiRDpcXFxcUmVwb3NpdG9yaWVzXFxcXGxpdHRsZXNoZWVwXFxcXHZpdGVzdC5jb25maWcudHNcIjtjb25zdCBfX3ZpdGVfaW5qZWN0ZWRfb3JpZ2luYWxfaW1wb3J0X21ldGFfdXJsID0gXCJmaWxlOi8vL0Q6L1JlcG9zaXRvcmllcy9saXR0bGVzaGVlcC92aXRlc3QuY29uZmlnLnRzXCI7aW1wb3J0IHsgZGVmaW5lQ29uZmlnIH0gZnJvbSAndml0ZXN0L2NvbmZpZyc7XG5pbXBvcnQgeyBmaWxlVVJMVG9QYXRoIH0gZnJvbSAnbm9kZTp1cmwnO1xuXG4vLyBXb3Jrc3BhY2UgcGFja2FnZXMgYXJlIHN5bWxpbmtlZCBpbnRvIG5vZGVfbW9kdWxlcyBieSBwbnBtLCBidXQgdml0ZSdzIGRlcFxuLy8gb3B0aW1pemVyIGRvZXNuJ3QgYWx3YXlzIGZvbGxvdyB0aGVtLiBBbGlhcyBlYWNoIEBsaXR0bGVzaGVlcC8qIHRvIGl0c1xuLy8gc291cmNlIGVudHJ5IHBvaW50IHNvIHRlc3RzIHJ1biBhZ2FpbnN0IHNvdXJjZSAobm8gcmVidWlsZCBuZWVkZWQpIGFuZFxuLy8gcGljayB1cCBjaGFuZ2VzIGltbWVkaWF0ZWx5LlxuY29uc3QgcGtnID0gKG5hbWU6IHN0cmluZykgPT5cbiAgZmlsZVVSTFRvUGF0aChuZXcgVVJMKGAuL3BhY2thZ2VzLyR7bmFtZX0vc3JjL2luZGV4LnRzYCwgaW1wb3J0Lm1ldGEudXJsKSk7XG5cbmNvbnN0IHBrZ0ZpbGUgPSAobmFtZTogc3RyaW5nLCBmaWxlOiBzdHJpbmcpID0+XG4gIGZpbGVVUkxUb1BhdGgobmV3IFVSTChgLi9wYWNrYWdlcy8ke25hbWV9L3NyYy8ke2ZpbGV9LnRzYCwgaW1wb3J0Lm1ldGEudXJsKSk7XG5cbi8vIENoYW5uZWwgcGx1Z2lucyBsaXZlIHVuZGVyIHBhY2thZ2VzL2NoYW5uZWxzLzxuYW1lPi8gKG9uZSBsZXZlbCBkZWVwZXIpLlxuY29uc3QgY2hhbm5lbFBrZyA9IChuYW1lOiBzdHJpbmcpID0+XG4gIGZpbGVVUkxUb1BhdGgobmV3IFVSTChgLi9wYWNrYWdlcy9jaGFubmVscy8ke25hbWV9L3NyYy9pbmRleC50c2AsIGltcG9ydC5tZXRhLnVybCkpO1xuXG5leHBvcnQgZGVmYXVsdCBkZWZpbmVDb25maWcoe1xuICBwbHVnaW5zOiBbXG4gICAge1xuICAgICAgLy8gbm9kZTpzcWxpdGUgaXMgZXhwZXJpbWVudGFsIChOb2RlIDIyLjUrKSBhbmQgbm90IGluIFZpdGUncyBzdGF0aWNcbiAgICAgIC8vIGJ1aWx0LWluIGxpc3QuIFZpdGUgc3RyaXBzIHRoZSBub2RlOiBwcmVmaXggXHUyMTkyICdzcWxpdGUnLCB0aGVuIGZhaWxzIHRvXG4gICAgICAvLyBmaW5kIGEgZmlsZS4gVGhlIHJlc29sdmVJZCBob29rIG5vcm1hbGl6ZXMgdGhlIGlkIHRvICdub2RlOnNxbGl0ZSc7XG4gICAgICAvLyB0aGUgbG9hZCBob29rIHByb3ZpZGVzIGEgdmlydHVhbCBtb2R1bGUgdGhhdCB1c2VzIGNyZWF0ZVJlcXVpcmUgdG9cbiAgICAgIC8vIGltcG9ydCB0aGUgcmVhbCBub2RlOnNxbGl0ZSBhdCBydW50aW1lIChieXBhc3NpbmcgVml0ZSdzIGZpbGUgbG9hZGVyKS5cbiAgICAgIG5hbWU6ICdleHRlcm5hbGl6ZS1ub2RlLXNxbGl0ZScsXG4gICAgICBlbmZvcmNlOiAncHJlJyxcbiAgICAgIHJlc29sdmVJZChzb3VyY2U6IHN0cmluZykge1xuICAgICAgICBpZiAoc291cmNlID09PSAnbm9kZTpzcWxpdGUnIHx8IHNvdXJjZSA9PT0gJ3NxbGl0ZScpIHtcbiAgICAgICAgICByZXR1cm4gJ25vZGU6c3FsaXRlJztcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gbnVsbDtcbiAgICAgIH0sXG4gICAgICBsb2FkKGlkOiBzdHJpbmcpIHtcbiAgICAgICAgaWYgKGlkID09PSAnbm9kZTpzcWxpdGUnKSB7XG4gICAgICAgICAgLy8gY3JlYXRlUmVxdWlyZSBieXBhc3NlcyBFU00gcmVzb2x1dGlvbiBcdTIwMTQgTm9kZS5qcyBoYW5kbGVzICdub2RlOnNxbGl0ZSdcbiAgICAgICAgICAvLyBuYXRpdmVseS4gT25seSBEYXRhYmFzZVN5bmMgaXMgYSBydW50aW1lIGltcG9ydCAoU3RhdGVtZW50U3luYyArXG4gICAgICAgICAgLy8gU1FMSW5wdXRWYWx1ZSBhcmUgdHlwZS1vbmx5IGFuZCBlcmFzZWQgYnkgZXNidWlsZCkuXG4gICAgICAgICAgcmV0dXJuIFtcbiAgICAgICAgICAgIFwiaW1wb3J0IHsgY3JlYXRlUmVxdWlyZSBhcyBfX2NyIH0gZnJvbSAnbm9kZTptb2R1bGUnO1wiLFxuICAgICAgICAgICAgXCJjb25zdCBfX3JlcXVpcmUgPSBfX2NyKGltcG9ydC5tZXRhLnVybCk7XCIsXG4gICAgICAgICAgICBcImNvbnN0IF9fc3FsaXRlID0gX19yZXF1aXJlKCdub2RlOnNxbGl0ZScpO1wiLFxuICAgICAgICAgICAgXCJleHBvcnQgY29uc3QgRGF0YWJhc2VTeW5jID0gX19zcWxpdGUuRGF0YWJhc2VTeW5jO1wiLFxuICAgICAgICAgIF0uam9pbignXFxuJyk7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIG51bGw7XG4gICAgICB9LFxuICAgIH0sXG4gIF0sXG4gIHJlc29sdmU6IHtcbiAgICBhbGlhczoge1xuICAgICAgJ0BsaXR0bGVzaGVlcC9icmFuZGluZyc6IHBrZygnYnJhbmRpbmcnKSxcbiAgICAgICdAbGl0dGxlc2hlZXAvY2xhc3NpZmllcic6IHBrZygnY2xhc3NpZmllcicpLFxuICAgICAgJ0BsaXR0bGVzaGVlcC9jaGFubmVsLXdlYmhvb2snOiBjaGFubmVsUGtnKCd3ZWJob29rJyksXG4gICAgICAnQGxpdHRsZXNoZWVwL2NoYW5uZWwtdGVsZWdyYW0nOiBjaGFubmVsUGtnKCd0ZWxlZ3JhbScpLFxuICAgICAgJ0BsaXR0bGVzaGVlcC9jaGFubmVsLWZlaXNodSc6IGNoYW5uZWxQa2coJ2ZlaXNodScpLFxuICAgICAgJ0BsaXR0bGVzaGVlcC9jaGFubmVsLXFxYm90JzogY2hhbm5lbFBrZygncXFib3QnKSxcbiAgICAgICdAbGl0dGxlc2hlZXAvY2xpJzogcGtnKCdjbGknKSxcbiAgICAgICdAbGl0dGxlc2hlZXAvY29uZmlnL21vZGVsLWNhcGFiaWxpdGllcyc6IHBrZ0ZpbGUoJ2NvbmZpZycsICdtb2RlbC1jYXBhYmlsaXRpZXMnKSxcbiAgICAgICdAbGl0dGxlc2hlZXAvY29uZmlnJzogcGtnKCdjb25maWcnKSxcbiAgICAgICdAbGl0dGxlc2hlZXAvY29udGV4dCc6IHBrZygnY29udGV4dCcpLFxuICAgICAgJ0BsaXR0bGVzaGVlcC9leHBlcmllbmNlJzogcGtnKCdleHBlcmllbmNlJyksXG4gICAgICAnQGxpdHRsZXNoZWVwL3BsdWdpbnMnOiBwa2coJ3BsdWdpbnMnKSxcbiAgICAgICdAbGl0dGxlc2hlZXAvaGFybmVzcyc6IHBrZygnaGFybmVzcycpLFxuICAgICAgJ0BsaXR0bGVzaGVlcC9sbG0nOiBwa2coJ2xsbScpLFxuICAgICAgJ0BsaXR0bGVzaGVlcC9tZW1vcnktY29yZSc6IHBrZygnbWVtb3J5LWNvcmUnKSxcbiAgICAgICdAbGl0dGxlc2hlZXAvbWVtb3J5LXRyZWUnOiBwa2coJ21lbW9yeS10cmVlJyksXG4gICAgICAnQGxpdHRsZXNoZWVwL3Byb21wdCc6IHBrZygncHJvbXB0JyksXG4gICAgICAnQGxpdHRsZXNoZWVwL3J1bm5lcic6IHBrZygncnVubmVyJyksXG4gICAgICAnQGxpdHRsZXNoZWVwL3NhZmV0eS92ZXJpZmllZC1hc3NldCc6IHBrZ0ZpbGUoJ3NhZmV0eScsICd2ZXJpZmllZC1hc3NldCcpLFxuICAgICAgJ0BsaXR0bGVzaGVlcC9zYWZldHknOiBwa2coJ3NhZmV0eScpLFxuICAgICAgJ0BsaXR0bGVzaGVlcC9zbmFwc2hvdCc6IHBrZygnc25hcHNob3QnKSxcbiAgICAgICdAbGl0dGxlc2hlZXAvc2Vzc2lvbic6IHBrZygnc2Vzc2lvbicpLFxuICAgICAgJ0BsaXR0bGVzaGVlcC9za2lsbHMnOiBwa2coJ3NraWxscycpLFxuICAgICAgJ0BsaXR0bGVzaGVlcC90b29scyc6IHBrZygndG9vbHMnKSxcbiAgICAgICdAbGl0dGxlc2hlZXAvdHlwZXMnOiBwa2coJ3R5cGVzJyksXG4gICAgICAnQGxpdHRsZXNoZWVwL3ZlY3Rvcic6IHBrZygndmVjdG9yJyksXG4gICAgfSxcbiAgfSxcbiAgdGVzdDoge1xuICAgIGluY2x1ZGU6IFsncGFja2FnZXMvKiovc3JjLyoqLyoudGVzdC50cycsICd0ZXN0LyoqLyoudGVzdC50cycsICdzY3JpcHRzLyoqLyoudGVzdC5tanMnXSxcbiAgICBlbnZpcm9ubWVudDogJ25vZGUnLFxuICAgIHRlc3RUaW1lb3V0OiAzMF8wMDAsXG4gICAgLy8gU1FMaXRlLCBzaGFkb3cgR2l0IGFuZCBNZW1vcnkgdjMgaW50ZWdyYXRpb24gc3VpdGVzIGNvbnRlbmQgaGVhdmlseSBvblxuICAgIC8vIGFuIDggR2lCIFdpbmRvd3MgaG9zdCBhdCBmb3VyIHdvcmtlcnMgYW5kIGNhbiBzdGFydmUgb3RoZXJ3aXNlIHNtYWxsXG4gICAgLy8gUnVubmVyIGNhc2VzIHBhc3QgdGhlIHVuY2hhbmdlZCAzMCBzIHRlc3QgY2VpbGluZy4gVGhyZWUga2VlcHMgdGhlIGZ1bGxcbiAgICAvLyBnYXRlIHJlc291cmNlLWJvdW5kZWQgd2hpbGUgcHJlc2VydmluZyB1c2VmdWwgZmlsZSBwYXJhbGxlbGlzbS5cbiAgICBtYXhXb3JrZXJzOiAzLFxuICAgIG1pbldvcmtlcnM6IDEsXG4gICAgc2VydmVyOiB7XG4gICAgICBkZXBzOiB7XG4gICAgICAgIC8vIEJlbHQtYW5kLXN1c3BlbmRlcnM6IG5ldmVyIG9wdGltaXplL3RyYW5zZm9ybSBub2RlOiogYnVpbHQtaW5zLlxuICAgICAgICBleHRlcm5hbDogWy9ebm9kZTovXSxcbiAgICAgIH0sXG4gICAgfSxcbiAgfSxcbn0pO1xuIl0sCiAgIm1hcHBpbmdzIjogIjtBQUE2USxTQUFTLG9CQUFvQjtBQUMxUyxTQUFTLHFCQUFxQjtBQUR1SSxJQUFNLDJDQUEyQztBQU90TixJQUFNLE1BQU0sQ0FBQyxTQUNYLGNBQWMsSUFBSSxJQUFJLGNBQWMsSUFBSSxpQkFBaUIsd0NBQWUsQ0FBQztBQUUzRSxJQUFNLFVBQVUsQ0FBQyxNQUFjLFNBQzdCLGNBQWMsSUFBSSxJQUFJLGNBQWMsSUFBSSxRQUFRLElBQUksT0FBTyx3Q0FBZSxDQUFDO0FBRzdFLElBQU0sYUFBYSxDQUFDLFNBQ2xCLGNBQWMsSUFBSSxJQUFJLHVCQUF1QixJQUFJLGlCQUFpQix3Q0FBZSxDQUFDO0FBRXBGLElBQU8sd0JBQVEsYUFBYTtBQUFBLEVBQzFCLFNBQVM7QUFBQSxJQUNQO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBLE1BTUUsTUFBTTtBQUFBLE1BQ04sU0FBUztBQUFBLE1BQ1QsVUFBVSxRQUFnQjtBQUN4QixZQUFJLFdBQVcsaUJBQWlCLFdBQVcsVUFBVTtBQUNuRCxpQkFBTztBQUFBLFFBQ1Q7QUFDQSxlQUFPO0FBQUEsTUFDVDtBQUFBLE1BQ0EsS0FBSyxJQUFZO0FBQ2YsWUFBSSxPQUFPLGVBQWU7QUFJeEIsaUJBQU87QUFBQSxZQUNMO0FBQUEsWUFDQTtBQUFBLFlBQ0E7QUFBQSxZQUNBO0FBQUEsVUFDRixFQUFFLEtBQUssSUFBSTtBQUFBLFFBQ2I7QUFDQSxlQUFPO0FBQUEsTUFDVDtBQUFBLElBQ0Y7QUFBQSxFQUNGO0FBQUEsRUFDQSxTQUFTO0FBQUEsSUFDUCxPQUFPO0FBQUEsTUFDTCx5QkFBeUIsSUFBSSxVQUFVO0FBQUEsTUFDdkMsMkJBQTJCLElBQUksWUFBWTtBQUFBLE1BQzNDLGdDQUFnQyxXQUFXLFNBQVM7QUFBQSxNQUNwRCxpQ0FBaUMsV0FBVyxVQUFVO0FBQUEsTUFDdEQsK0JBQStCLFdBQVcsUUFBUTtBQUFBLE1BQ2xELDhCQUE4QixXQUFXLE9BQU87QUFBQSxNQUNoRCxvQkFBb0IsSUFBSSxLQUFLO0FBQUEsTUFDN0IsMENBQTBDLFFBQVEsVUFBVSxvQkFBb0I7QUFBQSxNQUNoRix1QkFBdUIsSUFBSSxRQUFRO0FBQUEsTUFDbkMsd0JBQXdCLElBQUksU0FBUztBQUFBLE1BQ3JDLDJCQUEyQixJQUFJLFlBQVk7QUFBQSxNQUMzQyx3QkFBd0IsSUFBSSxTQUFTO0FBQUEsTUFDckMsd0JBQXdCLElBQUksU0FBUztBQUFBLE1BQ3JDLG9CQUFvQixJQUFJLEtBQUs7QUFBQSxNQUM3Qiw0QkFBNEIsSUFBSSxhQUFhO0FBQUEsTUFDN0MsNEJBQTRCLElBQUksYUFBYTtBQUFBLE1BQzdDLHVCQUF1QixJQUFJLFFBQVE7QUFBQSxNQUNuQyx1QkFBdUIsSUFBSSxRQUFRO0FBQUEsTUFDbkMsc0NBQXNDLFFBQVEsVUFBVSxnQkFBZ0I7QUFBQSxNQUN4RSx1QkFBdUIsSUFBSSxRQUFRO0FBQUEsTUFDbkMseUJBQXlCLElBQUksVUFBVTtBQUFBLE1BQ3ZDLHdCQUF3QixJQUFJLFNBQVM7QUFBQSxNQUNyQyx1QkFBdUIsSUFBSSxRQUFRO0FBQUEsTUFDbkMsc0JBQXNCLElBQUksT0FBTztBQUFBLE1BQ2pDLHNCQUFzQixJQUFJLE9BQU87QUFBQSxNQUNqQyx1QkFBdUIsSUFBSSxRQUFRO0FBQUEsSUFDckM7QUFBQSxFQUNGO0FBQUEsRUFDQSxNQUFNO0FBQUEsSUFDSixTQUFTLENBQUMsZ0NBQWdDLHFCQUFxQix1QkFBdUI7QUFBQSxJQUN0RixhQUFhO0FBQUEsSUFDYixhQUFhO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQSxJQUtiLFlBQVk7QUFBQSxJQUNaLFlBQVk7QUFBQSxJQUNaLFFBQVE7QUFBQSxNQUNOLE1BQU07QUFBQTtBQUFBLFFBRUosVUFBVSxDQUFDLFFBQVE7QUFBQSxNQUNyQjtBQUFBLElBQ0Y7QUFBQSxFQUNGO0FBQ0YsQ0FBQzsiLAogICJuYW1lcyI6IFtdCn0K
