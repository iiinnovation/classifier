# D1：数据安全基础

更新：2026-10-26。当前为 **进行中**：数据安全基础已接入；本轮按历史生产格式补上必要字段、比较表内部定位，以及迁移绕过统一解码和缺失当前文献的检查，保留历史／复制材料的独立存活语义。详情见 [必要字段与迁移说明](d1-record-contract.md)。前轮嵌套类型与大数组内存保护继续有效；37 个磁盘故障场景、9 个有界 APFS 满盘场景及 6 个未来格式恢复样本保留各自构建证据，回退基线仍固定为前轮磁盘故障包。尚不代表 D1 全部验收完成。D0 本机范围和 S0 已通过，最低系统／配置与干净机器转入 D5-05，Windows x64、Mac arm64 延期。

## 当前行为

- 服务先获取数据目录排他锁，再加载资料库或标记中断任务。专用 SQLite 连接持有 EXCLUSIVE 事务，不用 PID、文件存在或超时判断所有权；退出时等待已接纳请求和任务停止，再关闭存储并释放锁。进程被强制终止后由操作系统释放锁。
- 无版本清单且无数据库的目录继续使用旧 JSON。显式迁移完成的目录使用 SQLite；未知版本、未完成清单、数据库存在但无清单时拒绝打开。业务记录原 JSON body 保留，解析 schemaVersion、证据指纹、ID 和历史不因存储转换改变。
- SQLite 单记录更新采用事务与 generation 校验；异步业务回调期间发生的直接写入不会被旧结果覆盖。导入现将文献、最新主题关联、任务完成和导入待办 done 标记放在同一事务内，原文件先暂存同步并独占发布；中断恢复见 [原子导入说明](d1-atomic-import.md)。启动前先只读检查数据库版本与完整性，异常时停止业务写入。
- 备份要求应用停止并取得同一目录锁。SQLite 使用 VACUUM INTO 一致快照，原文件逐项校验 SHA-256；JSON 备份保留原始坏记录和临时文件供恢复调查。普通备份只包含研究记录、原文件、隔离内容和必要版本清单，不包含根目录 .env、锁库或设置凭据。
- 恢复和迁移仅发布到新的外部目录。文件全部复制、校验并同步后才将同级暂存目录改名；既有目标不覆盖。失败时来源保留、暂存内容保留，错误信息带暂存路径。
- 迁移先创建并验证 JSON 备份，再检查记录身份、基本引用与原文件哈希，导入新 SQLite 库并核对完整记录内容。损坏记录或遗留临时文件会阻止迁移，不静默忽略。
- 迁移现在每 100 条记录提交一批，批次进度与记录在同一事务中提交；文件先复制、校验并同步再发布。续跑核对原备份清单哈希、数据库身份、已提交记录和文件，不混入备份后来源目录的新修改。目录发布后仍保留 migrating 状态，最终标记持久化后应用才可打开；重复续跑不重写完成后用户的新修改。

2026-10-21 已新增桌面“资料库”菜单的检查、目录备份、恢复、切换、旧 JSON 升级和迁移进度／续跑入口。2026-10-23 继续接入 ZIP 备份、校验与新目录恢复；开发入口真实桌面三项菜单流程已通过，新 Mac x64 包及补验见 [本轮验证记录](measurements/d1-zip-mac-x64-2026-10-23/validation.json)。启动不会自动迁移。详见 [桌面维护记录](d1-desktop-maintenance.md)和 [ZIP 备份说明](d1-zip-backup.md)。所有测试使用隔离临时资料库，未操作实际用户资料。

## 显式离线工具

2026-10-21 新增 `node tools/storage-maintenance.mjs inspect /path/to/library`。检查先取得目录排他锁，直接读取记录或只读 SQLite，不打开会修改未完成任务状态的业务存储。输出 `storage`、有效记录数、已找到原文件数及结构化 `issues`（路径、代码、严重程度、处理说明）；不输出正文或凭据。命令只报告问题，不删除、隔离、修复或迁移资料。

检查覆盖基本记录身份／JSON、SQLite 完整性／版本、临时文件、缺失原文件、已有 SHA-256 不匹配、未匹配到有效记录的原文件和不安全文件类型。没有哈希的旧原文件只能检查存在性，不能据此证明内容未变化；未覆盖全部跨记录引用关系。`.DS_Store` 等非记录文件作为信息项保留。最多返回 1000 条问题，超过时 `truncated=true`；JSON 单记录超过 32 MiB 标记未验证。退出码：无错误为 0，检查发现错误或清单截断为 2，无法执行检查为 1。数据库、记录及原文件不会被改写；目录锁辅助文件仍按既有所有权机制管理。

关闭使用来源资料库的服务／桌面应用后执行。路径参数均须替换为实际选择的目录；目标父目录须存在，目标目录须尚不存在。

~~~sh
node tools/storage-maintenance.mjs backup /path/to/library /path/to/new-backup
node tools/storage-maintenance.mjs verify /path/to/new-backup
node tools/storage-maintenance.mjs restore /path/to/new-backup /path/to/new-restored-library
node tools/storage-maintenance.mjs backup-zip /path/to/library /path/to/new-backup.zip
node tools/storage-maintenance.mjs verify-zip /path/to/new-backup.zip
node tools/storage-maintenance.mjs restore-zip /path/to/new-backup.zip /path/to/new-restored-library
node tools/storage-maintenance.mjs migrate /path/to/legacy-library /path/to/new-sqlite-library /path/to/new-pre-upgrade-backup
node tools/storage-maintenance.mjs prepare-migration /path/to/legacy-library /path/to/new-sqlite-library /path/to/new-pre-upgrade-backup
node tools/storage-maintenance.mjs prepare-from-backup /path/to/new-pre-upgrade-backup /path/to/new-rebuilt-sqlite-library
node tools/storage-maintenance.mjs migration-status /path/to/new-sqlite-library.partial-MIGRATION_ID
node tools/storage-maintenance.mjs resume-migration /path/to/new-sqlite-library.partial-MIGRATION_ID
~~~

prepare-migration 只完成备份、验证和迁移批次初始化，返回实际 stage 路径；resume-migration 使用这个路径继续，migrate 将两步连续执行。进度以 JSON 写到标准错误流，最终结果写到标准输出。已经将目录发布但尚未写入完成标记时，旧 stage 路径也能定位并核对同一批次的新目录；可直接指定新目录查询／续跑。

续跑使用 snapshotCreatedAt 对应的固定备份，之后在旧资料库中的编辑不自动合并。准备阶段尚未成功返回时，来源和已发布备份仍保留；尚未建立有效进度表的暂存库不自动修复。现在可用 `prepare-from-backup` 或桌面“从升级前备份重新准备迁移”从固定备份建立新批次，保留旧暂存目录。失败文件副本和临时元数据保留在 migration-work 或原暂存目录，当前没有自动清理界面。先前没有 migration-state.json 的旧暂存目录不自动识别为可续跑批次。

当前备份同时支持目录和 ZIP 格式，均含 backup-manifest.json，沿用同一快照与校验清单。清单限制为 200,000 个文件、研究内容展开 20 GiB、清单 32 MiB；拒绝路径逃逸、符号链接、重复清单项及大小／哈希不符。ZIP 另校验 CRC、目录元数据、实际展开大小、跨平台别名和清单外条目，完整限制见 [ZIP 说明](d1-zip-backup.md)。桌面恢复到新目录后显式切换，原地恢复仍不提供。

需要回到兼容格式时，从升级前 JSON 或当前版本可读的 SQLite 备份恢复到**新目录**，保留新版目录。当前启动失败流程支持选择目录／ZIP 兼容备份，展示恢复时点，保全原件并启动新库后才切换；没有兼容备份时使用支持原库格式的版本。已经存在的早期 D0 二进制没有新版格式防护，不能让它直接打开 SQLite 目录。范围和限制见 [兼容恢复说明](d1-compatibility-recovery.md)。

## ZIP 与桌面补验（2026-10-23）

完整 Node **196/196**、Chrome 成果／恢复 **10/10**，最终 Mac x64 包桌面 **14/14**、存储 **5/5** 通过。包括新 ZIP 流程、JSON／SQLite 往返、容器边界、恢复前安全备份和失败回退；现有迁移、OCR、草稿与受控模型研究流程通过同一包复验。此前 preload 白名单断言更新为包含资料库作用域的三个字段后，最终桌面套件完整重跑通过。

产物为 `dist/desktop-d1-zip-2026-10-23/Classifier-0.1.0-mac.zip`。59 个应用文件与包内源码逐字节一致，ZIP SHA-256 为 `9fb4e26598bb4a95994cc50b6125ad5c5dcb65b55b4cb085e670deb907a02773`，ASAR SHA-256 为 `a09094522af17a8b004fc2a1ba93b8544c9531a941140a18a47ca4ac9d8e10d9`。完整记录及文稿截图见 [本轮验证](measurements/d1-zip-mac-x64-2026-10-23/validation.json)。该预览包未签名／公证，未重测完整资源门槛、真实大库或最低配置，不据此宣布 D1／D5 全部完成。

## 迁移恢复验证（2026-10-19）

2026-10-19 新增 12 项迁移恢复测试，完整 npm test 为 **98/98 通过**。新包为 dist/desktop-d1-recovery-2026-10-19/Classifier-0.1.0-mac.zip；该包 test:storage **5/5 通过**，包含生产维护流程、S0 原型及三处生产迁移 utility 进程 SIGKILL 恢复；test:desktop:shell **10/10 通过**。

- Node 真进程强制终止覆盖：开始校验后、第一批 100 条记录提交后、文件发布但进度未更新、文件进度提交后、最终目录发布前、发布后、完成标记之后；每次核对 206 条记录、历史和原文件，重复续跑不覆盖完成后的修改。
- 补测备份被修改、已提交记录／文件被修改、既有目标冲突、数据库符号链接、两次续跑并发竞争；全部拒绝不安全操作并保留内容。
- 真实 chmod 权限失败发生在原文件发布阶段，恢复写权限后续跑成功，先前部分工作保留。该测试在本机普通用户执行，不将它称为真实磁盘耗尽或硬件断电测试。
- 真实 Mac x64 包独立 utility 进程在记录批次、原文件发布和目录发布后三处 SIGKILL，恢复后 106 条记录、历史和原文件一致。测试 helper 在包外，加载包内生产迁移模块；应用入口仍无故障注入功能。
- 新迁移路径上的 Electron SQLite 完整业务回归 **38/38 通过**，覆盖主题、导入、笔记、比较、成果、草稿、冲突及导出；后端为受控源码 fixture，真实包 utility 另行验证。Chrome／JSON 本轮未重复，保留前轮证据，不将其描述为本轮重跑。

本轮恢复测试及构建证据与前轮分开归档，见 [恢复验证记录](measurements/d1-recovery-mac-x64-2026-10-19/validation.json)。仍未覆盖初始化前每个写入边界、真实断电、完整磁盘耗尽或其他平台；未据此宣称 D1 全部完成。

新 ZIP SHA-256：c77ef1f38823613cfa968aa68ac34bdea868ceee61ee6136f8386186f56a07ef；ASAR SHA-256：26126d79fca2ac05a5703dc27b2faf1de14cc2fda2de87dce9ebc52a06ae6ff0。49 个包内应用源码与工作区逐字节一致；未签名／公证，未重测完整资源门槛。

## 前轮存储接入基线

前轮 Mac x64 测试包：dist/desktop-d1-storage-2026-10-19/Classifier-0.1.0-mac.zip。未签名、未公证。以下数量和哈希只对应该包及当时源码，作为历史保留。

- npm test：86 项通过，包含目录锁、异常退出、SQLite 迁移后完整 HTTP 研究流程、冲突、证据身份、备份篡改、损坏和路径边界。
- 最终包 test:desktop:shell：10 项通过，含启动失败后重试、导航／权限拦截及同目录竞争／强制退出恢复。
- 最终包 test:storage：2 项通过，分别是 S0 的 8 类独立故障场景，以及生产迁移 → SQLite 备份 → 新目录恢复 → utility 后端读取 → 活动资料库拒绝离线备份。
- JSON 模式 Chrome 38 项／Electron 38 项通过；新增显式迁移 SQLite 模式后，同一组 Chrome 38 项／Electron 38 项也全部通过。引用版本变更的测试改走持锁存储接口，改动后的 JSON 4 项相关场景另行复核通过。包括主题、导入、笔记、比较、成果、历史、草稿、冲突和 Markdown 导出。
- 回归 fixture 与配置改动后 npm test 再次 86 项通过；最终 ASAR 内按实际构建规则纳入的 49 个应用源码文件与工作区逐字节一致。业务测试的受控源码后端与真实包 utility 测试分别记录，不混为同一种验收。
- 证据、源码哈希及实际运行时见 [validation.json](measurements/d1-mac-x64-2026-10-19/validation.json)。S0 原型结果不替代生产文件操作恢复验收。

ZIP SHA-256：d09dd9b943ee286dc86b1fa5d6ef878fcc405b26ad0b34dac29f154ca12c448c；ASAR SHA-256：54a0f5c59903593609996346a663c5b06b65cff92e4e82001d0a6db63ec522ad。最终包下载 163,771,083 字节、安装目录 395,068,389 字节。

D0 完整资源报告只对应其原 ASAR，本 D1 包尚未重测完整资源门槛。业务自动化使用受控模型；不代表真实供应商或跨学科研究质量验收。当前 Mac x64 运行结果不代表最低配置、Windows 或 Mac ARM 通过。

新增完整 SQLite 业务回归可复现为：

~~~sh
CLASSIFIER_TEST_STORAGE=sqlite CLASSIFIER_BROWSER_CHANNEL=chrome npm run test:e2e
CLASSIFIER_TEST_STORAGE=sqlite npm run test:desktop:business
~~~

每项测试使用独立临时库，先从 JSON 经生产迁移工具生成 SQLite；输出在 test-results/browser-sqlite 和 test-results/electron-business-sqlite，不覆盖旧格式报告。

## 损坏隔离与选择性恢复补验（2026-10-25）

单条坏 JSON 或 SQLite 业务记录现在保留原字节并生成隔离副本，健康记录与已有证据快照继续可读。页面异常提示和桌面原件保全、逐项版本预览、目录／ZIP 选择性恢复已接入。执行前核对预览哈希，恢复在新目录进行，保留其他资料的较新修改；冲突原文件待办仅在恢复副本中替代，原日志保留于原库和保全副本。

本轮完整 Node **226/226**、Chrome 完整业务 **48/48**，最终 Mac x64 包桌面 **16/16**、存储 **5/5** 通过。预览包仍位于 `dist/desktop-d1-selective-recovery-2026-10-23/`（构建目录沿用实施日期）；ZIP SHA-256 为 `6a6b5b7fe063780871a001b5d91e7b28a945e92ab44ecbfb2f621e3f7b3d996c`，ASAR SHA-256 为 `ef001701360f5e01bb2912c921cbc7fa6c375d1514dd7627e1692329cf08459e`。详情见 [损坏资料说明](d1-record-recovery.md)及 [本轮验证记录](measurements/d1-selective-recovery-mac-x64-2026-10-25/validation.json)。未签名／公证，未重测完整资源门槛。

## 兼容恢复与迁移准备重建补验（2026-10-25）

启动失败入口现可核验目录／ZIP 兼容备份，展示备份时点，确认后保全当前原件并恢复新目录；新库启动和位置写入完成后才切换。迁移准备在备份完成、布局发布、批次身份发布、数据库建表、准备完成五处遭 SIGKILL 后，可从固定备份重建新批次，保留旧暂存字节和原库新修改。

完整 Node **246/246**、最终 Mac x64 包桌面 **18/18**、存储 **5/5** 通过。新包 `dist/desktop-d1-compatibility-2026-10-25/Classifier-0.1.0-mac.zip` 的 ZIP SHA-256 为 `357a451c130acd8477dac8b932f007e1873e4bb635a00b7e9c3d467fe4bbe35a`，ASAR SHA-256 为 `9a081d190fb5cb537c30869900eea9262a70c8ac66c992faf4e47a4a887a5851`。62 个应用文件与包内源码一致。证据及限制见 [本轮验证](measurements/d1-compatibility-mac-x64-2026-10-25/validation.json)和 [兼容恢复说明](d1-compatibility-recovery.md)。前轮 Chrome 48/48 保留，不声明本轮重复执行；新包未签名／公证，未重测完整资源门槛。

## 磁盘故障补验（2026-10-26）

[磁盘错误专项](d1-disk-failures.md)新增 37 个生产路径场景，覆盖真实 SQLite FULL、文件短写、同步／发布失败、迁移续跑和隔离恢复。修复自动回滚掩盖原始错误、发布后报错指向旧暂存路径、ready 标记同步失败后续跑漏同步三类问题；ZIP 测试同时覆盖普通及批量写入，防止调度差异绕过故障注入。

最终源码 Node **300/300**、新 Mac x64 包桌面 **18/18**、存储 **15/15** 通过。存储套件含 7 组共 37 个故障场景，以及原有迁移／导入 SIGKILL 和整库恢复。63 个应用文件与包内源码逐字节一致；包为 `dist/desktop-d1-disk-failures-2026-10-26/Classifier-0.1.0-mac.zip`。源码／ASAR／ZIP 哈希、原始日志、运行时和逐场景结果见 [验证记录](measurements/d1-disk-failures-mac-x64-2026-10-26/validation.json)。本轮未重跑浏览器完整业务和资源门槛；未签名／公证。文件系统错误注入不等于物理磁盘占满或硬件断电实测。

## 真实满盘与回退基线补验（2026-10-26）

同一 Mac x64 包在有界 128 MiB APFS 镜像中通过 **9/9 个真实空间耗尽场景**，覆盖 JSON／SQLite 编辑、SQLite 导入、目录／ZIP 备份恢复、迁移续跑及隔离重试。测试无 I/O 注入、无 SQLite 页数限制，未占满宿主卷，镜像已卸载并清理。迁移进度在满盘时可能报 SQLite I/O 错误；释放空间后已核对 3 条记录／0 个文件的持久进度并连续续跑通过。

另通过 **6/6 个未来格式恢复样本**，覆盖拒写早于任务更新、后续修改与未知目录保留、兼容快照恢复和重启可编辑。当前保留包登记为预览恢复基线，使用 `node tools/verify-rollback-baseline.mjs` 核对产物及报告。样本不是实际发行版本对，不宣称真实跨版本回退已经完成。详情见 [满盘与回退说明](d1-full-volume.md)，证据见 [补充验证](measurements/d1-full-volume-mac-x64-2026-10-26/validation.json)。本轮只新增测试、工具及文档，没有应用改动或重新打包；前轮 300/15/18 不计为再次执行。

## 嵌套记录结构补验（2026-10-26）

核对 D1-04 时复现已知嵌套字段类型损坏绕过顶层校验的问题，现将字段结构校验接到统一记录解码，坏记录在进入业务列表／历史／任务恢复前独立隔离。大数组校验由一次性排队改为迭代器逐项检查，同一 75 万项样本在 64 MiB V8 堆限制下通过；旧字段和未知扩展不自动重写。范围与限制见 [记录结构说明](d1-record-shape.md)。

最终源码 Node **331/331**、SQLite Chrome 完整业务 **48/48**、新 Mac x64 包存储 **16/16**及桌面 **18/18**通过；包含 20 个打包嵌套损坏场景和 37 个既有磁盘故障场景。64 个应用文件与包内源码一致。产物 `dist/desktop-d1-record-shape-2026-10-26/Classifier-0.1.0-mac.zip`；哈希、日志和运行时见 [本轮验证](measurements/d1-record-shape-mac-x64-2026-10-26/validation.json)。前轮满盘／未来格式证据与回退基线继续绑定旧包，本轮没有重新执行这两套专项。

## 必要字段与迁移引用补验（2026-10-26）

核对 M1–M4 首次生产代码后，必需的文献／证据／历史数组不再作为可选旧字段。统一解码还检查 UUID 和比较表当前／历史版本内部的单元格及分析定位；分析保存的旧行输入不强制属于当前范围。迁移改用统一解码，并检查当前比较文献存在性，按既有 UUID 大小写规则匹配；源记录、历史、复制材料和证据版本不被自动重写。正常 API 创建的成果在测试中失去原文／笔记后，仍能迁移、读取和导出，见 [实施边界](d1-record-contract.md)。

最终源码 Node **363/363**、SQLite Chrome 完整业务 **48/48**，新 Mac x64 包存储 **17/17**、桌面 **18/18**通过。包内覆盖 40 个记录损坏、4 个迁移边界及 37 个既有磁盘故障场景；64 个应用文件与包内一致。产物 `dist/desktop-d1-record-contract-2026-10-26/Classifier-0.1.0-mac.zip`；修复前复现、历史代码依据、源码／产物哈希及逐场景报告见 [本轮验证](measurements/d1-record-contract-mac-x64-2026-10-26/validation.json)。回退登记仍指向前轮磁盘故障包，满盘／未来格式证据未在本包重跑。

## 后续完成条件

1. **D1-02／04：可见损坏处理。** 迁移批次／进度、中断续跑、可见隔离、选择性恢复及固定备份重建已实现；已知嵌套类型、历史生产格式的必要字段和当前比较引用检查已完成本轮补验。下一步逐项对照 D1 退出条件，区分开发保障与 D5 发行验收；当前校验不等于完整业务模式或所有关系证明。生产 I/O 错误、SQLite FULL 和有界 APFS 真实分配失败保留专项证据；硬件断电不声明已测。
2. **D1-03／05：备份恢复与兼容版本。** 目录／ZIP 校验、桌面选择／切换、启动失败的兼容恢复和原件保全已实现；预览恢复基线及 6 个格式样本已固定。历史早期 D0 二进制不具备新格式拒写防护，真实发行版本对仍须在对应构建存在后按 D5-01 验收，不以格式样本替代。
3. **D1-06：生产文件操作日志。** JSON 与 SQLite 已有原文件日志；SQLite 导入另通过持久待办和单事务协调文献、主题关联及任务结果，并验证提交前后 SIGKILL。删除链路的跨记录协调及其故障边界归 D2，先确认产品语义；导入通过不等于用户删除已实现。
4. 完成上述基础后进入 D2 删除预览、活动任务协调和全链路来源缺失显示；之后推进 D3 设置／凭据／草稿恢复、D4 成果交付、D5 发布验收。
