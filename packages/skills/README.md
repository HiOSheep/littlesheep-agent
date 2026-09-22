# @littlesheep/skills

加载和调用声明式 Skill，并保持来源和拥有者可追踪。

最后更新：2026-09-22 12:43:39

## 职责与边界

- 公开入口是 `src/index.ts`；加载与索引在 `loader.ts`，调用在 `use_skill.ts`。
- Skill 按 builtin、user、external、plugin 四种 owner/source 治理：来源可带 `ownerId`、`enabled` 和 `include` 白名单，索引区分 active / disabled / shadowed；非 LS 所有的来源文件默认只能停用登记，不能删除。
- 自动创建 Skill 已随极简方案移除：没有 `create_skill` 工具，运行期不再生成 Skill。`loader.ts` 里的 `writeSkillFile` 只是给拥有者一侧使用的写入助手，`registerDynamic` 用于每轮内容（如 TaskBook）的临时条目。
- Skill 提供可复用说明和流程，不绕过工具权限、Memory Service 或 PluginHost 生命周期。
- 禁止把未信任本地代码伪装成声明式 Skill 执行。

## 依赖与数据

- 仅依赖 zod 和公共契约；Runner 与 PluginHost 提供真实拥有者状态（PluginHost 通过 `replaceOwnedSources` 注入插件 Skill 来源）。
- 用户 Skill 属于用户数据，插件 Skill 的生命周期由插件拥有者控制。

## 测试与修改定位

- 加载和调用测试与实现同目录（`loader.test.ts`、`use_skill.test.ts`）。
- 新格式必须保留来源、稳定 ID、启停和移除语义。
