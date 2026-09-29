# LittleSheep 核心 Agent 流程规范

本文定义主循环、证据、恢复和记忆提交的稳定约束。系统责任与安全边界见[架构原则](architecture-principles.md)；当前 stage manifest 见[Core Flow 状态契约](../reference/core-flow-state-contract.md)。

## 当前主路径

ENTER → 确定性活动路由 → 常规会话与工具工作进入 execute 单一主循环 → VERIFY → FINALIZE。
能力或状态询问走 REPLY 的 Runtime 事实契约；权限拒绝或恢复预算耗尽升级至 ASK_USER。

活动路由只选择 execute 或能力 / 状态 reply。复杂度、检索需求和续接是执行时的解释性信息，不产生第二次规划请求。DECIDE、验证模型调用、恢复模型调用和 CAPTURE 不存在；ASK_USER 不是路由活动。

模型可直接回应或请求受控工具。Runtime 在每次调用前重新校验权限与参数，执行后清洗结果、记录证据并把结果追加回同一循环。多步工作在同一循环中继续。已持久化 TaskBook 只作为旧数据读取，不触发第二个执行器。

## 提问与回复发布

模型通过 request_user_input 发起提问。同批的其他工具调用不执行，带原因的拒绝结果进入转录，提问本身仍可发布。Runtime 的权限拒绝或恢复预算耗尽也可升级至 ASK_USER。

用户可见自然语言必须来自本轮真实 LLM 调用。Runtime 发布前登记 run 与规范化文案身份；身份重复时不得重发或替换文案。模型不可用、回复为空或登记失败时，只呈现 Runtime 状态与执行证据，不使用固定模板伪装成 Agent 回复。

## VERIFY 与 RECOVER

VERIFY 不调用模型，只判断 Runtime 已记录证据。有限的窄结构形态可以判定 pass；其他已完成且调用证据完整的 run 标为 unverified，表示验收需要人工判断。缺失、失败、截断或副作用未结算不能变成 pass。

区分两种记录：

- approval_denied、approval_unavailable 和 hard_denied 代表用户尚未决定，必须请求用户决定。
- Runtime 执行前的 validation_failed、unknown_tool、repeated_call_blocked，以及已记录的 failed、timed_out、aborted，是确定负结果；照实保留，不把已交付的 run 改成泛化提问。

RECOVER 由 Runtime 按事实路由，不请求恢复模型。可重试失败回到失败阶段并受预算限制；已完成步骤不得重复执行。副作用未结算或 run 中止时显式停止。模型调用预算耗尽直接升级。结构性证据缺口只允许 execute 一次补齐机会，仍未闭合则升级。

## Memory 介入

Memory Tree 的导航读取默认只从根索引开始，逐层沿分支前进；只有分支索引不足时才允许该分支深搜。向量只能提名候选，不能决定事实相同、合并或纠正目标。

memory_write 是 durable 写入入口，需批准且每次 run 最多四条。user-request 必须引用本会话里真实的记忆指令；necessary 要说明用途及不保存将失去什么。来源必须完整且可校验。memory_manage 只处理用户亲口要求的忘记或纠正，并核对目标和 revision。压缩只写会话摘要，不生成长期记忆候选。

## 约束与验收

Runtime 负责权限、状态、工具范围、验证和最终结算；Prompt 仅告知模型当前需要知道的策略。工具拒绝、恢复预算、重试和无进展上限都由代码实现，并由当前路径契约与专项测试阻止第二执行器或退休 stage 重新接入。

每条验证说明必须指出被观察到的证据及边界。真实模型、Electron、持久化恢复和打包验收分别记账，不能以静态检查或旧任务书替代。
