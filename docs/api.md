# API 约定

## 模型连接（D3）

这些接口使用 `Cache-Control: no-store`，不会返回 API Key。

- `GET /api/settings/text-model`：返回 `url`、`model`、`hasKey`、`editable`、`canRevoke`、`persistence`（`session` / `remembered`）、`canRemember`、`credentialProtection`、`settingsWarning` 和 `connectionTest`。测试状态为 `untested`，或带 `checkedAt` 的 `passed`，仅绑定当前配置并在当前后端运行中保留 10 分钟。
- `PATCH /api/settings/text-model { url, model, key, remember? }`：启用连接。地址最长 2000 字符，模型名称 200，密钥 8192；外部服务须 HTTPS，本机 HTTP 只允许回环。地址不得包含凭据、查询参数或片段。同一地址的空密钥保留已有值；更换地址需要重新填写。省略 `remember` 保留现有选择，新连接默认会话；环境不支持系统保护时 `remember: true` 返回 409。
- `PATCH /api/settings/text-model { clear: true }`：清除文字连接与记住的设置，禁止新任务使用；已启动任务保留原配置。清除文件失败返回 503，同时禁用新任务并提示重开可能恢复。
- `POST /api/settings/text-model/test { url, model, key }`：只向所填连接发送固定合成文字，成功返回 `{ state: "passed", checkedAt, durationMs }`。不启用连接、不读取资料库、不保存研究任务。最多同时一个测试，冲突返回 429；20 秒超时、响应上限 64 KiB，拒绝重定向。认证／额度／响应问题等返回安全的 422 错误，不包含供应商正文；保存同一配置后才反映为当前连接已测试。
- `POST /api/settings/text-model/test/cancel`：停止测试并清除本次通过状态，返回 `{ stopped: true }`。更新／清除连接、文字或全部授权撤销、服务关闭也会停止测试。
- `POST /api/settings/model-authorization/revoke { scope }`：`scope` 为 `text`、`vision` 或 `all`。立即禁止对应旧配置的后续发送并取消任务；成功后清除对应设置，文字撤销同时清除记住的连接。返回当前文字设置及 `revokedScope`；持久清理失败返回 503，内存授权已撤销。页图撤销不会取消文字测试。

普通更新保留在途任务快照；撤销先中断授权，后等待持久清理，慢保存无法重新启用已撤销配置。详情见 [模型连接说明](d3-model-connection.md)。

## 研究成果（M4）

- `GET /api/topics/:topicId/reports`：成果摘要列表，包含归档项。
- `GET /api/topics/:topicId/report-materials`：当前主题可选的笔记、比较表及文献目录。
- `POST /api/topics/:topicId/reports`：创建成果，返回 201。字段为可选 `id`（UUID，用于幂等重试）、`title`（最多 200 字符）、可选 `question`（默认主题问题，最多 4000 字符）、可选 `sources` 和 `blocks`。首次正文复用下方段落校验，与标题及材料一起保存到版本 1；不传 `blocks` 时创建空正文。
- `GET /api/reports/:id`：成果、段落、材料与原文快照、派生复核状态及最近建议任务。
- `PATCH /api/reports/:id`：携带 `revision`，更新 `title`、`question`、`blocks`、`sources`、`archived`；并发冲突返回 409。
- `GET /api/reports/:id/history`：当前成果与完整历史。通过 `PATCH { revision, restoreRevision }` 恢复为新版本。

`sources` 最多 20 组，同一笔记、比较表或原文献只选择一次：

- 笔记：`{ type: "note", id, revision }`。
- 比较表：`{ type: "comparison", id, revision }`，包含所选表的全部比较项和综合判断，保留条件、可比性及缺失状态。
- 原文：`{ type: "passages", documentId, documentVersion, referenceIds }`，每篇选择 1–12 个片段。
- 保留已有快照：`{ type, id, retain: true }`；原文使用 `documentId`。只接受该成果已保存的材料，不能伪造快照。

新选材料须属于当前主题，其文献仍在主题中；材料版本或原文已变化时返回 409。材料快照最多 120 个去重原文片段、合计 240000 字符。更新材料保留正文已引用的旧证据；没有被当前材料或正文使用的证据移入历史。来源书目信息随选择时的快照保存。

`blocks` 最多 40 段，全文最多 30000 字符。每段为 `{ id?, section, text, kind, citationIds }`，章节标题最多 120 字符，正文最多 4000 字符。`kind` 为 `source`（原文报告）、`inference`（模型归纳）、`user`（用户判断）、`question`（待验证问题）。前两种必须引用已选证据；模型归纳只能继承模型草稿或对应材料的来源。每段最多 24 个引用。客户端不能写入来源身份或核对状态。

完整成果编辑的 `PATCH /api/reports/:id` 接受最多 1 MiB 的 JSON 请求体，以容纳正文、章节标题及引用 ID 序列化后的字节数；上述字段限制仍适用。其他 JSON 接口保持 128 KiB 上限。超限返回 413，并注明实际请求大小上限。

- `POST /api/reports/:id/assemble { revision }`：将尚未加入的材料条目追加到正文。相同条目内容和证据只加入一次；已人工编辑的段落保留，材料变化后只追加发生变化的条目，删除段落后可再次加入。没有新条目时返回当前成果，不增加版本与历史；版本过期仍返回 409。超出段落或长度上限时整次拒绝。无需配置模型。
- `PATCH /api/reports/:id { revision, reviewBlockId }`：单独确认已保存段落的核对状态；材料或原文已变化时拒绝。
- `POST /api/reports/:id/suggestions { revision }`：生成待审阅草稿，返回 202 和 `purpose=report-suggestion` 的任务。只读取所选材料；完整模型输入最多 100000 字符，注明有限阅读。复用 `/api/runs/:id` 查询和取消。
- `POST /api/reports/:id/adopt { revision, runId }`：明确采用草稿并替换正文，原正文进入历史。成果版本、材料、原文或主题关联变化时拒绝旧建议。
- `GET /api/reports/:id/export?revision=N&format=docx`：下载指定当前版本的 Word 文件；`format=markdown` 或省略格式保留既有 Markdown 下载。两种格式均含段落判断类型、复核状态、条件说明、引用清单、书目信息、原文摘录与页码或段落位置。Word 引用编号带内部跳转书签，PDF 页码指原文件位置；格式不支持返回 422，版本不符或尚无非空已保存正文返回 409。草稿须先明确采用后才属于导出正文。UTF-8 附件名分别使用 `.docx`／`.md`；详情见 [DOCX 说明](d4-docx-export.md)。

响应中的 `evidence[].matchesCurrent`、`sources[].changed`、`blocks[].outdated` 为派生状态，不改写历史快照。移出主题不删除成果或引用；解析变化后保留旧摘录并阻止错误跳转。Markdown 将用户和原文内容作为文字转义，不执行嵌入 HTML 或图片。

## 多文献比较（M3）

- `GET /api/topics/:topicId/comparisons`：比较表摘要列表，包含归档项。
- `POST /api/topics/:topicId/comparisons`：创建比较表，返回 201。字段为可选 `id`（UUID，用于幂等重试）、`title`、可选 `question`（默认主题问题）、`documentIds`（2–12 个当前主题文献 ID）和 `columns`。
- `columns` 为 1–12 个 `{ id?, name, description? }`；标题最多 200 字，问题 4000 字，维度名称 80 字、说明 1000 字。省略维度时创建方法、研究对象、主要发现和局限四项。
- `GET /api/comparisons/:id`：定义、文献摘要、全部比较项、综合判断及最近建议任务。
- `PATCH /api/comparisons/:id`：携带 `revision`，部分修改标题、问题、文献和维度，或使用 `archived` 归档／恢复。移除项保存在历史中。
- `GET /api/comparisons/:id/history`：详情与历史。历史引用的 `matchesCurrent` 按原文献的当前解析版本校验，包括已从比较表移除的文献；原文缺失或版本变化时为 `false`。`PATCH` 提交 `{ revision, restoreRevision }` 恢复为新版本。

`GET /api/comparisons/:id/sources/:documentId` 返回本行原文、解析指纹及当前主题的未归档笔记，不接受范围外文献。

`PATCH /api/comparisons/:id/cells/:documentId/:columnId` 接受部分字段：

- `revision`：当前比较表版本；冲突返回 409。
- `value`（最多 6000 字）、`status`（`unfilled` / `recorded` / `not_reported` / `not_found` / `not_applicable`）。已记录要求非空值，缺失状态的解释应写入条件字段。
- `kind`（`source` / `inference` / `user`）；已记录的原文报告或模型归纳必须有证据。模型归纳只能继承模型笔记或建议的来源。
- `conditions`、`reason`（各最多 2000 字）、`comparability`（`unchecked` / `comparable` / `conditional` / `not_comparable`）。后两种状态必须有理由。
- `source: { type: "note", noteId, revision }`：绑定当前主题、本行文献的指定笔记版本；默认填入笔记内容及其原文证据。
- `source: { type: "passages", referenceIds, documentVersion }`：选择本行当前原文，最多 12 个片段。省略 `source` 保留旧快照。
- `reviewState: "checked"`：保存后单独确认，要求引用和来源笔记仍有效。修改内容后重新待核对。

`PATCH /api/comparisons/:id/analyses/:columnId` 接受 `{ revision, value, relation, conditions, documentIds }`。`relation` 为 `agreement` / `difference` / `conflict` / `insufficient`；选择至少两行作为依据。保存行与证据快照，并在依据变化后返回 `outdated`。

`POST /api/comparisons/:id/suggestions` 接受 `{ revision, columnId }`，返回 202 及 `purpose=comparison-suggestion` 的任务。模型只接收所选文献，引用 ID 包含文献身份；逐行和综合判断分别校验引用范围。未配置模型返回 409。可通过 `/api/runs/:id` 查询和取消。

方法、研究对象、主要发现、局限及已支持别名使用中英文关键词扩展并优先读取相应章节；未命中时补充有限上下文。其他自定义维度按名称和说明作字面检索。模型输入的每篇文献附带 `retrieval: { strategy, query, partial: true }`，策略为 `expanded_keywords`、`literal_keywords`、`context_sample` 或 `no_match`。此标记说明检索方式，不保证相关性或完整覆盖。每篇文献最多 6 个原文片段、合计 6000 字符，完整输入最多 100000 字符。

`POST /api/comparisons/:id/adopt` 接受 `{ revision, runId }`，原子采用本列全部建议与综合判断。仅接受本比较表的已完成任务；范围、维度、目标内容、相关笔记或原文变化时返回 409。采用前后都保留历史，生成任务本身不修改比较表。

比较更新返回最新详情。响应中的 `matchesCurrent`、`noteChanged`、`outdated` 为服务端派生状态，不接受客户端写入。既有比较保留已移出主题的文献和出处；新任务要求所有选定文献仍与主题关联。

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
