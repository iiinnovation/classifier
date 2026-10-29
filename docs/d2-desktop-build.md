# D2 Mac x64 打包验收

本文为只读预览包的历史验收。后续实际删除另有独立 [D2 删除执行包](d2-deletion-execution.md)，不能把本文的源码／ASAR／资源结果沿用为新包结果。

后续本地构建清理保留本 D2 包和已登记的 D1 回退基线，旧 D1 记录校验包已移除；见 [清理记录](build-artifact-cleanup.md)。

日期：2026-10-27。本轮将删除影响预览、存储用量与异常来源状态纳入独立 Mac x64 预览包，保留原 D1 包和已登记的回退基线。D1／D2 整体仍在进行，实际删除与“已删除”状态未开放。

## 构建范围

- ZIP：`dist/desktop-d2-2026-10-27/Classifier-0.1.0-mac.zip`。
- 程序：`dist/desktop-d2-2026-10-27/mac/Classifier.app/Contents/MacOS/Classifier`。
- Electron 44.7.0，版本号仍为 0.1.0；本轮不改存储格式，不自动迁移用户资料。
- 构建使用已有本机 x64 原生依赖和经过打包校验的 OCR 资源，未签名、未公证。

包内 68 个应用文件与 [来源状态源码归档](measurements/d2-source-states-mac-x64-2026-10-27/validation.json)一致。该归档的 176 个源码／测试／配置哈希逐项核对一致；本轮只新增真实桌面数据生命周期测试，不修改应用源码。

因此继续引用上一轮 Node 386/386 与 SQLite Chrome 54/54 的源码结果，明确它们不是本轮重新执行的测试。以下桌面及存储验证直接启动本轮打包可执行文件，运行其 ASAR 中的主进程、协议桥、utility 后端和页面。

## 新增打包场景

`tests/desktop/data-lifecycle.spec.mjs` 对 JSON／SQLite 与缺失／损坏状态的四种组合进行验证。资料通过真实应用 API 创建；SQLite 用例通过应用“资料库”菜单迁移临时 JSON 库，随后从实际选择的 SQLite 库读取。

- 五类删除预览与移出主题预览返回只读结果，页面展示保留共享原件；删除执行路由仍不存在，预览前后研究版本与主题关联不变。
- 从本地受控模型生成成果建议后，再破坏临时库中的原文记录；不改变笔记或成果版本，验证继续生成及采用已完成建议均被拒绝，模型请求数不增加。
- 原文记录不可用时，成果正文、历史和 Markdown 导出仍保留；出处显示缺失或损坏，原文跳转及生成入口禁用。
- 笔记历史仍可恢复为新版本，主题列表立即更新。原始附件字节保留，成果版本不因来源状态展示而增加。
- 每个场景记录 `app.isPackaged`、ASAR 路径、运行时版本、实际存储类型及断言结果，并保存预览与异常出处截图。

既有完整桌面回归还覆盖两种存储的用量统计、自动备份目录、原生维护菜单、启动／退出、协议隔离与研究流程。存储回归覆盖迁移、备份恢复、记录结构隔离、原子导入中断和磁盘故障注入。

## 打包验证结果

| 验证 | 结果 | 范围 |
| --- | --- | --- |
| 真实打包桌面完整回归 | 24/24 通过 | 包含本轮新增的四种数据生命周期组合及 JSON／SQLite 用量统计 |
| 真实打包存储完整回归 | 17/17 通过 | 包含 37 个磁盘故障、40 个记录结构及 4 个迁移校验场景 |
| ZIP 完整性 | 通过 | `unzip -t` 未发现错误 |
| 保留回退基线 | 核验通过 | ASAR／ZIP 与登记一致；6 个未来格式样本仍为前轮证据，不代表实际版本配对 |

桌面与存储的 `.last-run.json` 均为 `passed`，没有失败测试；四个数据生命周期记录均确认 `app.isPackaged: true` 和本轮 ASAR 路径。已核对 SQLite 缺失、JSON 损坏、主题预览及 SQLite 用量截图，提示、保留内容和禁用入口可见。

- ZIP SHA-256：`acec8d5794e13bf2b0a31c8387afba71d623aa32a61f418d2f69a61b204cf717`。
- ASAR SHA-256：`9265e72c7133dc1529ea3d89105b915456416bf125e81e9e3fd575c4967fc2d4`。
- 日志、截图、运行时记录及独立源码／产物哈希见 [本轮打包归档](measurements/d2-desktop-build-mac-x64-2026-10-27/validation.json)。旧轮次归档保持原有哈希和验证范围。

## 本轮资源测量

使用既有测量器和独立临时工作目录，直接启动同一打包程序；测量期间没有并行运行其他应用测试。应用只使用系统命令 PATH，20 次启动分别使用空临时资料库。内存沿用整个应用进程树 RSS 口径，共享页可能重复计数。

| 指标 | 本轮结果 | 门槛／结论 |
| --- | --- | --- |
| 下载／安装体积 | 156.27／377.09 MiB | ≤ 350／800 MiB，通过 |
| 20 次启动 P95 | 2025.62 ms | ≤ 8000 ms，通过 |
| 空闲 P95 RSS | 390.16 MiB | ≤ 450 MiB，通过 |
| 50 页文字 PDF 峰值 RSS | 首测 1240.37 MiB；复测 1222.60 MiB | ≤ 1228.8 MiB；首测超限，复测通过，余量仍待收口 |
| 10 页 OCR／中英文 OCR 峰值 RSS | 936.38／947.61 MiB | ≤ 1536 MiB，通过；10 页中英文内容检查通过 |
| 10 次取消后 RSS 增长 | 45.42 MiB | ≤ 100 MiB，通过；无 OCR 进程残留 |

完整测量的 `completed: true` 表示执行结束；其中 PDF 门槛为 `false`，进程退出码 **1**。随后对同一 ASAR／ZIP 和相同 SHA-256 的 PDF 样本单独复测，退出码 **0**，仅约 6.20 MiB 余量。原始 [完整报告](measurements/d2-desktop-build-mac-x64-2026-10-27/resources-all.json)和 [PDF 复测报告](measurements/d2-desktop-build-mac-x64-2026-10-27/resources-pdf.json)均保留，当前不宣布资源门槛已稳定通过；后续按 D5-06 分析 PDF 峰值并收口。

本轮归档包含 **177 个源码／测试／配置哈希与 91 份证据哈希**。资源报告、四种打包生命周期记录和 ZIP 内 ASAR 均已绑定本轮产物，不沿用旧包资源结论。

## 复跑命令

```sh
npm run desktop:dist -- --mac zip --x64 --config.directories.output=dist/desktop-d2-2026-10-27
CLASSIFIER_PACKAGED_EXECUTABLE=/absolute/path/to/Classifier.app/Contents/MacOS/Classifier npm run test:desktop:shell -- --reporter=line
CLASSIFIER_PACKAGED_EXECUTABLE=/absolute/path/to/Classifier.app/Contents/MacOS/Classifier npm run test:storage -- --reporter=line
node tools/verify-rollback-baseline.mjs
```

资源复测应在独立临时工作目录执行以下命令，测量器会将报告写入该目录的 `dist/desktop/measurements`；把 `all` 换成 `pdf` 可单独复测 PDF：

```sh
node /absolute/path/to/classifier/tools/measure-desktop.mjs /absolute/path/to/Classifier.app/Contents/MacOS/Classifier all /absolute/path/to/Classifier-0.1.0-mac.zip
```

测试均使用隔离的临时资料库，模型使用本地受控回复；未读取、迁移或删除真实用户资料。实际发行版本配对、最低／干净机器、签名公证和真实供应商质量仍按 [统一工作清单](work-items.md)推进。
