# LittleSheep 插件开发说明

最后更新：2026-07-13

本文件定义 LittleSheep 插件系统的当前事实、开发契约和安全边界。插件用于给 LS 增加可选能力，但不能改变“本地核心在没有插件时仍可完整运行”的约束。

## 定位与边界

```text
Electron Main (product composition root)
  |-> Local App API -> Runner -> Harness / Memory / Sessions / Built-in Tools
  |                     ^
  |                     +-- validated tool contributions + owner-scoped Skill sources
  +-> PluginHost -> optional channel / tool / Skill contributions
```

- Local App API 是 Electron renderer 与主进程之间的本地桥，不是插件，也不是外部渠道服务。
- `PluginHost` 是扩展运行时，负责发现、校验、激活、停用、错误隔离和贡献清理。
- Runner 与 `PluginHost` 由 Electron 主进程并列装配；插件工具通过受控迁移进入 Runner 的 ToolRegistry，PluginHost 不拥有 Runner，也不参与 Harness 状态转移。
- Webhook、Telegram、飞书和 QQ Bot 都是渠道插件。未配置对应渠道时，宿主不会加载其实现。
- 独立技能与插件不是一回事：独立 Skill 由 SkillLoader/技能配置管理；插件可以声明自己拥有的 Skill，但其启停、冲突、迁移和移除仍由 PluginHost 统一控制。
- 插件失败不得阻止 Runner、本地聊天、记忆树、会话和工作区启动。

## API v1 能力矩阵

| 贡献类型 | 状态 | 宿主接口 | 消费方 |
| --- | --- | --- | --- |
| `channel` | 已接通 | `registerChannelType()` | 外部渠道管理器 |
| `tool` | 已接通 | `registerTool()` | Runner 的 ToolRegistry；完整执行生命周期仍待统一服务收敛 |
| `skill` | 已接通 | manifest 中的 `contributes.skills` | SkillLoader、`use_skill` 与记忆资源目录；正文按需读取 |
| `provider` | 未接通 | 无 | 规划中的模型供应商扩展 |
| `memory` | 未接通 | 无 | 规划中的记忆分支扩展 |
| `workspace` | 未接通 | 无 | 规划中的工作区扩展 |
| `automation` | 未接通 | 无 | 规划中的计划任务扩展 |
| `ui` | 未接通 | 无 | 规划中的受控 renderer 扩展 |

API v1 的 manifest 当前接受 `channel`、`tool` 和 `skill`。其余方向是明确的后续扩展位，不是当前可用能力。新增扩展位前必须先完成宿主接口、权限、生命周期、持久化、错误恢复和消费方，再升级 API 版本。

## 目录与数据

默认用户数据目录由 `@littlesheep/branding` 决定。插件相关目录为：

```text
<user-data>/
  plugins/
    <plugin-id>/
      littlesheep.plugin.json
      index.mjs
      skills/
        <skill-name>/
          SKILL.md
  plugin-data/
    <plugin-id>/
      ...插件自己的持久化数据
```

- `plugins/` 是安装目录，宿主扫描该目录本身和它的直接子目录。
- `config.json` 中的 `plugins.extraDirs` 可增加额外扫描根目录。
- `plugin-data/<plugin-id>/` 由宿主创建，并通过 `context.dataDir` 交给插件。
- 插件不得把密钥、运行日志或用户数据写进源码仓库。
- 当前没有自动安装、升级和卸载器；本地插件以手动放置和“设置 -> 插件 -> 重新加载”为主。

## Manifest 契约

每个本地插件必须包含 `littlesheep.plugin.json`。下面是一个工具插件的最小示例：

```json
{
  "id": "example.local.echo",
  "name": "Echo 工具",
  "version": "1.0.0",
  "apiVersion": 1,
  "description": "把输入原样返回给 Agent。",
  "publisher": "Example",
  "capabilities": ["tool"],
  "permissions": ["tools:register"],
  "activationEvents": ["onStartup"],
  "contributes": {
    "channels": [],
    "tools": ["example_echo"],
    "skills": []
  },
  "main": "./index.mjs"
}
```

关键规则：

1. `id` 只能使用小写字母、数字、点、下划线和连字符，并且全局唯一。
2. `apiVersion` 当前必须为 `1`。
3. capability、permission、activation event 和 contribution 不能重复。
4. 渠道贡献必须同时声明 `channel` 和 `channels:register`；工具和 Skill 分别声明 `tool` + `tools:register`、`skill` + `skills:register`。
5. `main` 必须是插件目录内已存在的相对路径，不能使用绝对路径或 `..` 逃逸目录。
6. 工具插件通常使用 `onStartup`；渠道插件可以使用 `onChannel:<type>` 按需激活；贡献 Skill 的插件必须使用 `onStartup`，保证所有权状态在运行开始前确定。
7. 运行时模块的 manifest 必须与磁盘 manifest 一致；`main` 仅属于安装信息，运行时可省略。

## 模块契约

入口模块必须导出 `default`、`plugin` 或 `littleSheepPlugin`，对象需要包含 `manifest` 和 `activate(context)`：

```js
const manifest = {
  id: 'example.local.echo',
  name: 'Echo 工具',
  version: '1.0.0',
  apiVersion: 1,
  description: '把输入原样返回给 Agent。',
  publisher: 'Example',
  capabilities: ['tool'],
  permissions: ['tools:register'],
  activationEvents: ['onStartup'],
  contributes: { channels: [], tools: ['example_echo'], skills: [] },
}

export default {
  manifest,
  activate(context) {
    context.registerTool({
      name: 'example_echo',
      description: 'Return the supplied text.',
      inputSchema: {
        parse(input) {
          if (!input || typeof input.text !== 'string') throw new Error('text is required')
          return input
        },
      },
      async execute(input) {
        return { callId: '', ok: true, output: input.text }
      },
    })
    context.log('info', `data directory: ${context.dataDir}`)
  },
}
```

宿主会校验注册项是否在 manifest 中声明。工具名冲突、渠道类型冲突、Skill 缺失/无效/同名遮蔽、未声明 capability 或 permission 都会让插件进入 `failed` 状态，并清理已经注册的贡献。

### 声明插件 Skill

插件 Skill 使用固定目录 `<plugin-root>/skills/<entry>/SKILL.md`，manifest 的 `contributes.skills` 填写 `SKILL.md` frontmatter 中的 `name`。例如：

```json
{
  "capabilities": ["skill"],
  "permissions": ["skills:register"],
  "activationEvents": ["onStartup"],
  "contributes": {
    "channels": [],
    "tools": [],
    "skills": ["project-planner"]
  }
}
```

PluginHost 只把 `active` 插件的 Skill 放入可调用索引；`disabled`、`blocked`、`failed` 插件仍保留元数据登记，但状态不可调用。插件升级或换目录时，资源 ID 按“插件 ID + Skill 名称”保持稳定，来源路径通过 `rebind` 审计迁移；插件消失后登记保留为 `missing`，不会删除来源文件或伪装成仍可用。

渠道插件通过 `registerChannelType(type, factory)` 注册工厂。渠道实例必须实现 `type`、`displayName`、`requiredSecrets`、`running`、`start(context)` 和 `stop()`；消息会由渠道上下文送入 Runner，渠道实现不应自行复制 Agent 核心。

## 生命周期与状态

插件状态包括：

| 状态 | 含义 |
| --- | --- |
| `disabled` | 用户明确停用。 |
| `inactive` | 已发现，但当前没有满足激活条件。 |
| `activating` | 正在加载并注册贡献。 |
| `active` | 贡献已注册。 |
| `blocked` | 本地代码尚未获得用户信任。 |
| `failed` | 加载、校验、注册或迁移失败。 |

- `reload()` 按“停止贡献 -> 重新发现 -> 重新激活”的顺序执行。
- Runner 因模型/API key 变化重建时，工具贡献会迁移到新 ToolRegistry，插件 Skill 来源也会迁移到新 SkillLoader 和同一记忆注册表；冲突不会覆盖新 Runner 的同名工具或技能。
- 宿主停用插件时会清理已注册工具和渠道类型；插件自己的定时器、文件句柄等资源仍应在可选的 `deactivate()` 中释放。
- 插件 Skill 的生命周期由 PluginHost 独占。记忆树资源目录只展示来源、状态和审计，不提供绕过插件页面的停用、恢复或移除按钮。
- 渠道轮询和重连等待应使用 `@littlesheep/plugins` 导出的 `abortableDelay()`；该辅助函数会在正常完成和取消时都移除 `AbortSignal` 监听器，避免长连接反复等待造成监听器累积。
- 单个插件或渠道启动失败只记录到该插件/渠道状态，不终止核心宿主。

## 信任与权限

本地插件在 Electron 主进程中执行，当前没有进程级或 VM 级代码沙箱。manifest 中的权限声明用于审查、管理界面展示和注册接口校验，不能阻止插件代码直接调用 Node.js API。

因此有以下硬约束：

1. `plugins.allowLocalCode` 默认是 `false`。
2. 用户必须在“设置 -> 插件”中经过高风险二次确认，才会执行本地插件代码。
3. 开启该选项等同于完全信任已安装本地插件；来源不明的代码不应启用。
4. 内置插件随应用发布，属于应用构建信任边界，但仍需通过同一 manifest 和贡献校验。
5. 未来若要支持低信任第三方生态，应优先增加独立进程、IPC 权限代理、签名和资源配额，而不是把 manifest 声明误称为沙箱。

未获得本地代码信任的插件不会执行入口模块，其 Skill 也不会进入可调用索引。宿主可以读取受限的 Skill frontmatter 以显示声明和所有权状态，但正文不会因此注入模型上下文。

## 配置与管理接口

```json
{
  "plugins": {
    "disabled": [],
    "extraDirs": [],
    "allowLocalCode": false
  }
}
```

Local App API 提供：

- `GET /plugins`：清单、来源、状态、贡献、权限和发现诊断。
- `POST /plugins/reload`：重新读取配置、发现并加载插件。
- `POST /plugins/:id/enabled`：启用或停用一个已发现插件。
- `POST /plugins/local-code`：更新本地代码信任闸门。
- `GET /channels/status`、`POST /channels/reload`：管理由插件贡献的外部渠道。

renderer 只通过这些接口管理插件，不直接 import 或执行第三方模块。

## 维护与验证

插件系统变更至少运行：

```powershell
pnpm.cmd exec vitest run packages/skills/src/loader.test.ts packages/memory-tree/src/memory-service.test.ts packages/plugins/src/manifest.test.ts packages/plugins/src/host.test.ts packages/plugins/src/local-loader.test.ts packages/app/src/main/builtin-plugins.test.ts
pnpm.cmd --filter @littlesheep/plugins typecheck
pnpm.cmd --filter @littlesheep/app typecheck
```

合入前仍需执行全仓质量门：

```powershell
pnpm.cmd run check:repo
pnpm.cmd test
pnpm.cmd run typecheck
pnpm.cmd run build
pnpm.cmd run verify:app-recovery
```

新增能力时必须覆盖：合法/非法 manifest、未启用不加载、显式信任、本地入口逃逸、重复 id、贡献冲突、激活失败隔离、Runner 重建迁移、插件 Skill 启停/移除/路径迁移/同名冲突、停用清理和内置目录与实际模块 manifest 一致性。
