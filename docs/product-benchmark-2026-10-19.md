# AI 研究产品对标：减少用户输入和跨功能搬运

检索日期：2026-10-19。来源：各产品官方说明、帮助中心和官方发布文章。此次为公开资料研究，未登录付费账户完成同题实测；不据营销描述认定准确率、实际耗时或用户满意度。此文是产品建议，尚非已确认的整体重设计需求。

名称更新：Google 已于 2026-07-16 将 NotebookLM 更名为 Gemini Notebook；下文保留旧名以便对应用户熟悉的产品和早期文章，指同一产品。官方当前产品页：https://notebook.google/；更名公告：https://blog.google/innovation-and-ai/products/gemini-notebook/notebooklm-gemini-notebook/ 。

## 用户问题与判断

用户认为笔记、内容填写和表单太冗余，并进一步追问为什么 AI 产品仍然显得低效，要求检索类似产品。

根据当前已检查的流程，我的判断是：主题、笔记、比较和成果分别存在，但用户仍要承担较多整理与串联工作。上一轮内容置顶、折叠属性和取消空栏目只减少了界面负担；接下来需要让 AI 实际完成资料整理、证据抽取和跨文献综合。

已有从原文／问答保存笔记、复制笔记到比较、生成笔记建议和成果材料整理等能力。不能把这些写成从零缺失；需要核对它们能否共同支持一个持续的研究任务。

## 对标产品

| 产品 | 官方资料确认的流程 | 对本产品的启发（判断） | 边界 |
| --- | --- | --- | --- |
| NotebookLM | 来源支持问答与成果生成；Google 的 2026-06-08 文章（07-16 更新）说明可从初步想法出发，在对话中发现来源并生成多种成果 [1] | 以资料和研究目标启动；结果与来源共同留在工作空间；缩短到第一份有用结果的路径 | 文章中新一轮能力发布面向特定套餐，不能推定所有账号可用；未做结果质量实测 |
| Elicit | Research Agent 将找文献、数据抽取、单篇研究与综合串联；2026-09-30 将 Find Papers、Extract Data、Chat with Papers 纳入 Agent。仍另设 Research Reports 和 Systematic Review [2][3] | 让用户交付任务，让系统完成步骤；日常探索与严格结构化审查分层 | 系统综述仍需要筛选标准和提取规范；不能声称专业研究完全不用配置或核对 |
| SciSpace | Deep Review 从问题生成主题、研究趋势、方法和缺口，支持追问、查看原文片段与保存重点；官方教学包含证据矩阵与跨研究综合 [4][5] | 读到不懂处直接解释；比较结果与对应证据相邻；减少离开阅读上下文填写表单 | 官方教学明确要求人工核对关键数据与结论；不是质量已保证的全自动综述 |
| Consensus | Deep Search 分解研究问题并检索，生成带引用的报告，呈现研究共识、关键主张与研究空白 [6] | 优先展示回答问题所需的证据和分歧，让用户先获得判断材料 | 偏科学研究检索与综合；不能等同本地资料管理。发布文中的数据库规模、速度和额度不作为本次对比结论 |
| 腾讯 ima | 官方页展示多格式知识导入、知识库问答及原文溯源、copilot 任务处理与 AI 笔记创作 [7] | 参考中文环境的搜、读、写连续体验；知识入库后应直接用于任务和写作 | 不是专门的系统综述工具；不据此推断其研究级证据管理、离线能力或准确率 |

## 方向提案

目标：用户提供材料和意图，系统完成第一轮整理与综合，用户在结果上核对、修订和继续追问。

优先参考 NotebookLM 的材料到成果路径、Elicit 的任务连续性；中文输入与写作体验参考 ima。这是基于上述公开流程的产品判断，不是付费实测排名。

建议第一个完整场景：

1. 用户导入一组文献，输入“比较这些论文的方法和结论，看看分歧在哪里”，或者点击同含义的快捷任务。
2. 系统读取已有主题和材料，提出可修改的比较维度，生成带出处的对照草稿；材料不足时明确显示未找到。
3. 用户点击单元格核对出处，直接修改结果，或说“只看实验研究，再加一列样本量”。
4. 基于已核对材料形成连续文稿，保留引用；采用后成为可继续编辑的成果，不再手工把笔记搬进下一张表。

上述是拟实现的验收场景，不是当前已交付能力。已有建议、材料选择和版本机制应复用，不把整个产品重写为聊天记录。

### 交互分工

- 用户：研究目标、必要范围、证据核对、最终判断。普通输入只要求影响结果的必要信息。
- 系统：复用上下文，抽取已有材料，生成可编辑草稿，维护来源关联，呈现进度和失败重试。
- 结构化界面：用于阅读／比较／修订结果，以及有需要时配置规则；自然语言和快捷任务负责发起工作。
- AI 产物进入建议／草稿区；保留采用操作与人工编辑保护。批量采用可作为提案，不能默认覆盖已有内容。
- 没有配置模型时仍能阅读和手工记录。后台自动触发模型处理及发送材料的策略另行讨论，不在本轮研究中改变。

### 验收建议

- 在不填写逐篇笔记、逐格比较内容的前提下，完成一次“材料 → 带证据的比较草稿 → 成果草稿”。
- 每项抽取结果都能回查所用出处，未找到／无法确认不能自动填成结论。
- 新增一个维度或继续追问能复用现有材料，用户无需重新输入主题、文献和已确认内容。
- 对比现有流程，记录手动输入字段数、跨页面搬运次数、首次有用结果耗时、人工修正量；先建立基线，不编造提效百分比。
- 草稿、版本、出处快照、冲突保护与人工编辑不被更新结果覆盖。

## 来源

以下网页于 2026-10-19 检索／核对。产品能力以各页面说明为依据，账户权限和实际体验需另行测试。

1. Google, Do better research with NotebookLM，发布 2026-06-08，更新 2026-07-16：https://blog.google/innovation-and-ai/products/notebooklm/better-research-notebooklm/
2. Elicit, Getting started with Elicit: Which workflow should I use?：https://support.elicit.com/en/articles/14757543-getting-started-with-elicit-which-workflow-should-i-use
3. Elicit's Research Agent：https://support.elicit.com/en/articles/14756886-elicit-s-research-agent
4. SciSpace, How to Use Deep Review for Advanced Literature Analysis in SciSpace，2026-07-22：https://scispace.com/help/en/articles/10864812-how-to-use-deep-review-for-advanced-literature-analysis-in-scispace
5. SciSpace Academy, How to Conduct a Literature Review with AI：https://learn.scispace.com/tutorials/how-to-conduct-literature-review-with-scispace
6. Consensus, Introducing: Consensus Deep Search，2025-07-09：https://consensus.app/home/blog/deep-search/
7. 腾讯 ima 官方产品页：https://ima.tencent.com/download
