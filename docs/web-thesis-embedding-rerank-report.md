# 增强功能报告：通用自定义向量模型 + 可选重排序

日期：2026-11-14。分支：`qoder/web-thesis`。关联：[设计方案](web-thesis-embedding-rerank-plan.md)、[RAG方案](web-thesis-rag-plan.md) §8。
状态：实现完成，离线 37/37 通过，浏览器 UI 验证通过；在线检索消融见 `baseline-results/ablation-*/`。

## 1. 需求与授权

用户提供 SiliconFlow `BAAI/bge-m3`（1024 维向量）与 `BAAI/bge-reranker-v2-m3`（重排），要求检查方案是否已有「自定义向量模型 + 重排序」配置能力，没有则设计并实现。核查结论：原系统仅有固定预置模型与「阿里云」专用项，无通用自定义端点、无重排；重排在方案中为 P3 选修且需另行确认。用户本次授权即该确认。

## 2. 修改文件及理由

| 文件 | 改动 | 理由 |
| --- | --- | --- |
| `embedding.js` | 新增 `custom` 提供商（baseUrl/model/key，1024 维校验），auto 链纳入 custom | 通用 OpenAI 兼容向量端点配置 |
| `rerank.js`（新增） | 重排配置解析 + `rerankDocuments` 调用 /rerank + 校验；失败抛错由上层降级 | 可选重排能力 |
| `rag.js` | 新增 `retrieveDetailed`（融合后可选重排，记录实际路径诊断，失败保 RRF 原序+warning）；`retrieveAsync` 兼容包装 | 重排集成与可观测来源 |
| `tools/search-in-book.js` | 来源标签改用本次实际路径（含 +rerank），不再按建库 mode 推断 | 修正降级/重排后来源标签失真 |
| `server.js` | embedding-settings 扩展 custom；新增 rerank-settings GET/PUT/DELETE；注入 rerank Key 解析 | 配置 API |
| `public/index.html` + `public/app.js` | 向量下拉新增「自定义」+表单；新增重排设置卡（启用/地址/模型/TopN/密钥） | 配置 UI |
| `tests/helpers/fake-model-server.js` | 新增 /rerank 端点与 rerankError 注入 | 离线测试 |
| `tests/rerank.api.test.js`（新增） | ER-01~05 + rerankDocuments 排序 | 确定性回归 |
| `scripts/run-retrieval-ablation.js`（新增） | BM25 vs 混合 vs 混合+重排 在线消融 | 效果对照 |

未改：分块/RRF 常数/召回数量；`database.js` 无新表（复用 user_settings + api_keys）；mobile/、受保护数据未触碰。

## 3. 验证

### 离线（`npm test`，37/37 通过）
- ER-01 自定义端点建库 mode=embedding+bm25，embed_provider=custom。
- ER-02 启用重排后来源含 `+rerank`。
- ER-03 重排失败保留融合结果 + rerankWarning，不中断。
- ER-04 关闭重排不调用（消融条件），来源回到 hybrid。
- ER-05 配置按用户隔离，Key 不入日志。
- rerankDocuments 按相关性降序、索引合法。

### 浏览器（隔离+假模型）
- 设置页经 UI 选择「自定义」向量端点并保存 → 生效「自定义端点·fake-embed」（截图 09）。
- 经 UI 启用重排并保存 → 生效「fake-rerank · Top 5」。
- 重建索引 embedding+bm25；Agent 检索来源 `hybrid(embedding+bm25)+rerank`，重排后最相关章节排首。

### 在线检索消融（真实 SiliconFlow）
固定 query=question，Top5，20 题（16 可答），金标准为本地原文子串。结果见 `baseline-results/ablation-2026-11-14T09-39-04-053Z/report.md`：

| 条件 | Hit@5 | Recall@5 | MRR@5 | 延迟P50 | 延迟P95 |
| --- | --- | --- | --- | --- | --- |
| BM25 | 0.750 | 0.625 | 0.580 | 4ms | 272ms |
| 混合(bge-m3) | 0.875 | 0.719 | 0.535 | 103ms | 308ms |
| 混合+重排 | 0.813 | 0.656 | 0.688 | 329ms | 484ms |

**分析（开发集初测，非正式结论）：**
- 混合检索较 BM25 提升 Hit@5（0.750→0.875）与 Recall@5（0.625→0.719），但 MRR 略降（0.580→0.535）：向量补充了相关候选，融合排序有时把首个相关块排后。
- 重排提升 MRR（0.535→0.688，三者最高），但 Hit@5/Recall@5 回落（0.875→0.813 / 0.719→0.656）：重排把部分含证据块挤出 Top5，排序更精但覆盖下降；延迟约为混合的 3 倍。
- 结论：在本 16 题开发集上，重排并非全面占优（MRR 收益伴随覆盖损失与更高延迟）。按方案「纳入条件为收益超过时延与成本」，**重排保持默认关闭、作为可选配置**，是否在更大标注集上启用待 P3/P4 评测决定。混合检索的覆盖收益较明确。
- BM25 条件与 P0 基线完全一致（0.750/0.625/0.580），一致性校验通过。

## 4. 已知限制与边界

- 自定义向量模型须输出 1024 维（与 rag_vec 表一致）；其他维度需改表结构，另立任务。
- 重排默认关闭，增加一次调用与延迟；失败保留原序（符合方案）。
- 重排分数为相关性排序分，非概率，不与 BM25/RRF 跨类型比较。
- 本增强不改 P0 基线（无重排/无向量）对照条件；消融脚本提供禁用重排条件。
- 凭据存于被 git 忽略的 `.env.baseline.local`，不入库、不打印。