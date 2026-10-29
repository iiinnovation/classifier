# 本地测试构建清理

2026-10-27 按用户要求清理过期测试包。清理前有 4 套完整构建；删除其中 2 套旧 D1 构建和 9 个仅剩打包元数据的旧目录，合计约 1.05 GiB 文件占用。

当前保留：

- `dist/desktop-d2-2026-10-27/`：最新 D2 预览包。
- `dist/desktop-d1-disk-failures-2026-10-26/`：[已登记回退基线](rollback-baseline.json)。
- `dist/desktop/`：约 956 KiB 的历史测量文件和元数据，已无完整安装包。

已删除的完整构建为 `desktop-d1-record-contract-2026-10-26` 和 `desktop-d1-record-shape-2026-10-26`。其余清理目录、删除前文件占用及构建哈希见 [清理记录](measurements/build-artifact-cleanup-2026-10-27.json)。历史验收日志、截图和源码哈希继续保存在 `docs/measurements/`；旧文档中的构建路径只表示历史产物，不能据此认为该包仍在本地。

清理后核对最新 D2 与回退包的 ZIP／ASAR 哈希均未改变，回退基线验证通过。源码、用户资料库与 OCR 构建资源未清理。文件占用按删除前分配块累计，不将其等同于 APFS 实际可用空间增量。
