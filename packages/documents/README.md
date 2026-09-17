# @littlesheep/documents

共享的常规文档处理内核。负责对 PDF、DOCX、XLS/XLSX、CSV/TSV 和 PPTX
进行有界读取，并生成和重新校验 PDF、DOCX、XLSX 与 CSV 产物。

本包不处理 Agent 权限。调用方必须在读取或写入前通过 LS 的路径校验与授权检查。
