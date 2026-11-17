# P0 测试计划与验收映射

日期：2026-11-14。关联：[P0方案](../web-thesis/web-thesis-p0-plan.md)、[总方案](../web-thesis/web-thesis-plan.md)。

## 1. 离线确定性测试（无付费依赖，P0-02）

命令：`npm test`（= `node --test "tests/**/*.test.js"`）。全部使用 OS 临时数据根 + 本地假模型，不加载真实 `.env`、不继承供应商 Key、不访问外网。

| 文件 | 覆盖 | 对应验收 |
| --- | --- | --- |
| `tests/data-root.test.js` | 默认路径不变、数据根跟随、护栏拒绝仓库根/上级/books/rag_index | P0-01 |
| `tests/isolation.api.test.js` | 临时数据根写入、仓库数据不被修改、默认书只读复制、书籍/会话/记忆跨用户隔离、同名不同书、删书仅清理临时目录 | P0-01 / P0-05 |
| `tests/security.api.test.js` | 成功/失败/密钥校验路径日志不含 Key 全文与前缀；非法记忆 kind 降级；HTML content 存储 | P0-03 / P0-04 |
| `tests/rag.api.test.js` | embedding+bm25/bm25 建库、检索命中、Embedding 失败降级、无索引兜底、KNN 范围微实验、跨用户 RAG 隔离 | P0-05 / P0-09 |
| `tests/conversation.api.test.js` | 流式事件、消息落库一次、Agent 工具循环、不支持工具降级、无 Key 403、未登录 401、断流有界结束 | P0-09 |
| `tests/rerank.api.test.js` | 自定义 Embedding 建库、重排生效/失败降级/关闭消融、配置隔离与 Key 不泄漏、rerankDocuments 排序 | ER-01~05（增强） |

最近一次运行：**37 项全部通过**（见 `docs/baseline/offline-test-output.txt`）。

## 2. 在线基线（显式启动，P0-07）

命令：`npm run test:online -- --env-file <凭据env> --suite all --repeat 3`。
- 凭据 env 至少含 `ZHIPU_API_KEY` 或 `SILICONFLOW_API_KEY`；Embedding 可选 `EMBED_BASE_URL/EMBED_MODEL_NAME/EMBED_API_KEY`，否则复用对话 Key 走预置提供商。
- 运行前打印模型/样本数/用途（不打印密钥）；`--dry-run` 仅展示计划。
- 流程验证（非在线成绩）：`node scripts/run-baseline.js --fake --suite all`，产物明确标注 FAKE。

评测内容：
1. **检索对照**（固定 query=question，Top5，独立于模型选词）：BM25 vs 混合，指标 Hit@5 / Evidence Recall@5 / MRR@5，金标准为本地原文精确子串。
2. **答案基线**（双入口）：normal / agent-hybrid / agent-bm25，记录答案、工具行为、首字时延、总耗时、错误/降级；正确率待人工标注。
3. **记忆脚本**：10 段，确定性断言 + 探针（memory-on vs memory-off 对照，新建会话）；precision/遵从率待人工标注。

产物：`docs/baseline-results/<runId>/`（rag-retrieval.jsonl / rag-answers.jsonl / memory.jsonl / summary.json / report.md）。

## 3. 异常与已知缺陷（P0-09）

| 场景 | 记录方式 | 当前行为 | 处理 |
| --- | --- | --- | --- |
| 无 Key | conversation.api.test.js | 403 needApiKey，不绕过鉴权 | 正常 |
| 无索引 | rag.api.test.js | 检索返回 empty/fulltext 兜底 | 正常 |
| Embedding 失败 | rag.api.test.js | 建库降级 BM25 + embedError | 正常降级 |
| 断流 | conversation.api.test.js | 有界结束并报错，不永久挂起 | **已知缺陷**：部分答案未落库、未区分正常结束/提前断开（P1a 处理） |
| 非法记忆 kind | security.api.test.js + 浏览器 | 安全降级 fact，HTML 不执行 | P0 已修 |
| 密钥日志 | security.api.test.js | 成功/失败均不泄漏 | P0 已修 |

原有缺陷（断流部分结果、任务状态、采样覆盖等）按方案保留为基线失败样本，不在 P0 强制修复；新引入回归无。

## 4. 开发集（P0-06）

- `dev-rag-questions.json`：20 题（两本各 10；fact/paraphrase/cross-chapter/coref/no-answer 各 4）。
- `dev-memory-scripts.json`：10 段（明确偏好/同义重复/偏好更正/一次性要求/书籍引用污染/助手推断/无关问题/跨书作用域/删除/新会话回忆）。
- `scripts/verify-devset.js`：校验 23 条金标准引文全部命中本地原文，记录字符偏移与章节 → `devset-verification.json`。
- `book-metadata.json`：两本书字节/编码/字符数/SHA-256/章节分布。

## 5. 验收状态汇总

| 编号 | 状态 | 说明 |
| --- | --- | --- |
| P0-01 | 通过 | 默认路径不变；隔离写操作全在临时目录；护栏失败即停 |
| P0-02 | 通过 | 31 项离线测试无付费依赖运行 |
| P0-03 | 通过 | 人工 Key 成功/失败路径日志无泄漏（含前缀检查） |
| P0-04 | 通过 | API + 浏览器双重验证；非法 kind 降级、HTML 不执行 |
| P0-05 | 通过 | 跨用户书籍/会话/记忆/RAG 隔离；KNN 微实验复现 |
| P0-06 | 通过 | 20 题+10 脚本，金标准全部校验命中 |
| P0-07 | 通过（开发集初测） | qwen3.8-flash 真实模型；BM25 检索+双入口答案+10段记忆有原始记录与汇总；混合/重排见增强报告；正确率待人工标注 |
| P0-08 | 通过 | 浏览器主流程 8 步 + 控制台/网络检查，见 browser-smoke.md |
| P0-09 | 通过（记录） | 异常场景有记录；断流为已知缺陷保留基线 |
| P0-10 | 通过 | 分支 qoder/web-thesis；无 mobile/ 改动；受保护数据完整；无密钥入版本文件 |