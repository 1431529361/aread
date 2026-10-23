# Agent / RAG / Memory 优化任务清单

> 来源：2026-10-23 对现有 Web 版（Express + better-sqlite3）的代码审查
> 适用范围：Android 本地优先重写（`mobile/`）。Web 版只执行 S-1 安全修复，不做结构性改造。
> 阅读顺序：先看第 1 节总览，再按 P0 顺序执行。

## 0. 执行原则

- 优化直接落进 `mobile/`，不回头重构 Express 版。
- 每项任务必须满足“可引用、可评测、可降级”三个标准。
- 每项任务有独立验收标准，未达标不算完成。
- 不引入图数据库、不引入服务端、不改变纯本地定位。
- 每完成一项，更新本文件的复选框并提交一个独立 commit。

## 1. 任务总览

| ID | 任务 | 目标模块 | 预估 | 依赖 | 对应里程碑 |
|---|---|---|---|---|---|
| S-1 | Web 安全修复：密钥日志、AES-GCM | `server.js` | 0.5 天 | 无 | 立即 |
| P0-1 | 预检索 + 修正提示词矛盾 | agent/core | 0.5~1 天 | P0-3 的检索接口 | M0 |
| P0-2 | 统一 locator + 可跳转引用 | db/reader/agent | 1.5~2 天 | 无（schema 先定） | M0~M1 |
| P0-3 | FTS5 + 按书分区向量 | db/retrieval | 3~4 天 | 无 | M0/M2 |
| P0-4 | Memory v2：写入合并 + 相关性门控 | memory/UI | 3~4 天 | P0-2、P0-3 | M2 |
| P1-1 | 追问查询改写 | retrieval | 1 天 | P0-3 | M2 |
| P1-2 | small-to-big 父子块 | retrieval | 1~2 天 | P0-3 | M2 |
| P1-3 | 检索重排（rerank） | retrieval | 1~2 天 | P0-3 | M3 |
| P1-4 | Agent 工具扩展 + 并行调用 | agent/tools | 2 天 | P0-1 | M1~M2 |
| P1-5 | 全书分层 map-reduce | orchestrator | 3 天 | P0-3 | M3 |
| P1-6 | 黄金测试集 + 评测脚本 | test | 2 天 | P0-2/P0-3 | M3 |
| P2-1 | 人物/主题图谱（GraphRAG） | 预计算 | 评估后 | P1-6 | v2 |
| P2-2 | Procedural memory / 提示词优化 | memory | 2 天 | P0-4 | v2 |
| P2-3 | Agent trace 持久化与回放 | agent | 1 天 | P0-1 | v2 |

## 2. P0 任务详情

### S-1 Web 安全修复（先做，和移动端无关）

**问题**
- 日志打印 API Key 前缀：`server.js` 中多处 `console.log`（约 793 行）。
- 密钥使用 AES-256-CBC，无完整性校验，存在密文篡改风险（`server.js:56`）。

**步骤**
- [ ] 全局搜索 `console.log`，删除所有包含 `apiKey`、`maskedKey`、解密结果的输出；只保留 `provider`、状态码、脱敏后的后四位。
- [ ] 新增 `encryptV2`：AES-256-GCM，密文格式 `v2:<iv>:<tag>:<ciphertext>`。
- [ ] `decrypt` 同时支持 `v1`（CBC）和 `v2`（GCM）；v1 解密成功后立即用 v2 重新加密并写回。
- [ ] 新增单测：加解密往返、篡改任意字节必须抛错、空值输入。
- [ ] 确认错误日志不包含明文或密文。

**验收**
- 日志中不再出现任何密钥片段。
- 篡改密文无法解密，且不会回退到错误结果。
- 现有已存密钥在升级后可正常使用。

---

### P0-1 预检索 + 修正提示词矛盾

**问题**
- Agent 完全依赖模型决定是否调用工具，弱模型容易不查直接编。
- 系统提示词写着“翻译、总结、解释、改写等任务直接回答，绝对不要调用工具”（`server.js:1114`），导致“总结第三章”这类问题不读原文。
- 工具参数解析失败时静默返回 `{}`（`agent.js:17`）。
- 工具结果按字符串截断，可能产生非法 JSON（`agent.js:156`）。

**步骤**
- [ ] 在 ReAct 循环开始前执行一次预检索：用用户问题（含最近 2 轮上下文）检索 Top-5，生成证据块。
- [ ] 证据块结构固定：`[C1] 书名/章节 | locator | 原文片段`，总长度不超过 3000 字符。
- [ ] 把证据块作为独立消息注入（不要拼进稳定 system 前缀），并在 trace 中记录 `pre_retrieval` 事件。
- [ ] 修正系统提示词：
  - 涉及书籍具体内容（总结章节、人物、情节、原文）时，必须先检索或读取原文。
  - 翻译、改写用户选中的文本可以直接回答。
  - 不允许凭模型记忆补充书中不存在的细节。
- [ ] 参数解析失败时返回 `{ error: 'invalid_arguments', detail: ... }` 给模型，而不是 `{}`。
- [ ] 工具结果按字段截断（数组条数、单条长度），保证 JSON 合法。
- [ ] 最终答案允许带 `[C1]` 引用；后处理校验引用 ID 是否存在，不存在则删除该标记并记录日志。

**验收**
- 对“总结第三章”类问题，回答引用第三章原文，且引用可跳转。
- 对“把这句话翻译成英文”类问题，不触发工具调用。
- 使用一个 function calling 能力较弱的模型，仍能基于预检索证据给出有依据的回答。
- 工具参数错误后，模型能在下一轮自行纠正。

**测试**
- 单测：证据块构造、引用解析与校验。
- 集成：选一本 3 章以上的书，覆盖“总结/人物/原文定位/翻译”四类问题。

---

### P0-2 统一 locator + 可跳转引用

**问题**
- `rag_chunks` 只有 chapter 和 text（`database.js:179`），无法定位到原文。
- 划线和引用没有统一的定位标准，长书会漂移。

**数据结构**
- TXT：`{ kind: 'txt', start, end }`，相对归一化后的全文。
- EPUB：`{ kind: 'epub', href, start, end }`，相对该 spine 文档解码后的文本。
- `rag_chunks` 增加 `loc_kind`、`loc_href`、`loc_start`、`loc_end`。
- `highlights` 使用同一套字段。
- 检索结果返回引用对象：

```json
{
  "id": "c_123",
  "bookId": "b_1",
  "chapter": "第三章",
  "loc": { "kind": "txt", "start": 12345, "end": 12900 },
  "text": "原文片段..."
}
```

**步骤**
- [x] 定义 locator 类型与序列化格式，写进 `src/core/types.ts`。
- [x] TXT 导入：统一换行符后建立全文，分块时记录每块的起止 offset。
- [ ] EPUB 导入：按 spine 解析每个文档，记录 `href` 与文档内 offset；跨文档的块禁止合并。
  - 已完成纯逻辑分块 `src/core/rag/epubChunks.ts`（逐文档分块、禁止合并）；spine 解析待 M1。
- [x] 分块函数返回 `{ text, chapter, loc }`，入库时写入 locator。
  - 以 `loc_kind/loc_href/loc_start/loc_end` 平铺字段入库，通过 `src/reader/locator.ts` 统一转换。
- [ ] 检索结果携带 locator，Agent 工具结果携带 locator。
- [ ] 阅读器提供 `openAtLocator(bookId, loc)`：TXT 按 offset 滚动，EPUB 按 href + offset 映射 DOM Range。
- [ ] 划线、批注、引用卡片全部走 `openAtLocator`。
- [x] 引用校验：答案中的 `[Cn]` 必须能映射到真实 chunk，否则视为无效引用。
  - `src/core/citation.ts`：`parseCitationIds` / `sanitizeCitations`。

**验收**
- TXT 和 EPUB 各选 5 条引用，点击后都能跳到正确段落并高亮。
- 改变字号、行距、分页后，再次点击同一引用仍能定位。
- 跨章节引用不会跳到章节开头。
- 删除书籍后，相关引用点击时给出明确提示，不崩溃。

**测试数据**
- `fixtures/txt/short-utf8.txt`
- `fixtures/txt/long-gbk.txt`（30 万字以上）
- `fixtures/epub/with-images.epub`
- `fixtures/epub/drm.epub`（应被拒绝）

---

### P0-3 FTS5 + 按书分区向量

**问题**
- BM25 是内存索引，冷查询时重建整本书，缓存仅 5 本（`rag.js:144`）。
- 向量检索先全局 KNN 再按书过滤（`rag.js:285`），多书时结果可能不足 K 条。
- 索引失败会清空已写入向量并整体降级（`rag.js:239`）。
- 索引没有状态，无法断点续跑。

**数据库**
- `rag_fts(chunk_id UNINDEXED, book_id UNINDEXED, tokens)`，FTS5。
- `rag_vectors(chunk_id PRIMARY KEY, book_id, model, dims, vector BLOB)`，`book_id` 建索引。
- `index_jobs(book_id PRIMARY KEY, stage, cursor, error, updated_at)`。

**步骤**
- [ ] Spike：在真机验证 op-sqlite 的 FTS5 可用（`CREATE VIRTUAL TABLE` + `MATCH`），记录 SQLite 版本。
- [x] 复用 `tokenize()`（单字 + bigram），入库时写入空格分隔的 tokens。
- [x] 查询构造器：token 之间用 OR，转义双引号、`*`、`-` 等 FTS 特殊字符，使用参数绑定。
- [x] 用 FTS5 `bm25()` 排序替代内存 `BM25Index`，删除缓存逻辑。
- [x] 向量写入前归一化，float32 BLOB；检索用点积。
- [x] 单书检索：FTS Top-20 + 该书向量 Top-20 → RRF Top-5。
- [x] 书库检索：FTS Top-200 → 按书分组加载候选向量 → 精排 → RRF。
- [x] 索引状态机：`pending → chunking → lexical_ready → embedding → ready/partial`。
- [x] 每批 10 条 embedding，失败块单独标记；重试只补失败块；应用被杀后从 `index_jobs` 恢复。
  - 失败块以“缺少当前 sig 向量”表示；续跑走 `indexBook({ mode: 'embedding' })`。启动时自动调用待 M0-B 接线。
- [x] 换 embedding 模型时写入新 model 版本，旧向量保留至该书重建完成。
  - migration v2 将 `rag_vectors` 主键改为 `(chunk_id, embed_sig)`，新旧向量可并存；成功后才清理旧 sig。
- [x] 在 `lexical_ready` 状态即可阅读和 BM25 检索。

**性能目标（中端真机）**
- 单书检索 p95 < 100ms（约 750 块）。
- 书库检索 p95 < 300ms（100 本书）。
- 30 万字书索引 1~2 分钟。
- 单次查询内存增量 < 20MB。

**验收**
- 2 字中文词可检索（如“自由”“爱情”）。
- 查询计划显示先按 `book_id` 过滤，不做全表向量扫描。
- 索引中途杀进程，重启后从断点继续，已完成部分不重复计费。
- embedding 部分失败时，已成功部分可用于检索，状态显示 partial。

**风险**
- op-sqlite 若未内置 FTS5：退化为 SQLite 倒排表 + JS BM25（持久化 tf/df），不要退回内存重建。
- FTS5 查询语法错误会导致整次检索失败：必须先单测转义逻辑。

> 当前状态（2026-10-23）：`mobile/src/services/indexing.ts`、`retrieval.ts`、`db/repositories/{chunks,vectors}.ts`、`core/embedding/client.ts` 已完成；113 项单测覆盖 FTS 检索、按书分区、RRF、partial 续跑与换模型回滚。真机 FTS5 spike、性能目标与 FTS5 不可用回退方案仍待 M0-B 验证。

---

### P0-4 Memory v2：写入合并 + 相关性门控

**问题**
- 每轮回答后都抽一次记忆（`server.js:929`、`server.js:1167`），成本和噪声都高。
- 只按内容精确去重（`conversation.js:293`），语义重复多。
- 没有冲突处理，偏好变化后新旧并存。
- 检索时偏好类固定加 0.5 分（`conversation.js:373`），导致无关问题也注入记忆。
- 没有分层、没有来源、没有时效、没有编辑。

**数据模型**
```sql
ALTER TABLE user_memories ADD COLUMN layer TEXT;        -- profile | episodic | procedural
ALTER TABLE user_memories ADD COLUMN status TEXT DEFAULT 'active'; -- active | superseded
ALTER TABLE user_memories ADD COLUMN embedding BLOB;
ALTER TABLE user_memories ADD COLUMN source_message_id INTEGER;
ALTER TABLE user_memories ADD COLUMN valid_from TEXT;
ALTER TABLE user_memories ADD COLUMN superseded_by INTEGER;
ALTER TABLE user_memories ADD COLUMN last_used_at TEXT;
ALTER TABLE user_memories ADD COLUMN use_count INTEGER DEFAULT 0;
```

**写入管线**
- [ ] 触发时机改为：会话空闲 5 分钟，或每 10 轮用户消息；不再每轮触发。
- [ ] 抽取输出 JSON：`{ op, layer, content, evidence, confidence, salience }`。
- [ ] 对每条候选，先召回最相似的 5 条已有记忆（有 embedding 用余弦，无则用 token 重叠）。
- [ ] 让 LLM 判定 `ADD / UPDATE / SUPERSEDE / NOOP`，并给出目标记忆 ID。
- [ ] 执行合并：UPDATE 覆盖内容并保留来源；SUPERSEDE 把旧记忆标记 `status='superseded'` 并写 `superseded_by`。
- [ ] 记录 `source_conv`、`source_message_id`、`valid_from`。
- [ ] 容量上限 200，淘汰按 `salience × 新近度 × use_count`，不只看 salience。
- [ ] 记忆写入失败不影响对话主流程。

**读取管线**
- [ ] `profile` 层常驻注入，最多 8 条、总长 300 字。
- [ ] `episodic` 层按相关性检索，设阈值，低于阈值不注入。
- [ ] `procedural` 层只在生成笔记/人物分析等任务时注入。
- [ ] 注入格式分节，并加明确指令：“仅在确实相关时使用，不要主动提及记忆本身”。
- [ ] 记录本次注入了哪些记忆（`last_used_at`、`use_count`），便于后续评估。

**阅读场景字段**
- 阅读偏好：类型、作者、难度、节奏。
- 阅读经历：读完/弃读、完成时间、高亮主题。
- 互动偏好：答案长度、是否分点、是否要求引用原文。

**界面**
- [ ] 设置页记忆面板：按 profile / episodic / procedural 分组。
- [ ] 每条显示内容、来源会话、创建时间、状态；支持编辑、置顶、删除。
- [ ] 支持按类别关闭、全部清除、按书禁用。

**后台整理**
- [ ] 会话结束时合并重复、失效旧事实、把长事件压缩为一句。
- [ ] 整理任务可重入，失败不影响主流程。

**验收**
- 同一偏好重复出现不会产生两条 active 记录。
- 偏好变化后，旧记录变为 superseded，不再注入。
- 与记忆无关的问题不会注入 episodic 记忆。
- 用户能看到、编辑、删除每条记忆及其来源。
- 正常对话每轮不再额外产生一次记忆抽取调用。

**测试场景（至少 20 条）**
- 重复偏好、偏好反转、临时兴趣、一次性问题、书籍剧情（不应入库）、跨会话复用、按书禁用、无 Key 降级。

---

## 3. P1 任务（做完 P0 再排期）

### P1-1 追问查询改写
- 用最近 3 轮对话把“他为什么离开”改写成独立问题，再检索。
- 单测覆盖指代、省略、指代跨书等场景。
- 验收：多轮追问的检索命中率明显高于直接检索原句。

### P1-2 small-to-big 父子块
- 子块 300~500 字用于检索，父块 1500~2000 字用于生成。
- 命中子块后向上合并相邻块，去重后按 token 预算截断。
- 验收：答案完整度提升，引用仍指向子块位置。

### P1-3 检索重排
- 召回 Top-20 后接 bge-reranker 或同类 API，精排到 Top-5。
- 失败或无 Key 时自动跳过重排，不影响主流程。
- 验收：黄金集上的引用准确率提升；p95 延迟增加 < 500ms。

### P1-4 Agent 工具扩展 + 并行调用
- 新增工具：`getSurroundingText`、`listChapters`、`getChapter`、`searchNotes`、`searchLibrary`、`getReadingHistory`。
- 同一轮多个 tool_calls 并行执行，并发上限 3。
- 客户端断开时通过 AbortController 取消上游请求。
- 验收：工具调用轮次下降；长问题端到端延迟下降。

### P1-5 全书分层 map-reduce
- 修复现有问题：只取前 8 章、每章前 2000 字（`orchestrator.js:95`、`orchestrator.js:147`）。
- 章节摘要按 chapter hash 缓存，支持增量重跑。
- 人物分析改为全量提及索引 + 聚合，而不是首次出现附近 600 字（`orchestrator.js:270`）。
- 使用结构化输出与失败重试；节点失败保留错误信息。
- 验收：长书笔记覆盖全部章节；人物分析引用全部主要出场片段。

### P1-6 黄金测试集 + 评测脚本
- 3 本书 × 10 个问题，覆盖事实、人物、跨章节、追问、拒答。
- 指标：Recall@5、引用准确率、答案忠实度、p95 延迟、索引成功率。
- 验收：每次改动 P0/P1 后自动跑一遍，输出对比报告。

## 4. P2 备选（v2 再考虑）

- P2-1 人物/主题图谱：离线预计算实体关系，仅用于“人物关系”“主题脉络”类问题；不在移动端实时建图。
- P2-2 Procedural memory：按任务类型学习用户偏好的输出结构，需先有 P1-6 的评测。
- P2-3 Agent trace 持久化：本地 `agent_runs` 表，支持回放和问题定位；默认关闭，用户可导出。

## 5. 与移动端里程碑的对应关系

| 里程碑 | 必须完成 |
|---|---|
| M0 | P0-2 的 schema 与 TXT locator、P0-3 的 FTS5、P0-1 预检索 |
| M1 | P0-2 的 EPUB locator 与引用跳转、P1-4 基础工具 |
| M2 | P0-3 的向量分区与状态机、P0-4 Memory v2、P1-1 查询改写 |
| M3 | P1-2、P1-3、P1-5、P1-6 |

## 6. 统一的验收门槛

- 引用准确率 ≥ 95%（黄金集）。
- 检索 Recall@5 ≥ 85%。
- 索引成功率 ≥ 99%（允许 partial）。
- 记忆重复率 < 5%，错误注入率 < 5%。
- 单书检索 p95 < 100ms，书库检索 p95 < 300ms。
- 日志零密钥泄露。

## 7. 明确不做

- 不在 Web 版做结构性重构（只做 S-1）。
- 不迁移 Web 版数据到 App。
- 不引入 Neo4j、Milvus、Qdrant 等服务端组件。
- 不在 v1 做 GraphRAG 实时建图。
- 不引入 LangGraph / OpenAI Agents SDK，保持现有轻量循环，只补状态与可观测性。
- 不为“更主流”而更换数据库；SQLite + FTS5 + 本地向量足够支撑 v1。

## 8. 待确认

- 重排服务选型：复用用户已有 Provider，还是单独要求配置 Rerank Key。
- 记忆抽取的模型：沿用对话模型，还是允许单独配置便宜模型。
- 评测集由谁维护：开发阶段先用内部样书，发布前再补真实用户问题。
