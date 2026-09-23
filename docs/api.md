# API 约定

## 文档

`POST /api/documents` 使用 `multipart/form-data`，字段名为 `file`。支持 PDF、DOCX、Markdown、TXT 和 HTML。响应包含完整解析文本、引用片段和警告。

`GET /api/documents` 返回文献目录，`GET /api/documents/:id` 返回文献与问答任务，`GET /api/documents/:id/original` 返回原文件。

## 问答任务

`POST /api/documents/:id/questions`

```json
{ "question": "作者使用了什么方法？" }
```

接口返回 `202` 和任务 ID。客户端轮询 `GET /api/runs/:id`，状态包括 `queued`、`running`、`completed`、`failed`、`cancelled`、`interrupted`。运行中的任务可通过 `POST /api/runs/:id/cancel` 中止。

模型回答中的每个 claim 必须声明 `kind`：`source` 表示原文事实，`inference` 表示基于证据的归纳，并带有本轮实际读取的 `referenceIds`。验证失败时 API 保留抽取式证据结果。

## 后台导入（工作台默认使用）

`POST /api/imports`：multipart 表单 `file`，可选 `mode=auto|ocr|vision`。默认 auto，全页 OCR 为 ocr；vision 需要独立视觉配置，只有显式选择才会发送页图。返回 202 及导入任务。

`GET /api/imports/:id`：任务含 `status`、`progress.page`、`progress.totalPages`、`progress.message`；完成后有 `documentId`。状态为 queued / running / completed / failed / cancelled / interrupted。

`POST /api/imports/:id/cancel`：取消运行中的解析。服务重启会将未完成的导入标记为 interrupted。

`GET /api/parser-capabilities`：本地 OCR 是否可用、已安装 / 缺失语言，以及视觉模型是否配置；不返回密钥。

`GET /api/documents/:id/pages/:page`：PDF 页图 PNG，页码从 1 开始，用于核对引用。正在渲染其他页图时可能返回 429，请稍后重试。

旧 `POST /api/documents` 仍支持同步返回，但复杂文档应使用后台导入。同步接口使用本地自动模式。

文档 `schemaVersion=2` 新增 `sections[].blocks[]` 和引用的类型、来源、坐标及待核对标记；旧文档仍可读取，重新导入获得新的结构信息。详情见 [复杂文档解析](document-parsing.md)。
