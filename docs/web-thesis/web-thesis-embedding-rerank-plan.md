# 增强方案：通用自定义向量模型 + 可选重排序

日期：2026-11-14。状态：用户已明确授权设计并实现（超出 P0 原定「不引入重排」边界，作为 P0 后增强）。
关联：[总方案](web-thesis-plan.md)、[RAG方案](web-thesis-rag-plan.md) §8、[SC-1.1](web-thesis-shared-contracts.md)、[P0报告](web-thesis-p0-report.md)。

## 1. 背景与授权

- 现状：Embedding 仅有预置（智谱 embedding-3 / 硅基流动 bge-large-zh-v1.5，模型写死）与「阿里云」专用自定义项；**无通用自定义端点**，**无重排**。
- 方案约定（rag-plan §8）：重排为选修，「对融合候选有限重排，优先复用已有可用提供商；新增配置/服务必须另行确认；失败保留原排序并记 warning」；纳入条件为 MRR/支撑率收益超过额外时延与成本。
- 用户本次提供 SiliconFlow `BAAI/bge-m3`（1024 维向量）与 `BAAI/bge-reranker-v2-m3`（重排），并明确要求实现「自定义向量模型 + 重排序」配置功能。此即「另行确认」。
- P0 基线（无重排、无向量）保留为对照；本增强提供 BM25 / 混合 / 混合+重排 的消融条件。

## 2. 范围与边界

做：
1. 通用自定义 Embedding 提供商 `custom`：用户配置 OpenAI 兼容 `baseUrl + model + apiKey`，维度固定校验 1024（与 `rag_vec float[1024]` 一致；bge-m3 满足）。
2. 可选重排 stage：用户配置 `baseUrl + model + apiKey + topN`，默认关闭；启用后对 RRF 融合候选有限重排。
3. 设置 API 与前端配置 UI；检索诊断记录实际路径（含 rerank）。
4. 离线确定性测试 + 浏览器验证 + 在线检索消融对照。

不做：
- 不改分块/RRF 常数/召回数量等既有检索策略（重排是融合后的可选附加 stage）。
- 不支持任意维度向量（需改向量表结构，另立任务）；自定义模型必须输出 1024 维，否则明确报错降级。
- 不引入新框架/外部依赖；复用现有 fetch 与 better-sqlite3。
- 不触碰 mobile/、Android、受保护运行数据；不提交密钥。
- 重排不做成「面向读者的技术模式开关」式默认开启；默认关闭，作为配置能力与消融条件。

## 3. 设计

### 3.1 自定义 Embedding（embedding.js）

- `VALID_CHOICES` 增加 `custom`。
- 设置：`user_settings.embedding_custom = {baseUrl, model}`；Key 存 `api_keys.provider='custom-embed'`；env 兜底 `CUSTOM_EMBED_BASE_URL/CUSTOM_EMBED_MODEL/CUSTOM_EMBED_API_KEY`。
- `buildCustomEmbedder(userId)`：baseUrl 补 `/embeddings`，dims=1024，extraBody=null。
- `resolveEmbedder`：`custom` 分支；`auto` 链追加 custom（aliyun → custom → zhipu → siliconflow）。
- `embedTexts` 已有维度校验（≠1024 fatal 报错），复用。
- 查询侧一致性：建库 meta 记录 `embed_provider='custom'` + model；查询按 meta 解析同模型（现有机制）。

### 3.2 重排模块（新增 rerank.js）

```
resolveReranker(userId) -> null | { endpoint, model, apiKey, topN }
  设置 user_settings.rerank = { enabled, baseUrl, model, topN }
  Key api_keys.provider='rerank'；env 兜底 RERANK_BASE_URL/RERANK_MODEL/RERANK_API_KEY
  enabled=false 或缺配置 → null

rerankDocuments(reranker, query, documents, { topN, signal, timeoutMs }) -> [{ index, score }]
  POST {endpoint} body { model, query, documents, top_n }
  解析 results[].index/relevance_score；校验 index 范围与数量；按 score 降序
  失败抛错（由调用方降级）
```

### 3.3 检索集成（rag.js）

- 新增 `retrieveDetailed(userId, bookId, query, topK, opts)` → `{ hits, diagnostics }`：
  1. 现有 BM25 + 向量双路召回 → RRF 融合（不变）。
  2. 若 `resolveReranker` 可用且 enabled：取融合候选前 `rerankTopN`（默认 10，上限 20）送重排，按重排分数取 topK；`diagnostics.paths` 追加 `{method:'rerank', status:'ok'}`，hits 标 `method:'hybrid+rerank'`/`'bm25+rerank'`。
  3. 重排失败：保留 RRF 原序，`diagnostics.warnings` 记 `RERANK_FAILED`，不阻断检索（符合方案）。
  4. `diagnostics` 含本次实际路径（bm25/vector/hybrid/rerank）、耗时、降级原因。
- `retrieveAsync` 保持返回数组（兼容现有调用方），内部走 `retrieveDetailed`。
- `tools/search-in-book.js`：来源标签改用本次实际路径（含 rerank），不再仅按建库 mode 推断（顺带修正已知标签失真）。

### 3.4 设置 API（server.js）

- 扩展 `GET/PUT /api/embedding-settings`：返回/接收 `custom:{baseUrl,model,hasKey,maskedKey}`。
- 新增 `GET/PUT /api/rerank-settings`：`{enabled, baseUrl, model, topN, hasKey, maskedKey, active}`；PUT 可选 `rerankApiKey`（先实际调一次重排校验）。
- `DELETE /api/rerank-settings/key`：删除重排 Key。
- 鉴权沿用 authMiddleware；Key 加密存储沿用现有 encrypt；日志不打印 Key。

### 3.5 前端（public/index.html + app.js）

- Embedding 提供商下拉新增「自定义（OpenAI 兼容端点）」；选中显示 baseUrl/model/key 表单（复用阿里云表单样式）。
- 新增「重排序（Rerank）」设置卡：启用开关 + baseUrl/model/topN/key + 保存/删除 Key；显示当前生效状态。
- 安全：所有模型返回字段安全渲染（沿用 escapeHtml/固定枚举）。

## 4. 验收

| 编号 | 场景 | 标准 |
| --- | --- | --- |
| ER-01 | 自定义 Embedding 建库 | bge-m3/fake 1024 维建库 mode=embedding+bm25；非 1024 维明确报错降级 |
| ER-02 | 重排生效 | 启用后检索 diagnostics 含 rerank ok，候选按重排分数排序 |
| ER-03 | 重排失败降级 | 重排服务错误时保留 RRF 原序 + warning，检索不中断 |
| ER-04 | 重排关闭 | 默认/关闭时不调用重排，路径无 rerank（消融条件） |
| ER-05 | 配置隔离 | 重排/自定义 Embedding 配置按用户隔离；Key 不入日志 |
| ER-06 | 浏览器 | 配置 UI 可保存/生效；检索来源标签反映 rerank |
| ER-07 | 在线消融 | BM25 vs 混合 vs 混合+重排 的 Hit@5/Recall@5/MRR@5/延迟有原始记录 |

## 5. 拟改文件

`embedding.js`、`rag.js`、`server.js`、`tools/search-in-book.js`、`public/index.html`、`public/app.js`；新增 `rerank.js`、`tests/rerank.api.test.js`、`scripts/run-retrieval-ablation.js`（或扩展 run-baseline）。`database.js` 无需改表（复用 user_settings + api_keys）。