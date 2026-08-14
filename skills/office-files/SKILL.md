---
name: office-files
description: 读取或生成 PDF、Word DOCX、Excel XLS/XLSX、CSV/TSV 或 PowerPoint PPTX 时使用；要求结构化提取、真实文件产物和生成后校验。
---

# 常规文件

1. 用户附加文件时，先用 `inspect_attachment`；工作区文件用 `document_read`。PDF 按需限定页码，Excel 按需限定工作表。若结果被截断，只补读相关范围。
2. 生成 PDF/DOCX 用 `document_create.blocks`；生成 XLSX/CSV 用 `document_create.sheets`。数值和布尔值保持真实类型；公式单元格必须同时给出已核对的 `value`，不得声称 LS 已计算公式。
3. 保留源文件，默认写到工作区内的新路径。不要用普通 `write` 生成二进制文件。
4. 只有 `document_create` 返回 `verified: true` 才能宣布交付完成；最终回复给出产物路径，并明确任何截断、扫描版 PDF 无文本或格式限制。
5. `.doc/.ppt/.pps` 等旧二进制格式无法可靠读取时，请用户先转为 DOCX/PPTX。扫描版 PDF 无文本时说明需要 OCR，不得猜测内容。
