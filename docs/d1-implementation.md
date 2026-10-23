# D1：数据安全基础

更新：2026-10-19。当前为 **进行中**：已实现跨进程目录锁、显式 SQLite 适配及离线目录备份／恢复／迁移；尚不代表 D1 全部验收完成。D0 本机范围和 S0 已通过，最低系统／配置与干净机器转入 D5-05，Windows x64、Mac arm64 延期。

## 当前行为

- 服务先获取数据目录排他锁，再加载资料库或标记中断任务。专用 SQLite 连接持有 EXCLUSIVE 事务，不用 PID、文件存在或超时判断所有权；退出时等待已接纳请求和任务停止，再关闭存储并释放锁。进程被强制终止后由操作系统释放锁。
- 无版本清单且无数据库的目录继续使用旧 JSON。显式迁移完成的目录使用 SQLite；未知版本、未完成清单、数据库存在但无清单时拒绝打开。业务记录原 JSON body 保留，解析 schemaVersion、证据指纹、ID 和历史不因存储转换改变。
- SQLite 单记录更新采用事务与 generation 校验；异步业务回调期间发生的直接写入不会被旧结果覆盖。启动前先只读检查数据库版本与完整性，异常时停止业务写入。
- 备份要求应用停止并取得同一目录锁。SQLite 使用 VACUUM INTO 一致快照，原文件逐项校验 SHA-256；JSON 备份保留原始坏记录和临时文件供恢复调查。普通备份只包含研究记录、原文件、隔离内容和必要版本清单，不包含根目录 .env、锁库或设置凭据。
- 恢复和迁移仅发布到新的外部目录。文件全部复制、校验并同步后才将同级暂存目录改名；既有目标不覆盖。失败时来源保留、暂存内容保留，错误信息带暂存路径。
- 迁移先创建并验证 JSON 备份，再检查记录身份、基本引用与原文件哈希，导入新 SQLite 库并核对完整记录内容。损坏记录或遗留临时文件会阻止迁移，不静默忽略。
- 迁移现在每 100 条记录提交一批，批次进度与记录在同一事务中提交；文件先复制、校验并同步再发布。续跑核对原备份清单哈希、数据库身份、已提交记录和文件，不混入备份后来源目录的新修改。目录发布后仍保留 migrating 状态，最终标记持久化后应用才可打开；重复续跑不重写完成后用户的新修改。

2026-10-21 已新增桌面“资料库”菜单的检查、目录备份、恢复、切换、旧 JSON 升级和迁移进度／续跑入口。Node 测试验证迁移准备、固定备份续跑、100 条记录批次中断、保全中断后的旧库修改、目标启动／切换失败以及重试；实际 Electron 启动受环境阻止，尚未验收。启动不会自动迁移。详见 [桌面维护记录](d1-desktop-maintenance.md)。所有测试使用隔离临时资料库，未操作实际用户资料。

## 显式离线工具

2026-10-21 新增 `node tools/storage-maintenance.mjs inspect /path/to/library`。检查先取得目录排他锁，直接读取记录或只读 SQLite，不打开会修改未完成任务状态的业务存储。输出 `storage`、有效记录数、已找到原文件数及结构化 `issues`（路径、代码、严重程度、处理说明）；不输出正文或凭据。命令只报告问题，不删除、隔离、修复或迁移资料。

检查覆盖基本记录身份／JSON、SQLite 完整性／版本、临时文件、缺失原文件、已有 SHA-256 不匹配、未匹配到有效记录的原文件和不安全文件类型。没有哈希的旧原文件只能检查存在性，不能据此证明内容未变化；未覆盖全部跨记录引用关系。`.DS_Store` 等非记录文件作为信息项保留。最多返回 1000 条问题，超过时 `truncated=true`；JSON 单记录超过 32 MiB 标记未验证。退出码：无错误为 0，检查发现错误或清单截断为 2，无法执行检查为 1。数据库、记录及原文件不会被改写；目录锁辅助文件仍按既有所有权机制管理。

关闭使用来源资料库的服务／桌面应用后执行。路径参数均须替换为实际选择的目录；目标父目录须存在，目标目录须尚不存在。

~~~sh
node tools/storage-maintenance.mjs backup /path/to/library /path/to/new-backup
node tools/storage-maintenance.mjs verify /path/to/new-backup
node tools/storage-maintenance.mjs restore /path/to/new-backup /path/to/new-restored-library
node tools/storage-maintenance.mjs migrate /path/to/legacy-library /path/to/new-sqlite-library /path/to/new-pre-upgrade-backup
node tools/storage-maintenance.mjs prepare-migration /path/to/legacy-library /path/to/new-sqlite-library /path/to/new-pre-upgrade-backup
node tools/storage-maintenance.mjs migration-status /path/to/new-sqlite-library.partial-MIGRATION_ID
node tools/storage-maintenance.mjs resume-migration /path/to/new-sqlite-library.partial-MIGRATION_ID
~~~

prepare-migration 只完成备份、验证和迁移批次初始化，返回实际 stage 路径；resume-migration 使用这个路径继续，migrate 将两步连续执行。进度以 JSON 写到标准错误流，最终结果写到标准输出。已经将目录发布但尚未写入完成标记时，旧 stage 路径也能定位并核对同一批次的新目录；可直接指定新目录查询／续跑。

续跑使用 snapshotCreatedAt 对应的固定备份，之后在旧资料库中的编辑不自动合并。准备阶段尚未成功返回时，来源和已发布备份仍保留，但尚未建立有效进度表的暂存库不自动修复，需要排查后从新目标重新准备。失败文件副本和临时元数据保留在 migration-work 或原暂存目录，当前没有自动清理界面。先前没有 migration-state.json 的旧暂存目录也不自动识别为可续跑批次。

当前备份为目录格式，含 backup-manifest.json。校验限制为 200,000 个文件、展开内容 20 GiB、清单 32 MiB；拒绝路径逃逸、符号链接、重复清单项及大小／哈希不符。不是 ZIP 导入导出；桌面恢复到新目录后显式切换，原地恢复仍不提供。

需要回到旧版本时，从升级前 JSON 备份恢复到**新目录**，保留新版 SQLite 目录；备份时点之后的修改不在旧副本内。当前版本会拒绝未知格式，但已经存在的 D0 二进制没有新版格式防护，不能让它直接打开 SQLite 目录。完整的旧版拒写、界面告知与目录切换验收仍属于 D1-05。

## 本轮迁移恢复验证

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

## 后续完成条件

1. **D1-02／04：迁移入口与可见损坏处理。** 迁移批次／进度和中断续跑已实现并通过本机测试；仍需桌面入口，对坏记录和临时文件提供可见清单、隔离及选择性恢复，并完善准备阶段失败说明。
2. **D1-03／05：可交付的备份恢复入口。** 完成 ZIP 容器校验、桌面选择／切换、恢复前备份、失败回退和兼容版本提示；离线目录工具只是基础。
3. **D1-06：生产文件操作日志。** 当前 JSON 与 SQLite 已为原文件写入／删除记录稳定操作 ID、预期哈希、执行状态、错误和恢复时间；启动检查文件状态并幂等完成可确认的 pending，检查清单显示 failed。仍需将原文件操作与关联记录事务协调，验证完整崩溃边界和幂等重放；现有日志接入不等于跨数据库／文件恢复全部完成。
4. 完成上述基础后进入 D2 删除预览、活动任务协调和全链路来源缺失显示；之后推进 D3 设置／凭据／草稿恢复、D4 成果交付、D5 发布验收。
