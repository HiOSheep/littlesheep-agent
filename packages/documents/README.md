# @littlesheep/documents

共享的常规文档处理内核。负责对 PDF、DOCX、XLS/XLSX、CSV/TSV 和 PPTX
进行有界读取，并生成和重新校验 PDF、DOCX、XLSX 与 CSV 产物。

最后更新：2026-09-23 01:50:40

## 入口与拥有范围

- 根入口 `src/index.ts` 导出 `extractDocument`（格式路由 + 读取预算）、`createDocument`、`verifyDocument`、`DocumentTargetExistsError` 和共享类型。
- `createDocument` 支持 `createOnly: true`：目标已存在时以独占创建（`wx`）失败并抛 `DocumentTargetExistsError`，而不是"先检查不存在再普通覆盖写"——后者与任何并发写入者之间存在竞态。Agent 侧一律使用该模式。
- `./office-preview` 子路径导出 `previewOfficeDocument`，为 UI 适配器提供带显式预算的 Office/OpenDocument 只读预览投影。
- 读取：pdfjs-dist（PDF）、mammoth 与 jszip（DOCX 系）、xlsx（XLS/XLSX、CSV/TSV 系）、jszip（PPTX 系）。
- 写入：pdfkit（PDF）、docx（DOCX）、xlsx（XLSX/CSV）；写前校验输入、写后重新打开校验结构，公式错误一律判失败。
- 预算集中在 `limits.ts` 与各模块常量（文件字节、抽取字符、section/行/列数、ZIP 条目与 XML 展开），超限是显式截断或错误，不做静默降级。

## 边界

- 本包不处理 Agent 权限，也不持有路径授权结论。调用方必须在读取或写入前通过 LS 的路径校验与授权检查；`office-preview` 只接收调用方提供的 loader，自己不接触任意路径。
- 不负责 UI 渲染、网络访问、记忆写入或提示词；不计算 Office 公式，公式单元格必须携带已核验的缓存值。
