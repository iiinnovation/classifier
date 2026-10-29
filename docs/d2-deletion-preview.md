# D2 删除影响预览

本文保留早期只读预览轮次的范围和证据。后续用户已同意首版语义，SQLite 实际执行与“已删除”状态已实现，JSON 保持预览；当前行为见 [普通删除实施记录](d2-deletion-execution.md)。

日期：2026-10-27。对应 D2-01。接续 [D1 退出条件核对](d1-exit-audit.md)，当前仅实现可审查的只读预览，不据此宣布 D1 全部完成或 D2 删除已可用。

## 当前产品范围

文献卡片、主题、笔记、比较表、成果增加“删除影响”，主题内文献另有“移出影响”。弹窗显示：

- 目标记录、其自身历史和需要解除的主题关联。
- 会保留的共享文献、研究记录、复制内容及历史版本。
- 相关活动任务与已结束任务；活动任务不在预览时被停止。
- 损坏记录、预览中资料变化、尚未提交的同步导入造成的范围不完整。
- 普通删除不清除备份、隔离副本或已导出的文件。

弹窗只有刷新与关闭，没有删除确认按钮或执行接口。现有“移出主题”操作保持原有行为；“移出影响”只展示范围，不调用该操作。

首版删除语义已向用户询问，尚未收到确认。只读预览暂按交付方案已有默认规则展示：删除原文及解析全文、保留引用摘录；删除主题时移除所属研究记录、保留共享文献；删除笔记／比较／成果时移除目标及自身历史、保留其他记录中的复制材料。彻底清除是否纳入首版尚未决定，不能把预览中的默认方案当作已经批准的永久删除实现。

## 引用与任务边界

生产模块 `apps/api/src/deletion-preview.mjs` 共用 JSON／SQLite 存储读取接口。明确读取保存的身份字段、证据、材料、文献／笔记版本、比较行，以及成果段落的 `origin.sourceKey`；不把正文中的 UUID 文字或未知扩展当作引用。

引用沿文献→笔记→比较→成果传播，覆盖“移除已选材料后，正文仍保留材料来源标记”的情况。当前内容和历史分别标注。活动任务使用当前引用链及保存的任务输入识别：一个成果只有历史版本关联目标时，不把该成果的新生成任务误算为当前依赖；删除复制成果也不会把其保留源材料的生成误算为受影响任务。

预览前后各读取一次资料库快照；内容变化或健康检查发现问题时明确报告范围不完整，不静默跳过异常后声称完整。同步导入尚未提交关联时也标为不完整。健康检查仍可能按既有 D1 规则保全新发现的坏字节，预览不会改写研究记录或损坏原件。

这是读取时点的说明，不是事务性删除许可。返回的 `revision` 只表示已读取数据，未来执行必须在事务／所有权边界内重新验证范围、任务及用户确认，不能凭旧预览直接删除。

## API

```text
GET /api/deletion-preview/documents/:id
GET /api/deletion-preview/topics/:id
GET /api/deletion-preview/notes/:id
GET /api/deletion-preview/comparisons/:id
GET /api/deletion-preview/reports/:id
GET /api/deletion-preview/documents/:id?action=detach&topicId=:topicId
```

响应含 `readOnly: true`、`executionAvailable: false`、`complete`、`removes`、`links`、`preserves`、`tasks`、`blockers` 和汇总数量。只返回名称、身份及关系，不返回正文／原文件内容。目标损坏仍返回 `RECORD_CORRUPT`，目标不存在为 404，非法范围为 400。向预览 URL 发 POST／DELETE 不会产生写入。

## 验证

```sh
node --test tests/deletion-preview.test.mjs
node --test --test-concurrency=2 tests/*.test.mjs
CLASSIFIER_TEST_STORAGE=sqlite CLASSIFIER_BROWSER_CHANNEL=chrome npm run test:e2e -- --reporter=line
CLASSIFIER_TEST_STORAGE=sqlite npm run test:desktop:business -- tests/e2e/deletion-preview.spec.mjs --reporter=line
```

专项覆盖两种存储及六类范围、共享资料／历史保留、间接复制和段落来源、活动任务、损坏字节、快照变化、非法范围与无写入。浏览器／Electron 覆盖全部入口、刷新、关闭后的迟到响应及禁止执行，截图用于核对显示。

2026-10-27 最终源码验证：**Node 370/370**、**SQLite Chrome 完整业务 50/50**、**SQLite Electron 预览专项 2/2**通过；删除预览的 JSON／SQLite 专项 **7/7**，已包含在 Node 总数中。所有执行均以退出码 0 结束，Node 无失败、取消或跳过。日志、两端截图、169 个源码／测试／配置文件及 8 份证据的 SHA-256 见 [本轮验证归档](measurements/d2-deletion-preview-mac-x64-2026-10-27/validation.json)。

本轮为源码及 Electron 开发桥接验证，未重建分发包；上一轮 D1 包及其测试仍绑定原 ASAR，不能代表这些新增代码已在分发包验收。测试使用隔离资料和受控模型响应，不涉及实际用户资料的删除。

以上证据绑定删除预览轮次源码。随后增加的存储用量入口及综合回归另见 [用量记录](d2-storage-usage.md)；旧清单不改写为后续源码的哈希。

2026-10-27 后续已纳入独立 [D2 Mac x64 预览包](d2-desktop-build.md)：真实打包桌面 24/24、存储 17/17 通过，新增 JSON／SQLite 与缺失／损坏的四种数据生命周期组合。本段是后续打包补验，不改变上述源码轮次归档。

## 后续必需工作

1. 确认 D2 首版删除语义，并为实际操作提供具体影响范围确认。
2. 在 SQLite 事务中协调删除标记、关联、任务和原文件待办；处理幂等重试、进程中断、磁盘错误及任务完成竞争。JSON 旧库的可用操作边界需明确，不能直接复用单记录删除冒充跨记录事务。
3. 区分来源缺失、损坏、已删除，覆盖列表／详情／历史／导出／来源选择／生成与采用／跳转，继续保留可读副本。
4. 实现存储用量入口，明确记录、历史、原件、备份、隔离及诊断的口径与释放空间边界。

当前预览不是这四项工作的替代完成条件。
