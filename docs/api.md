# API 约定

## 阅读笔记与证据（M2）

- `GET /api/topics/:topicId/notes`：返回 `{ notes }`，每条标明原文献及是否仍关联主题。
- `GET /api/topics/:topicId/documents/:documentId/notes`：返回 `{ notes, linked, fields, suggestions }`，包括通用字段和最近 10 次笔记建议任务。
- `POST /api/topics/:topicId/documents/:documentId/notes`：创建笔记，返回 201；新建要求文献已关联主题。
- `GET /api/notes/:id`：笔记与历史版本。移出主题后仍能访问已保存笔记。
- `PATCH /api/notes/:id`：编辑、核对、归档或恢复，必须携带当前 `revision`；版本冲突返回 409。

创建笔记的通用字段是 `id`（可选 UUID，浏览器固定提供以保证请求重试幂等）、`field`（1–80 字，自由命名）、`content`（最多 10000 字）、`kind`（`source` / `inference` / `user`）、`status`（`recorded` / `not_reported` / `not_applicable` / `not_found`）。`recorded` 要求非空内容，其他状态允许留空。已记录的原文报告和模型归纳要求原文证据。

来源与引用：

- 手工笔记：`origin: { "type": "manual" }`，默认类型为 `user`。
- 原文笔记：`origin: { "type": "reference" }`，同时提供 `referenceIds` 和 `GET /api/documents/:id` 返回的 `evidenceVersion`（以 `documentVersion` 字段提交）；默认类型为 `source`。
- 问答结论：`origin: { "type": "answer", "runId": "...", "claimIndex": 0 }`。服务端读取已完成任务中指定结论及其引用；归纳类型必须来自对应模型结论。
- 问答中的原文：`origin: { "type": "answer", "runId": "...", "referenceId": "ref_00001" }`。该片段必须属于本次任务读取的证据。

服务端生成 `evidence[]` 快照，客户端不能直接写入。每项含文献 ID、解析指纹、原文与定位；响应另含 `matchesCurrent`。旧任务没有指纹、或解析发生变化时返回 false，保留快照并阻止错误定位。最多关联 12 个片段。

修改普通字段示例：`{ "revision": 1, "field": "方法", "content": "修订后的理解" }`。省略引用字段会保留原快照；显式提交 `referenceIds` 和 `documentVersion` 则重新选择当前证据。修改内容或证据后重新标记待核对。

核对完成：`{ "revision": 2, "reviewState": "checked" }`，必须在保存内容后单独提交，且证据版本仍有效。归档／恢复归档：`{ "revision": 3, "archived": true }`。恢复历史版本：`{ "revision": 4, "restoreRevision": 1 }`，创建一个新版本，保留历史。

`POST /api/topics/:topicId/documents/:documentId/note-suggestions` 接受 `{ "field": "方法" }`，返回 202 与问答任务。需要已配置模型；未配置返回 409。任务携带 `purpose=note-suggestion`、主题和字段，复用 `/api/runs/:id` 查询与取消，且不混入普通问答历史。完成任务本身不会写入或覆盖笔记。

## 研究主题与文献组织（M1）

`GET /api/topics` 返回 `{ topics: [...] }`，每项含主题标题、问题、范围、时间和 `documentCount`、`includedCount`、`readCount`。

`POST /api/topics` 创建主题，返回 201：

```json
{ "title": "研究方法比较", "question": "不同条件如何影响结果？", "scope": "近五年相关研究" }
```

标题和研究问题必填；范围选填。`PATCH /api/topics/:id` 部分更新这三个字段；`GET /api/topics/:id` 返回详情，其 `documents[]` 含关联状态和 `document` 文献摘要。

- `PUT /api/topics/:id/documents/:documentId`：关联已有文献，返回 200；重复调用不重置记录。
- `PATCH /api/topics/:id/documents/:documentId`：部分更新 `selection`（`pending` / `included` / `excluded`）、`readingStatus`（`unread` / `reading` / `read`）、`relevance` 与 `reason`。
- `DELETE /api/topics/:id/documents/:documentId`：移除关联，返回 200；保留文献、原文、问答和其他主题关联。

三个关联接口均返回更新后的主题详情。状态与理由按主题分别保存。

`PATCH /api/documents/:id` 接受以下部分字段，返回更新后的文献摘要：

```json
{ "title": "文献标题", "authors": "张三；李四", "year": "2024", "venue": "期刊或会议", "doi": "10.1234/example", "url": "https://example.org/paper" }
```

书目信息全局共享，返回值中除 `title` 外的编辑字段位于 `bibliography`。标题不能为空；其余字段可以留空，年份为四位数字，来源链接限 HTTP(S)。未知字段、超限或非法值返回 422；非法 ID 返回 400，不存在的记录返回 404。UUID 忽略大小写，统一以小写标识记录、关联和导入目标。字段长度及持久化规则见 [M1 实现说明](m1-implementation.md)。

## 文档

`POST /api/documents` 使用 `multipart/form-data`，字段名为 `file`，可选 `topicId` 将文献关联到指定研究主题。支持 PDF、DOCX、Markdown、TXT 和 HTML。响应包含完整解析文本、引用片段和警告。

`GET /api/documents` 返回文献目录，`GET /api/documents/:id` 返回文献与问答任务，`GET /api/documents/:id/original` 返回原文件。

## 问答任务

`POST /api/documents/:id/questions`

```json
{ "question": "作者使用了什么方法？" }
```

接口返回 `202` 和任务 ID。客户端轮询 `GET /api/runs/:id`，状态包括 `queued`、`running`、`completed`、`failed`、`cancelled`、`interrupted`。运行中的任务可通过 `POST /api/runs/:id/cancel` 中止。

模型回答中的每个 claim 必须声明 `kind`：`source` 表示原文事实，`inference` 表示基于证据的归纳，并带有本轮实际读取的 `referenceIds`。验证失败时 API 保留抽取式证据结果。

## 后台导入（工作台默认使用）

`POST /api/imports`：multipart 表单 `file`，可选 `mode=auto|ocr|vision` 和 `topicId`。默认 auto，全页 OCR 为 ocr；vision 需要独立视觉配置，只有显式选择才会发送页图。返回 202 及导入任务。

指定 `topicId` 时，服务在解析前校验主题，任务保存原目标主题并在服务端完成关联。客户端切换主题或刷新不改变导入归属。任务完成状态表示文献与关联均已保存；若文献保存后关联失败，任务仍返回 `documentId`，可从全部文献重新关联。

`GET /api/imports/:id`：任务含 `status`、`progress.page`、`progress.totalPages`、`progress.message`；完成后有 `documentId`。状态为 queued / running / completed / failed / cancelled / interrupted。

`POST /api/imports/:id/cancel`：取消运行中的解析。服务重启会将未完成的导入标记为 interrupted。

`GET /api/parser-capabilities`：本地 OCR 是否可用、已安装 / 缺失语言，以及视觉模型是否配置；不返回密钥。

`GET /api/documents/:id/pages/:page`：PDF 页图 PNG，页码从 1 开始，用于核对引用。正在渲染其他页图时可能返回 429，请稍后重试。

旧 `POST /api/documents` 仍支持同步返回，但复杂文档应使用后台导入。同步接口使用本地自动模式。

文档 `schemaVersion=2` 新增 `sections[].blocks[]` 和引用的类型、来源、坐标及待核对标记；旧文档仍可读取，重新导入获得新的结构信息。详情见 [复杂文档解析](document-parsing.md)。
