# Word 导出：截图审查与格式调整

日期：2026-10-30。依据用户提供的两张 WPS 截图，已确认旧版短文的中文、章节、核对状态和引用编号可读。截图覆盖部分页面，不证明全文分页、链接跳转或编辑保存后重开通过。

## 已调整

| 截图中的问题 | 新版处理 |
| --- | --- |
| 文献 UUID、完整解析哈希和片段 ID 占据出处区 | 正文显示文件名、原文位置与来源状态；编号对应的文献 ID、解析指纹和片段 ID 保存在 `docProps/custom.xml` 的 `ClassifierCitationSources` 属性中 |
| PDF 位置重复显示“第 2 页” | 引用标题已有对应中／英文页码时复用标题；缺少页码时补上原文页码 |
| 保存时间含 `T`、毫秒和 `Z` | 正文按导出设备时区显示日期、小时和分钟，并明确 GMT 偏移；原始保存时间保留在文档核心元数据中 |
| 一条引用的说明在页尾、摘录从下一页开始 | 书目、位置、状态、DOI／链接与摘录之间设置“与下段同页”；长摘录仍允许自然跨页 |

文件没有设置绿色页背景；截图中的绿色来自 WPS 显示设置。正文、研究判断、条件、引用顺序、书目和历史摘录均沿用保存的快照。Markdown 沿用原有导出表示。

截图归档：[短文](measurements/d4-word-layout-2026-10-30/wps-before-short.png)、[出处分页](measurements/d4-word-layout-2026-10-30/wps-before-citations.png)。

## 验证

相关 Node **34/34**、SQLite Chrome 实际 Word 下载 **1/1** 通过；最终 Mac x64 包的桌面下载与研究主线结果见 [验证记录](measurements/d4-word-layout-2026-10-30/validation.json)。短文、2 万字长文和历史引用的新版样本已生成；macOS 原生导入逐份核对完整文字与预期一致。

自动化检查证明字面内容、引用目标、隐藏追溯信息、无重复 PDF 页码和分页属性正确；实际 WPS 分页效果仍需复核。编辑后的核对工具已增加自定义引用元数据保留检查，不能只核对可见正文后认为追溯信息完整。

## 继续验收

新版 [短文](measurements/d4-word-layout-2026-10-30/samples/01-short.docx)、[长文](measurements/d4-word-layout-2026-10-30/samples/02-long.docx)和 [历史引用](measurements/d4-word-layout-2026-10-30/samples/03-historical.docx)已用于后续检查，原样本保留。短文已请求在 WPS 打开，检查出处说明与摘录开头是否留在同一页；再修改指定句子，另存并重开，按 [办公验收步骤](office-acceptance.md)检查正文、内部链接和自定义引用元数据。

新试用包目录为 `dist/desktop-d4-word-layout-2026-10-30/`，仅 Mac x64，未签名／公证。本轮不将旧版 437 项 Node、18 项浏览器或 7 项桌面结果计作本轮重跑，也不将所添加的分页属性等同于新版 WPS 界面验收通过。
