# P1b 阶段报告：可核验 RAG 引用闭环

日期：2026-11-14。分支：`qoder/web-thesis`。关联：[RAG方案](web-thesis-rag-plan.md)、[SC-1.2](web-thesis-shared-contracts.md)、[总方案](web-thesis-plan.md)、[P1a报告](web-thesis-p1a-report.md)。
状态：R1~R4 实现完成；离线 76/76 通过；浏览器 21 个定位/引用场景 + 黄金路径通过；真实模型开发集评测完成。未提交未推送。

## 1. 修改文件及理由

| 文件 | 改动 | 理由 |
| --- | --- | --- |
| `text-utils.js` | 重写：normalizeText/contentHash/parseChapters/chapterDTOs/sliceAtSafeBoundary/chunkContent（范围分块）；splitChapters 改为规范章节表示 | 唯一规范文本与坐标（R1）；代理对安全、非空白全覆盖、不跨章 |
| `database.js` | 迁移 `web_002_rag_locator`：rag_chunks 增 index_version/content_hash/chapter_id/chapter_ordinal/start_offset/end_offset；rag_index_meta 增 active_version；新表 rag_index_versions；条件唯一索引（同书单 building、版本内 chunk_index 唯一） | 版本化索引与定位的数据基础；只做加法不删旧数据 |
| `rag.js` | 重写：版本状态机 building/ready/failed/cancelled/retired；同书互斥409；失败保旧；发布短事务原子切换；查询快照使用计数；版本化 BM25 缓存；embed 指纹校验；向量软预算8s；RetrievalResult 真实路径诊断；邻接扩展 expandAdjacentRanges；recoverStaleBuilds | R2 构建/检索/清理不变量 |
| `embedding.js` | signal/deadlineAt；全量向量校验（数量/维度/有限数值/index 重排去重缺失）；embedFingerprint（不含Key） | 向量一致性与取消传播 |
| `server.js` | getBookContent/GET book 返回规范 content+contentHash+chapters；索引路由新 IndexStatus 视图+409+取消传播+分块参数；新增 GET content-meta；messages 路由默认全量+MessageView；启动 recoverStaleBuilds | R2/R3a 服务端契约 |
| `qa-service.js` | 选文 locator 验证（409/422）；重放先于 Key/原文校验；证据 verified 升级与按 locator 去重；最终引用规范化 normalizeCitations + citedEvidenceIds 持久化；零证据门控补强 | R3a 引用闭环与缺证诚实 |
| `agent.js` | toolContext 传 contentHash/chapters/signal/deadlineAt；tool_result 附加 source | 工具定位与来源透出 |
| `tools/*.js` + `tool-result.js` | 三工具透传 locator/chunkId/contentHash；全文兜底真实位置（多处上限3）；章节歧义返回；截短同步改 locator.end | R2b 来源不丢定位 |
| `public/app.js` | 阅读器按服务端章节 pre-wrap 渲染 + TextNode→偏移映射；选文 locator 计算；引用安全渲染（跨chunk/未知/未闭合）；证据卡片+跳转高亮+返回对话；历史引用恢复；索引UI新视图 | R3b 前端定位与跳转 |
| `public/styles.css` | reader-block/citation-btn/citation-invalid/citation-highlight/evidence-card/return-chat-btn | 配套样式 |
| `tests/*`（新增4+更新3） | text-utils/rag-retrieval/rag-version/p1b-citations 新测试；rag.api/rerank.api/fake-model 适配新契约+向量异常注入 | 确定性验收 R-T01~T20 |
| `scripts/*` | run-p1b-eval（引用/坐标/端到端）、run-p3-ablation（增量消融）、p1b-browser-harness（浏览器验证）、run-retrieval-ablation 适配 | R4/P3 评测与验证 |

## 2. 迁移

- `web_002_rag_locator`（前置 `web_001_request_contract`）。隔离副本验证：旧 schema 加列不删数据、旧行 locator 为 NULL、active_version=NULL 标旧版；重复执行幂等（tests/text-utils.test.js）。
- 真实业务库未迁移、未重建；旧索引在 UI 标“旧版/需重建”，不假装可跳转。不删除 books/、rag_index/、data.db。

## 3. 验证

### 离线确定性（`npm test`，76/76，退出码0）
- R-T01~T05 文本/分块/迁移；R-T06~T14、T20 版本/检索/清理（rag-retrieval + rag-version）；R-T15~T18 引用/选文（p1b-citations）；P0/P1a 回归全通过。
- 关键不变量：text==原文slice、非空白全覆盖、代理对不切断、同书单building、失败保旧、迟到批次不写孤儿、查询不混版、empty/error/unavailable/legacy/stale 可辨、引用白名单与历史一致。

### 浏览器（隔离+假模型，harness）
21 场景全通过：S1重复段落不同locator、S2空行保留、S3再跳转恢复旧高亮、S4emoji完整、S5跨块高亮、S6高亮后选文映射、S7字体/主题不影响偏移、S8返回对话、S9 TOC、S10历史恢复引用、S11 E99不可点击、S12正文外选文降级、S13重建同hash仍可跳、S14原文变化提示失效、S15删书来源不可用、S16选文verified、S17索引新视图、S18未闭合规范化、S19跨块标记重组、S20证据卡跳转、S21无索引缺证。黄金路径（问答→证据卡→引用跳转高亮）通过。
截图：`docs/baseline/screenshots/p1b-01-citation-highlight.png`、`p1b-02-evidence-cards.png`。应用控制台无错误。

### 真实模型开发集（qwen3.8-flash + bge-m3，20题）
见 `baseline-results/p1b-2026-11-14T13-30-14-034Z/`：

| 指标 | P1b | 对照 |
| --- | --- | --- |
| 引用坐标正确率 | **1.000（186/186）** | 目标100% |
| 引用合法率 | **1.000（73/73）** | 目标100% |
| 端到端证据 Hit@5 | 0.875 | P0混合基线0.875 |
| 端到端 Recall@5 | 0.781 | — |
| 无据回答率 / 漏查率 | 0 / 0 | P1a 0/0 |
| 错误率 | 0 | — |
| 平均工具调用 | 2.6 | P1a 2.85 |
| 首字P50 / P95 | 22.2s / 53.1s | P1a 34.6s（改善） |

检索消融（P1b 坐标化分块500，直连检索）：BM25 Hit@5=0.563、混合0.688、混合+重排0.813（MRR0.700）。**较旧分块基线（BM25 0.750/混合0.875）有回落**，系范围分块边界变化所致；端到端因 Agent 多轮检索仍达0.875。该回落由 P3 分块调优回收（见 P3 报告）。

## 4. 已知限制

- no-answer 题仍可能以“相关但不充分”证据作答（insufficient=0），语义缺证判断待人工标注与 P3；当前仅零证据标缺证。
- 答案正确率/引用支撑率待人工标注；本报告为开发集初测，非保留集。
- 单进程部署假设；查询快照使用计数为进程内，多进程需跨进程租约（不在本阶段）。
- 旧索引（active_version=NULL）不消费于新引用链，需用户确认单书重建。
- 首字P95仍偏高（取证+真流式权衡），P3 继续优化。

## 5. 边界自查

- 分支 qoder/web-thesis；无 mobile/ 改动；受保护数据完整；迁移只做加法。
- 凭据存于被 git 忽略的 `.env.baseline.local`；日志/事件/导出不含 Key、内部ctx、完整私有书籍。
- 浏览器 harness 的临时凭据文件 `.p1b-browser-harness.json` 为测试产物，验收后删除。
- 未提交未推送。

## 6. 论文素材

- 规范文本/原文定位图、索引发布状态机图、RAG流水线图、版本表ER图（rag_index_versions/rag_chunks/rag_vec）。
- 引用跳转截图（p1b-01/02）、失败保旧与缺证截图、冷/热延迟表、检索消融表、引用合法/坐标100%证据。