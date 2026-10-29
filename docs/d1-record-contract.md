# D1 必要字段与迁移引用校验

本轮旧测试包已于 2026-10-27 按用户要求清理，验收证据与历史哈希保留；当前可用构建见 [清理记录](build-artifact-cleanup.md)。

日期：2026-10-26。对应 D1-02／04，接续[嵌套结构校验](d1-record-shape.md)。本轮处理“字段缺失仍当作旧记录”和“迁移绕过正常读取校验”两个具体缺口，并补比较表内部定位检查。

## 兼容边界的依据

无版本 JSON 不能仅凭字段缺失就认定为兼容旧格式。核对仓库中首次生产实现：

| 首次实现 | 已输出的结构 |
| --- | --- |
| M1 `73237b9`，`topics.mjs` | 主题 `documents: []` |
| M2 `e7454ed`，`notes.mjs` | 笔记 `documentId`、`content`、`evidence`、`history`；历史快照去掉自己的 `history`／`requestHash`，保留证据 |
| M3 `e468992`，`comparisons.mjs` | 当前文献、维度、单元格、分析及历史数组 |
| M4 `af99a59`，`reports.mjs` | 材料、证据、段落及历史数组；材料中的文献为摘要快照 |

缺少这些结构时报告 `RECORD_CORRUPT` 并保留原字节，不以空数组或默认正文补写。旧测试中只为隔离锁、文件日志或 ZIP 行为而写的极简记录，补全为与真实生产格式一致的样本；没有放宽生产校验来保留这些不真实的样本。

## 统一读取校验

`record-shape.mjs` 的必要字段表集中声明以下边界，JSON／SQLite 读取、离线检查和迁移共用：

- 文献必须有章节和引用；主题必须有文献关联数组。
- 笔记必须有文献 ID、正文、证据和历史；比较表必须有主题 ID、当前文献、维度、单元格、分析和历史；成果必须有主题 ID、材料、证据、段落和历史。
- 已知嵌套项必须保留其消费者需要的定位、文字、证据或内容字段。文献、主题、维度及相关版本项的 UUID 按现有身份规则检查。
- 历史快照使用独立规则，不要求嵌套 `history`；成果的文献摘要也不要求完整文献的章节／引用数组。复制的比较材料使用 `citationIds`，不要求原表的单元格 `evidence`／`noteSources`。
- 比较草稿任务必须有文献版本；已完成的已知建议任务必须有对应结果字段。损坏的在途任务不会先被启动恢复改写。
- 比较表单元格必须属于该版本的文献及维度，分析必须属于该版本的维度。分析的 `rows` 是保存的输入，改变当前文献范围后可保留旧行，并由业务展示标为过期。

可选旧元数据、允许的空值和未知扩展仍原样保留，不增加存储版本、不改写解析版本或证据指纹。本轮没有把全部业务创建规则套到历史快照上；也不宣称已经验证所有枚举、数值、重复标识或全部关系语义。

## 迁移边界

迁移先完成并核验升级前备份，再通过 `decodeRecord` 读取记录；不再直接 `JSON.parse` 后只检查身份。结构损坏或当前比较文献缺失时，在创建／发布目标资料库前拒绝，错误说明保留的备份位置。

既有根级文献／主题、主题关联和原文件哈希检查继续执行。新增当前比较范围的文献存在性检查，不要求文献仍关联同一主题，也不把以下内容当成必须存在的当前外键：

- 已保存成果的材料、引文和文献摘要。
- 笔记／比较／成果历史中的来源。
- 比较单元格复制的笔记来源及分析的历史输入。

这些副本可以比当前源记录存活更久。测试通过正常 API 创建成果和比较，更换比较范围、移出主题，再移除测试库中的旧文献和笔记，验证迁移后的当前表、历史、成果正文和 Markdown 导出仍可用；源文件与备份字节不变。不要求保存的证据版本等于当前文献版本，也不借迁移重写旧研究。

当前文献引用按既有 UUID 身份规则忽略大小写匹配，迁移后仍保留原字段大小写；此兼容边界有独立失败复现及回归。

这不是 D2 删除语义实现，未对用户资料执行迁移、修复或删除。

## 验证入口

```sh
node --test --test-concurrency=2 tests/record-shape.test.mjs tests/migration-validation.test.mjs tests/comparisons.test.mjs tests/reports.test.mjs
node --test --test-concurrency=2 tests/*.test.mjs
node --max-old-space-size=64 tests/helpers/record-shape-memory.mjs
CLASSIFIER_TEST_STORAGE=sqlite CLASSIFIER_BROWSER_CHANNEL=chrome npm run test:e2e -- --reporter=line
CLASSIFIER_PACKAGED_EXECUTABLE=/absolute/path/to/Classifier.app/Contents/MacOS/Classifier npm run test:storage -- --reporter=line
CLASSIFIER_PACKAGED_EXECUTABLE=/absolute/path/to/Classifier.app/Contents/MacOS/Classifier npm run test:desktop:shell -- --reporter=line
```

## 最终验证与产物

最终源码 **Node 363/363**、**SQLite Chrome 完整业务 48/48**，新 Mac x64 包 **存储 17/17、桌面 18/18** 通过。记录专项共 59 项，包含 55 类损坏及两种存储的 HTTP 隔离检查；迁移专项 4 项验证结构拒绝、当前文献缺失、UUID 大小写和历史／材料保留。

包内生产模块验证包含 **40 个记录损坏场景、4 个迁移边界场景、37 个既有磁盘故障场景**，以及迁移／导入 SIGKILL 恢复。75 万项字符串数组、5,250,127 字节记录在 64 MiB V8 堆下通过；不把堆限制当作整个进程 RSS 或应用资源门槛。

64 个应用文件与 ASAR 内源码逐字节一致。Electron 44.7.0、包内 Node 24.21.0。产物为 `dist/desktop-d1-record-contract-2026-10-26/Classifier-0.1.0-mac.zip`：

- ZIP SHA-256：`271d2841e9f3b9a0df5dde47918592dc71a89893192535219cb3ee7221e629aa`
- ASAR SHA-256：`29c0c859ce36033bf18070e6612b7cfbc7226ebcf0a8e80e17321a5d9c033143`

修复前失败、完整回归日志、历史生产代码依据、逐场景结果、165 个源码／测试／配置哈希及 69 份证据哈希见 [验证记录](measurements/d1-record-contract-mac-x64-2026-10-26/validation.json)。归档也保留首次完整回归中三个不完整测试样本的失败日志，最终结果来自补全样本及最后 UUID 修复后的重新执行。

本包未签名／公证，未重测完整资源门槛或最低配置。浏览器及桌面业务使用受控模型响应，不等于真实供应商验收。[回退登记](rollback-baseline.json)、9 个 APFS 满盘场景及 6 个未来格式样本继续绑定旧包，不沿用为本包验证结果；实际发行版本对仍按 D5-01 验收。D1 整体状态继续以[工作清单](work-items.md)为准。
