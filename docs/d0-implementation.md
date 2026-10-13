# D0：桌面运行验证

状态：进行中（2026-10-11 更新；Node／打包桌面测试于 10-11 重跑，业务回归于 10-10 完成）。目标与退出条件沿用 [桌面交付方案](desktop-release-plan.md)，不会以单机或开发模式通过替代完整 D0 验收。

后续 [D0 review 与修复](review-d0-2026-10-11.md) 已修复退出监听、进程启动失败和关闭竞态，66 项 Node 与 7 项新包桌面测试通过。下文资源表保留 review 前构建的历史结果；新包需以新增报告为准。review 同时发现旧取消测试可能命中 `--list-langs` 而非实际 OCR，旧报告不再作为严格 OCR 中途取消的通过证据。

## 目标矩阵与当前环境

首发验证矩阵定为 macOS 14 及以上（x64、arm64）和 Windows 11 24H2 及以上（x64），最低基线为 8 GiB 内存、SSD。Electron npm 版本固定为 44.7.0，electron-builder 固定为 26.15.3。本机打包主进程及 utility 后端实际返回 Node 24.21.0、Electron 44.7.0，Chromium 152.0.7977.130；其他目标平台仍需实际获取运行结果。

当前可用测试机为 macOS 26.7（25G229）、Intel i7-1068NG7、x64、32 GiB 内存。它不能替代其他架构、Windows 或最低配置机器的验收。当前没有跨平台运行结果；本轮没有推送分支或触发远程 CI。

## 实现进度

| 清单项 | 当前状态 | 尚需证据 |
| --- | --- | --- |
| D0-01 | 目标矩阵和 npm 版本已选定 | 各目标平台运行时、最低配置和实际内置 Node 验证 |
| D0-02 | 本机打包程序已验证二次启动恢复原窗口、后端异常退出提示、OCR 中途关闭及主进程强制退出，无观测到的残留进程 | 其他目标平台；实际应用启动失败路径 |
| D0-03 | Node 协议／认证测试及真实 utility 后端重启验证通过；旧令牌失效，新令牌可用 | 其他目标平台及更完整的导航／权限验收 |
| D0-04 | Mac x64 打包程序在系统命令 PATH 下完成 OCR 和页图；Windows x64 资源已准备并校验文件 | 无开发环境机器；Mac arm64 资源；Windows 实际运行及第三方许可核对 |
| D0-05 | API 错误分类、设置提供器已接入各模型路径；Node 专项和 Electron 业务回归通过 | 多轮／多页在途配置和其他目标平台验证；授权撤销仍属 D3 |
| D0-06 | 存储接口与桌面草稿命名空间已实现；打包应用崩溃后重开及正常重开恢复未保存笔记，不同窗口会话由业务回归覆盖 | 所有编辑器的完整崩溃／强制退出恢复在 D3 验收 |
| D0-07 | 38 个既有业务场景在 Electron 与 Chrome 中均通过 | 其他目标平台持续回归 |
| D0-08 | Mac x64 最终包所有本机资源门槛通过，见分阶段原始报告及汇总 | 其他平台／最低配置证据；文字 PDF 峰值余量较小 |

桌面应用不自动读取仓库 `.env`；当前设置由注入的内存提供器供给，正式设置 UI、系统凭据与授权撤销仍属于 D3。开发服务显式使用环境适配器。运行中任务获得配置快照，记录不保存密钥。

## OCR 资源

Mac x64 当前来源为本机 Tesseract 5.5.3。生成脚本复制 16 个非系统二进制／动态库，重写绝对路径和 `@rpath` 依赖，附带 `eng`、`chi_sim`，并生成逐文件 SHA-256 清单。当前清单为 42 个文件、16,210,026 字节，已在仅含系统命令的 PATH 下验证版本与语言列表，并在打包应用中完成扫描件导入、OCR 文字及引用坐标、PNG 页图显示验证。

`resources/ocr/<platform>-<arch>/` 是生成资源，不纳入 Git；包构建校验清单及 Mac 动态库依赖闭合。leptonica 与 tessdata-fast 许可文本现已补齐，Mac 清单没有缺失声明的来源包；这不替代 D5 的完整分发许可审核。OCR TSV 输出改用 `-c tessedit_create_tsv=1`，避免依赖打包目录未包含的 `tessdata/configs/tsv`。

Windows x64 准备脚本固定安装程序／语言包来源及 SHA-256，检查 PE x64 架构。现有生成资源为 62 个文件、104,240,157 字节，文件校验通过，但 `runtimeValidated: false`，Windows DLL 依赖闭合与完整第三方许可仍待核查。Mac arm64 资源未准备，不能复用 x64 原生模块。

## 生命周期与回归证据

- Node 测试 60/60 通过，验证 API、协议桥、来源／实例认证、错误分类、设置快照、草稿命名空间，以及 worker 页图、取消、画布复用输出一致性和 50 页大结果的完整 IPC 传输。
- Electron 业务回归与 Chrome 基线均为 38/38 通过，包括不同编辑会话、版本冲突、响应丢失、故障恢复和二进制下载。Electron 业务 fixture 使用生产协议桥及受控后端，不替代真实 utility 后端测试。
- 打包入口测试使用系统命令 PATH 和独立临时用户目录。生命周期测试验证：二次启动退出并恢复原窗口；真实 utility 后端拒绝无令牌／错误来源访问且重启轮换令牌；后端被强制终止时提示断开并返回 JSON 503；关闭窗口取消正在执行的 Tesseract，落盘任务为 cancelled；强制终止主进程后应用进程树退出。
- 打包冒烟验证扫描件 OCR、页图和主题持久化；页面没有 Node 接口，预加载只暴露会话标识和协议版本，远程新窗口被拒绝。未保存笔记在渲染进程崩溃后重开和正常退出后重开均可由界面恢复。当前不承诺渲染进程崩溃后原窗口自动恢复，自动恢复体验仍属于 D3。

六项打包桌面测试全部通过。`tests/helpers/desktop-application.mjs` 在退出后检查所有已观测进程，并仅在断言失败后清理本次测试的残留。测试专用故障注入和进程控制未加入生产入口或打包文件。成功测试的运行时及认证状态码证据保存在 `test-results/electron-shell/*/desktop-runtime.json` 与 `backend-authentication.json`，不保存实例令牌。

## 资源测量与修复

测量使用未签名的 Mac x64 ZIP 和正常打包可执行文件，只启用渲染页面 CDP；不启用 Node inspector，不使用 Playwright 的 Electron 启动参数。应用 PATH 仅为 `/usr/bin:/bin`。资源数据取全部应用进程树 RSS（共享页可能重复计数），空闲附 `vmmap` physical footprint。20 次启动完整退出并使用独立空资料库；OS 文件缓存未清空。

首次测量保存在 `dist/desktop/measurements/before-canvas-reuse.json`：50 页 PDF 导入峰值 1540.5 MiB，10 次取消后增长 192.4 MiB，两项超限。旧应用 ASAR SHA-256 为 `c2a7ab033724d53dbd6e61b71887daeed113c90227db7f7842a551ce25d5fc64`。未将“测量完成”当成“门槛通过”。

`pdf.mjs` 原先逐页新建高分辨率和表格检测画布，原生图像内存回收依赖 JS GC。现已复用这两份画布并在解析结束后释放尺寸；复用页图与独立渲染进行 PNG 对照，防止旧页面像素残留。50 页文字 PDF 保持原样本，字节数与 SHA-256 随报告保存。取消报告补充基线、每轮及结束进程树，并单独检查 Tesseract 残留。

取消残留进一步拆分：原画布复用包的 10 次取消后增长 265.8 MiB，Tesseract 残留为 0，主要增长来自 utility 后端。等待 worker 自然退出、确保 finally 清理及清除 Skia 缓存后仍增长 185.2 MiB，不能据此标为通过。两次失败报告分别保留为 `before-cancel-cleanup.json` 和 `after-worker-cleanup.json`。桌面解析因此增加短生命周期 Node 子进程，内部仍用原 Node worker 执行 PDF.js；每次任务完成或取消后等待进程退出，释放原生分配器驻留内存。Node 开发服务仍用 worker。解析子进程失去父 IPC 连接时取消任务并限时退出；桌面测试已将主进程强制退出场景加强为 OCR 实际执行中，以检查整个进程树。

独立解析进程的首次取消复测增长 42.73 MiB；最终 IPC 修复构建复测增长 **43.4 MiB**，均低于 100 MiB 上限，Tesseract 残留为 0；退出后全部已观测应用进程结束。最终报告为 [darwin-x64-cancel.json](measurements/d0-mac-x64/darwin-x64-cancel.json)。此改动只涉及桌面解析资源生命周期，不改变文献格式、引用坐标或存储方案。

完整复测还发现大结果 IPC 在发送完成前断开连接：50 页结果约 17 万字符，退出码为 0 但父进程尚未收到完整结果。现已等待所有 IPC 发送回调完成后断开，并增加独立子进程的 50 页回归，检查最后一页内容完整。`before-ipc-flush.json` 保留该次失败；修复后的 60 项 Node 及 6 项真实打包桌面测试均通过。

当前资源测量使用合成 PDF，不能替代真实材料质量验收。文字样本为 50 页、201,994 字节；扫描样本为 10 页、300 dpi，同一扫描图重复成页，适合可重复的生命周期检查，内容和图像多样性有限。中英文样本最初因 Arial 没有绘出中文字形而未通过内容检查；生成器现显式选择已安装 CJK 字体，缺字体时明确失败，重新固定样本 SHA-256。补测确认全部 10 页走本地 OCR 且中英文均保留。最低配置机器和真实无开发环境机器仍缺证据，D0 尚不能退出。

最终打包程序测量（同一个 ASAR，分阶段原始报告按哈希核对）：

| 指标 | 本机结果 | 门槛 |
| --- | --- | --- |
| ZIP 下载体积 | 156.18 MiB | ≤ 350 MiB，通过 |
| 安装目录占用 | 376.74 MiB | ≤ 800 MiB，通过 |
| 完整退出后启动 20 次 P95 | 1.468 秒 | ≤ 8 秒，通过 |
| 空资料库稳定 RSS P95 | 386.79 MiB | ≤ 450 MiB，通过 |
| 50 页文字 PDF 峰值 RSS | 1224.31 MiB | ≤ 1228.8 MiB，通过但余量约 4.5 MiB |
| 10 页英文扫描 OCR 峰值 RSS | 936.31 MiB | ≤ 1536 MiB，通过 |
| 10 页中英文扫描 OCR 峰值 RSS | 936.18 MiB | ≤ 1536 MiB，通过；10 页内容检查通过 |
| 10 次导入／取消后 RSS 增长 | 43.4 MiB | ≤ 100 MiB，通过；无 OCR 子进程残留 |

空闲 `vmmap` physical footprint 总计 151.5 MiB，与 RSS 口径不同。ZIP SHA-256 为 `d52de6a1ed170459daee9394b2514f103ee35d99e69fb52c963050c0ece6c57e`，ASAR SHA-256 为 `f776a02cda5a74c00da13790627114cabcd3012869880d1df82a18702707c478`。文字 PDF 的采样峰值接近门槛，不把这一次本机通过扩大为最低配置／其他平台通过。

原始资源报告和运行时／认证证据已复制到 [本机证据目录](measurements/d0-mac-x64/validation.json)，避免仅存在于被忽略的 `dist/` 和 `test-results/`。历史 `darwin-x64-all.json` 在取消阶段发生自动化超时，`completed: false` 原样保留；最终包的 `final-package-partial.json` 在中英文样本内容检查失败时停止，也原样保留，上表只引用其中已完成且通过的阶段。中文修正和取消循环分别补测，不修改失败报告冒充完整通过。分阶段复测报告使用相同应用 ASAR 与 ZIP 哈希。

自动化超时诊断确认，其中一次重测在导入前的 Playwright 点击稳定性检查等待动画帧超时；测量器改用同一界面的事件处理器、定时轮询及实际 OCR 子进程作为触发条件，不改变生产窗口配置、RSS 口径或采样时长。

最终 [资源汇总](measurements/d0-mac-x64/summary.json) 核对三份来源报告的 ASAR／ZIP 哈希一致，本机全部资源门槛通过。该汇总不改变原始报告的失败状态，也不宣称跨平台 D0 完成。

## 自动化入口

- `npm test`：Node API、协议桥、认证、错误分类、设置和存储适配器测试。
- `CLASSIFIER_BROWSER_CHANNEL=chrome npm run test:e2e`：原浏览器业务回归。
- `npm run test:desktop:business`：同一组业务场景，使用 Electron 页面和真实协议桥；受控 API 服务及故障注入仍由隔离 fixture 提供，不代表打包后端已经验收。
- `npm run test:desktop:shell`：实际桌面入口与 utility 后端，使用独立临时用户目录。
- `CLASSIFIER_PACKAGED_EXECUTABLE="$PWD/dist/desktop/mac/Classifier.app/Contents/MacOS/Classifier" npm run test:desktop:shell`：同一组生命周期测试针对真实打包程序。
- `npm run desktop:prepare-ocr`、`node tools/verify-ocr.mjs`：准备与验证本机架构 OCR 包。
- `npm run desktop:pack`、`npm run desktop:dist`：生成未安装目录及分发包，执行前必须具备目标 OCR 清单。
- `node tools/measure-desktop.mjs dist/desktop/mac/Classifier.app/Contents/MacOS/Classifier all dist/desktop/Classifier-0.1.0-mac.zip`：完整打包资源测量，包含中英文 OCR；也可单独指定 `startup`、`idle`、`pdf`、`ocr`、`ocr-bilingual`、`cancel`。

测试专用 Electron 入口在 `tests/helpers/`，不打入应用。当前构建工具审计有来自格式化依赖的 moderate 提示，已记录待核对；不使用 `audit fix --force` 自动替换工具链。

当前 D0 仍未达到退出条件；未进行 S0 迁移或对实际用户资料执行删除操作。
