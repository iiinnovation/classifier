# Classifier · 科研文献助手

独立运行的科研助手原型：导入论文和文档，围绕原文提问，点击引用回到对应页或段落。支持本地扫描文字识别、结构化表格、Word 原生公式及 PDF 页图核对。当前以单篇文献研读为基础，后续扩展多文献比较、综述与主张核验。

## 启动

需要 Node.js 22.13+（建议 Node.js 24 LTS）。在本目录运行：

```sh
npm ci
npm start
```

扫描件 OCR 需要另外安装 Tesseract 和语言包，macOS 可运行 `brew install tesseract tesseract-lang`；本机已安装。

打开 <http://127.0.0.1:8790>。无需配置模型即可导入文档和检索原文。

需要生成回答时，将 `.env.example` 复制为 `.env`，填写模型服务提供的完整 Chat Completions 地址、API Key 和模型名称，然后重启服务：

```dotenv
CLASSIFIER_MODEL_API_URL=https://your-provider.example/v1/chat/completions
CLASSIFIER_MODEL_API_KEY=your-key
CLASSIFIER_MODEL=your-model
```

模型须支持 function tools。密钥只保留在服务端；启用模型后，问题和相关文档片段会发送给所配置的模型服务。未配置模型、调用失败或引用校验失败时，界面展示原文检索结果。

## 第一版能力与边界

- PDF、DOCX、Markdown、TXT、HTML 文件导入；单文件最多 25 MB，PDF 最多 500 页，提取文本最多 200 万字符。
- 原文件保存、文献列表、中英文关键词检索、单篇问答、引用跳转和问答记录。
- PDF 按页及坐标定位，支持页图高亮核对；本地 Tesseract 识别扫描文字。支持表格行列和规则合并单元格、DOCX 原生公式转 LaTeX。PDF / 扫描公式保留字符和页图，复杂数学结构仍需核对。参见 [复杂文档解析](docs/document-parsing.md)。
- 导入使用后台任务，显示页码进度，可取消；支持自动识别或全页 OCR。已有文档需重新导入才能获得新的结构信息。
- 回答区分原文事实和归纳判断。引用校验保证 ID 属于当前任务读取过的片段，**不保证模型判断必然被该片段支持**，研究结论仍需对照原文核验。
- 问答可取消，90 秒超时，最多 8 次工具调用；重启后未完成任务标记为中断，可重新提问。
- 原型使用本地 JSON 文件，默认保存于 `data/`。目前面向本机单用户、单进程运行；未提供账号、共享权限或公网部署能力。同一数据目录只能运行一个服务进程。
- 暂未包含 URL 导入、跨文献问答、DOI 元数据、语义向量检索或模型训练。

## 项目结构

```text
apps/api/src/   HTTP API、文档解析、检索、Agent 和任务存储
apps/web/       科研文献工作台
tests/         检索、Agent 引用约束、文档解析与 HTTP 流程测试
docs/          API 约定与产品架构
data/          本地原文件、文档记录和问答任务（不纳入 Git）
```

运行 `npm test` 验证基础流程。HTTP 测试会临时监听本机随机端口，并使用独立临时数据目录；不调用真实模型。

参见 [API 约定](docs/api.md) 和 [产品与架构边界](docs/product-boundary.md)。
