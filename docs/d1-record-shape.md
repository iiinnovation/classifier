# D1 嵌套记录损坏隔离

本轮旧测试包已于 2026-10-27 按用户要求清理，验收证据与历史哈希保留；当前可用构建见 [清理记录](build-artifact-cleanup.md)。

日期：2026-10-26。对应 D1-04。核对数据安全验收时发现：原有校验只检查记录身份和顶层数组类型，`documents: [null]`、`evidence: [null]` 等有效 JSON 会继续进入业务代码，导致读取列表或历史时抛出类型错误。

本文保留首次嵌套类型修复及其独立构建证据。后续已根据历史生产代码补充必要字段、比较表内部定位及迁移引用检查，见[后续实施记录](d1-record-contract.md)；下列 31 项 Node／20 个打包场景和包哈希仅对应首次构建。

## 行为修复

新增 `apps/api/src/record-shape.mjs`，由 `decodeRecord` 统一调用，在 JSON／SQLite 存储返回业务记录之前验证已知容器、数组元素和业务读取使用的标量类型：

| 记录 | 新增校验范围 |
| --- | --- |
| 文献 | 章节、解析块、引用及引用文字、警告、书目信息 |
| 主题 | 文献关联数组及关联项字段 |
| 笔记 | 正文、证据及原文快照、来源对象、历史中的相同结构 |
| 比较表 | 文献 ID、维度、单元格证据及笔记来源、分析行、历史快照 |
| 成果 | 段落与引用 ID、材料快照、笔记／比较／原文材料内容、历史快照 |
| 模型任务 | 事件、文献／笔记版本、比较草稿及成果结果的已知结构 |
| 导入任务 | 事件和进度对象 |

已知字段出现错误类型或数组中混入无效项时，仍走原有可见隔离流程：原始字节留在原处并尝试生成保全副本；列表继续返回健康记录，直接读取或编辑损坏记录返回 `RECORD_CORRUPT`。启动任务恢复也先经过该校验，损坏任务不会被改写成“中断”而覆盖现场。离线资料库检查使用相同规则。

本次不增加存储版本，也不重写解析 `schemaVersion`、证据指纹或历史。缺省的旧字段、允许的空值和未知扩展字段继续保留，不用默认值补造资料。校验针对已知结构，不声称验证了全部业务语义、所有缺失必需字段或跨记录引用关系；这些限制不被隐藏为“已经完整修复”。

## 校验本身的内存边界

初版把数组元素全部放入待检查队列，在受限进程中，约 5 MiB、75 万项的合法字符串数组可使 64 MiB V8 堆耗尽。最终实现保留迭代器并逐项检查，不复制整个数组到工作队列；相同样本在 `--max-old-space-size=64` 下通过。该数字限制 V8 堆，不代表整个进程 RSS 不超过 64 MiB，也不替代完整应用资源测量。

历史快照同样使用显式工作栈遍历，避免按历史嵌套深度递归调用。原有 32 MiB 记录大小限制继续有效。

## 回归覆盖与复跑

`tests/record-shape.test.mjs` 新增 31 项：27 类损坏结构、旧字段／未知扩展／证据字节兼容、受限堆大数组，以及 JSON／SQLite 两种存储的完整 HTTP 检查。两种存储各插入 27 条损坏记录，验证五类列表、健康笔记／比较／成果、坏记录拒读拒改、原件及隔离副本字节、离线检查。

`tests/storage/record-shape.spec.mjs` 在真实包的 utility 进程加载包内生产模块，两种存储各验证 10 个代表性场景，包含重启后健康列表和已保存正文可读、损坏任务原字节不变、隔离副本和原件一致。

```sh
node --test tests/record-shape.test.mjs tests/record-integrity.test.mjs
node --test --test-concurrency=2 tests/*.test.mjs
CLASSIFIER_TEST_STORAGE=sqlite CLASSIFIER_BROWSER_CHANNEL=chrome npm run test:e2e -- --reporter=line
CLASSIFIER_PACKAGED_EXECUTABLE=/absolute/path/to/Classifier.app/Contents/MacOS/Classifier npm run test:storage -- --reporter=line
CLASSIFIER_PACKAGED_EXECUTABLE=/absolute/path/to/Classifier.app/Contents/MacOS/Classifier npm run test:desktop:shell -- --reporter=line
```

## 最终验证与产物

最终源码 **Node 331/331**、源码 fixture 的 **SQLite Chrome 完整业务 48/48**、新 Mac x64 包 **存储 16/16、桌面 18/18** 通过。存储套件包含新增 20 个嵌套损坏场景、原有 37 个磁盘故障场景及迁移／导入 SIGKILL 检查。64 个应用文件与 ASAR 内源码逐字节一致。Electron 44.7.0、包内 Node 24.21.0。

产物为 `dist/desktop-d1-record-shape-2026-10-26/Classifier-0.1.0-mac.zip`。ZIP SHA-256：`8b8b3c9f79763607eb173482a4c615b5c63629ed9eecec679df2cd2fa4639771`；ASAR SHA-256：`369704bce1219b09ee0ac5706b1ded6ed6aab061d216dd2d936324088bf11e96`。完整日志、修复前失败复现、逐场景报告、164 个源码／测试／配置文件哈希及 62 份证据哈希见 [验证记录](measurements/d1-record-shape-mac-x64-2026-10-26/validation.json)。

此预览未签名／公证，未重测完整资源或最低配置。浏览器与桌面业务使用受控模型，不是实际供应商质量验收。[回退登记](rollback-baseline.json)仍指向前轮保留的磁盘故障包，本次没有覆盖该基线；9 个 APFS 满盘场景及 6 个未来格式样本仍只对应前轮包，不沿用为新包重跑结果。D1 及后续阶段继续按 [工作清单](work-items.md)推进。
