# macOS 桌面测试启动

2026-10-28 的桌面回归曾在受限沙箱内启动 Electron，所有场景都在应用启动阶段失败。测试日志出现 `spawn EPERM`、`kill EPERM`；系统报告为 `SIGABRT`，堆栈位于 `HIServices._RegisterApplication`、`NSApplication.sharedApplication`，发生在启动约 0.19 秒后。用户报告的 PID 80110 和父进程 80100 与该次测试相符。

同一应用源码在获准的沙箱外运行后，真实桌面完整回归 27/27 通过。此次处理是修正测试执行环境；没有为该启动权限问题修改生产应用的菜单、存储或 Electron 版本。失败证据与复测记录归于 [D3 授权验证](d3-model-authorization.md)。

后续开发运行 GUI 测试时，应从正常登录桌面会话启动；编码代理处于受限沙箱时使用获准的沙箱外命令。出现端口、GUI 启动或进程查看权限错误后，先修正执行权限再复测。单凭 `SIGABRT` 或上述堆栈不能诊断所有崩溃，应结合启动时间、父进程、测试日志及权限环境核对。

`tools/run-desktop-tests.mjs` 默认首个失败即停止，避免同一 GUI 启动错误为每个场景重复生成崩溃提示。需要收集多个独立业务失败时可显式调整上限，例如：

```sh
npm run test:desktop:shell -- --reporter=line
npm run test:desktop:shell -- --max-failures=3 --reporter=line
npm run test:desktop:business -- --max-failures=3 --reporter=line
```

测试使用临时应用目录；无需更改或删除真实用户资料、重建 LaunchServices 数据库或关闭系统完整性保护。
