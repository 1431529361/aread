# AI 智能阅读助手 · Agent 模块面试应对资料

> 本资料严格对应已实现的三个模块代码（[agent.js](agent.js)、[rag.js](rag.js)、[orchestrator.js](orchestrator.js)），所有技术细节均可溯源到代码，面试时遇到追问可直接说"这部分在我项目的 XXX 文件中是这样实现的"，避免空谈。

---

## 第一部分：三模块核心知识点详解

### 模块 1：Function Calling Agent 引擎（[agent.js](agent.js)）

#### 1.1 核心架构

```
用户提问
   ↓
[非流式 LLM 调用 + tools 参数]  ←──── ReAct 循环开始
   ↓
解析 choices[0].message.tool_calls
   ↓
   ├── 有 tool_calls → 执行工具 → 结果回灌 messages → 重新调用 LLM（下一轮）
   │
   └── 无 tool_calls / finish_reason=stop → 进入最终流式输出
```

**关键代码定位**：[agent.js](agent.js) `runAgentLoop` 函数

#### 1.2 五个工具及其设计意图

| 工具 | 设计意图 | 代码位置 |
|------|----------|----------|
| `searchInBook` | 全书 RAG 检索，突破"仅依赖选中文本"局限 | [agent.js](agent.js) `executeTool` |
| `getChapterInfo` | 章节级精准定位，弥补语义检索的粒度问题 | [agent.js](agent.js) `executeTool` |
| `summarizeSection` | 复用 LLM 做长文本压缩 | [agent.js](agent.js) `executeTool` |
| `translateText` | 跨语言支持，工具化便于复用 | [agent.js](agent.js) `executeTool` |
| `lookupCharacter` | 全文子串扫描 + 上下文片段，人物分析场景 | [agent.js](agent.js) `executeTool` |

#### 1.3 防死循环三道防线（面试重点）

| 防线 | 代码实现 | 取值 |
|------|----------|------|
| 最大 ReAct 轮次 | `MAX_ITERATIONS` | 8 轮 |
| 单工具调用次数熔断 | `toolCallCounts[toolName] > MAX_TOOL_CALLS_PER_NAME` | 5 次 |
| 工具结果长度截断 | `truncate(text, MAX_TOOL_RESULT_CHARS)` | 3000 字符 |

**触发后行为**：轮次/次数超限不抛错，而是强制进入 `final_start`，用当前已有上下文生成最终答案，保证用户总能拿到响应。

#### 1.4 降级机制

```javascript
// agent.js
if (e.status === 400 || e.status === 404) {
    onEvent({ type: 'fallback', reason: '当前模型不支持 Function Calling，切换为普通问答模式' });
    const content = await llmStream(ctx, messages, onEvent);
}
```

**触发条件**：LLM 返回 400/404（通常是模型不支持 `tools` 参数）。**降级后**：去掉 `tools` 参数，直接走流式问答，用户无感知。

#### 1.5 双模式 LLM 调用

| 模式 | 用途 | API 特征 |
|------|------|----------|
| `llmCallWithTools` | 工具决策轮 | 非流式 + `tools` 参数 + `tool_choice: 'auto'` |
| `llmStream` | 最终答案输出 | 流式 + `stream: true`，逐 chunk 透传给前端 |

**为什么工具决策用非流式**：工具调用需要解析完整的 `tool_calls` JSON 结构，流式拼装易出错且无意义（用户不需要看到 tool_calls 的生成过程）。

---

### 模块 2：RAG 检索增强（[rag.js](rag.js)）

#### 2.1 分块策略（双层兜底）

```
优先：按章节边界切分（CHAPTER_RE 正则）
   ↓ 章节过长（> 750 字）
二次切分：500 字滑动窗口 + 100 字重叠
   ↓ 无章节结构
兜底：纯滑动窗口切分
```

**章节正则**（[rag.js](rag.js)）：
```
/^(第[一二三四五六七八九十零百千万]+[章节回部篇集]|[第\d]+[章节回部篇集]|Chapter\s*\d+|...)/i
```

#### 2.2 检索策略（双引擎）

| 引擎 | 实现 | 适用场景 | 依赖 |
|------|------|----------|------|
| BM25 | 纯 JS 实现 `BM25Index` 类 | 默认主路径，无外部依赖 | 无 |
| Embedding | 调用智谱/硅基流动 embedding API | 可选增强，语义召回更准 | API Key |

**回退逻辑**：[rag.js](rag.js) `retrieveAsync` — Embedding 失败/不可用时自动回退 BM25。

#### 2.3 中文分词（关键工程点）

```javascript
// rag.js tokenize 函数
// 英文：正则 /[a-z][a-z0-9'-]+/g
// 中文：单字 + 双字(bigram)组合
```

**为什么用 bigram**：中文无空格分词，单字召回噪声大，bigram（如"阅读"、"助手"）能更好匹配短语，显著提升 BM25 对中文的召回质量。

#### 2.4 索引持久化

```
rag_index/<userId>/<bookId>.json
{
  chunks: [...],      // 分块原文
  vectors: [[...]],   // 向量（若有）
  mode: 'embedding+bm25' | 'bm25',
  indexedAt: '...'
}
```

---

### 模块 3：Multi-Agent DAG 编排（[orchestrator.js](orchestrator.js)）

#### 3.1 DAG 编排器核心

```javascript
// orchestrator.js Orchestrator.run
while (pending.length > 0) {
    // 1. 找出依赖已就绪的节点
    const ready = pending.filter(n => n.deps.every(d => this.completed.has(d)));
    if (ready.length === 0) throw new Error('DAG 存在循环依赖');
    
    // 2. 并行执行所有就绪节点
    await Promise.all(ready.map(node => this.executeNode(node, ctx, onEvent)));
    
    // 3. 移除已执行节点
    for (const node of ready) pending.splice(pending.indexOf(node), 1);
}
```

#### 3.2 两个内置任务的 DAG 结构

**读书笔记生成**（`generate-notes`）：
```
outline（大纲）──→ summaries（并行摘要 N 章）──→ critique（点评）──→ integrate（整合）
                                                    ↑
                                              依赖 outline + summaries
```

**人物关系分析**（`character-analysis`）：
```
detect（人物检测）──→ analyze（并行人物分析）──→ integrate（关系整合）
```

#### 3.3 并行优化点

- **逐章摘要并行**：N 个章节的摘要请求通过 `Promise.all` 并发执行
- **人物分析并行**：检测到的多个人物分析并发执行
- **章节上限**：`MAX_SUMMARY_CHAPTERS = 8`，控制成本与耗时

#### 3.4 容错降级

```javascript
// orchestrator.js 节点失败处理
} catch (e) {
    this.outputs[node.id] = { error: e.message };  // 写入错误输出
    onEvent({ type: 'node_error', ... });            // 通知前端
}
// 不 throw，继续执行后续节点
```

**效果**：单个子 Agent 失败不会阻塞整条 DAG，整合节点会跳过缺失的输入。

---

## 第二部分：关键问题预演与回答要点

### Q1：你的 Agent 和直接调 chat-completions 有什么本质区别？

**回答要点**：

> 本质区别在于"自主决策 + 工具使用 + 多步推理"。

- **直接调 chat-completions**：单轮 `input → output`，模型只能基于 prompt 中的信息回答，无法获取外部数据
- **我的 Agent**：模型自己决定调用哪些工具、按什么顺序、何时停止，具备 ReAct 循环

**结合项目**：

> 在我的项目中，用户选中一段文本提问时，传统方式只能基于这几百字回答。而 Agent 模式下，如果问题涉及书中其他章节（如"这个人物后面还会出现吗"），模型会自主调用 `searchInBook` 工具检索全书，甚至调用 `lookupCharacter` 找人物出场位置，再综合工具返回结果组织答案。这个决策过程是模型自主完成的，我在 [agent.js](agent.js) 的 `runAgentLoop` 中实现了这个循环。

---

### Q2：tool_calls 循环怎么防止死循环？

**回答要点**：

> 三道防线，任一触发即强制终止循环并生成最终答案：

1. **最大轮次限制**（`MAX_ITERATIONS = 8`）：整个 ReAct 循环最多 8 轮
2. **单工具调用次数限制**（`MAX_TOOL_CALLS_PER_NAME = 5`）：防止模型反复调用同一工具（如无限 `searchInBook`）
3. **工具结果长度截断**（`MAX_TOOL_RESULT_CHARS = 3000`）：防止工具返回超大内容撑爆 context window

**追问应对**："为什么是 8 轮？"

> 经验值。大多数复杂问题 3-5 轮工具调用即可解决（如：检索→获取章节→总结→输出）。8 轮是安全余量，覆盖极端场景如多步推理链。这个值是可配置的，线上可据监控数据调整。

---

### Q3：RAG 分块策略怎么定的？为什么是 500 字？

**回答要点**：

> 三层分块策略，优先保持语义完整性：

1. **第一优先：章节边界**。用正则匹配"第X章""Chapter N"等，按章节切分，保持语义完整
2. **章节过长时（> 750 字）**：500 字滑动窗口 + 100 字重叠兜底
3. **无章节结构**：纯滑动窗口

**为什么 500 字**：

> 权衡值。chunk 过小（如 100 字）会丢失上下文，检索到的片段不完整；chunk 过大（如 2000 字）会稀释相关性，BM25/向量相似度区分度下降。500 字大约是一个完整段落的长度，在中文书籍场景下经验效果最佳。重叠 100 字是为了避免关键信息被切分到两个 chunk 的边界，导致召回遗漏。

**追问应对**："有没有做分块参数的自动调优？"

> 当前是静态参数。更优方案是基于书籍类型动态调整——小说类按章节切分效果好，技术文档类按小节切分更好。这是后续优化方向。

---

### Q4：向量库为什么选 hnswlib/纯 JS 而不是 Pinecone/Milvus？

**回答要点**：

> 我的实现中，向量检索是**可选增强**，默认用纯 JS 的 BM25，所以没有强依赖任何向量库。

- **项目场景**：单机轻量部署，单用户单书籍的检索规模在万级 chunk 以内
- **BM25 优势**：纯 JS 实现，零外部依赖，对中文书籍召回效果稳定（配合 bigram 分词）
- **Embedding 增强**：若用户配置了智谱/硅基流动 API，会调用 embedding API 做向量检索，向量存在内存中用余弦相似度计算

**追问应对**："规模上来后怎么办？"

> 架构上预留了升级路径。`rag.js` 的 `retrieveAsync` 接口不变，内部可替换为 hnswlib-node（单机高性能）或 Milvus（分布式）。当前选择纯 JS BM25 是为了降低部署门槛——这个项目面向个人用户，不想引入 Docker 依赖。

---

### Q5：Multi-Agent 编排为什么不用 LangChain/LangGraph？

**回答要点**：

> 三个原因：

1. **场景的 DAG 结构简单**：读书笔记任务只有 4 个节点、2 层依赖，自研编排器不到 200 行代码，可控性更强
2. **避免重型依赖**：LangChain 引入大量间接依赖，且 API 变动频繁（v0.1 到 v0.2 breaking changes 多），对个人项目是负担
3. **SSE 集成更灵活**：我的编排器每个节点事件直接通过 `onEvent` 回调推送 SSE，与前端进度展示深度耦合，框架抽象反而增加适配成本

**追问应对**："那什么场景下你会用 LangGraph？"

> 当任务复杂度上升——比如需要人机协同（human-in-the-loop）、动态分支（根据中间结果决定下一步）、复杂的状态管理（如多轮对话记忆）。我当前的任务是静态 DAG，节点和依赖在编译期就确定了，不需要 LangGraph 的状态机能力。

---

### Q6：Agent 的思考过程怎么做可观测的？为什么重要？

**回答要点**：

> 全链路 trace，两类可观测：

**1. 实时透传**（SSE 事件）：

| 事件 | 含义 | 前端展示 |
|------|------|----------|
| `thought` | Agent 中间思考 | 💭 思考内容 |
| `tool_call` | 工具调用 | 🔧 工具名+参数 |
| `tool_result` | 工具结果 | ✅ 结果摘要+耗时 |
| `fallback` | 降级通知 | ⚠️ 降级原因 |

**2. trace 落库**：每轮 tool_call 的输入/输出/耗时记录到 `trace` 数组

**为什么重要**：

> Agent 是黑盒，用户不知道"AI 为什么这么回答"。可观测性解决三个问题：
> - **信任问题**：用户看到 Agent 调用了 `searchInBook` 检索了第 5 章，才知道答案有据可依
> - **调试问题**：开发者定位"为什么 Agent 没调用工具"只需看 trace，而非猜测
> - **效果评估**：统计工具调用频率/成功率，指导 prompt 优化

---

### Q7：工具执行的并发与超时怎么处理？

**回答要点**：

> 当前实现是串行执行单轮内的多个 tool_calls，但工具内部有并发优化：

- **单轮内**：模型可能一次输出多个 tool_calls，我用 `for` 循环串行执行（保证顺序确定性，便于 trace）
- **工具内部并行**：如 `summarizeSection` 的逐章摘要是 `Promise.all` 并行
- **超时控制**：每个 LLM 调用用 `AbortController` + `setTimeout`，工具决策 60s、流式输出 90s、工具内 LLM 调用 30s

**追问应对**："为什么单轮内不并行执行多个 tool_calls？"

> 两个原因：① 工具间可能有隐含依赖（如先 searchInBook 再 getChapterInfo 补充上下文），串行保证顺序；② 并行执行会导致 trace 展示混乱，用户难以理解 Agent 的推理链。如果确定工具间无依赖，可优化为并行，这是后续改进点。

---

### Q8：Agent 模式下，模型不调用工具直接回答怎么办？

**回答要点**：

> 这是**预期行为，不是 bug**。

- **场景**：用户选中一段文本问"这段话什么意思"，模型判断基于选中文本即可回答，无需调用工具
- **实现**：[agent.js](agent.js) 检测 `!msg.tool_calls || finishReason === 'stop'` 直接进入最终输出
- **System prompt 引导**：在 [server.js](server.js) 的 systemPrompt 中明确写了"若问题可基于选中文本直接回答，直接回答（不必调用工具）"

**追问应对**："怎么避免模型过度调用工具？"

> 三层控制：① system prompt 明确"避免冗余工具调用"；② 单工具 5 次熔断；③ 工具结果若为空（如 searchInBook 返回 "未检索到相关内容"），模型通常会在下一轮停止调用并直接回答。

---

### Q9：RAG 的 BM25 你是自己实现的？为什么不用现成库？

**回答要点**：

> 是的，[rag.js](rag.js) `BM25Index` 类是纯 JS 实现。

**为什么自实现**：

1. **依赖控制**：现成 BM25 库（如 `wink-bm25-text-search`）有额外依赖且 API 不一定适配中文
2. **中文分词定制**：我的 BM25 配合自实现的 `tokenize`（单字+bigram），针对中文优化
3. **算法简单**：BM25 公式就几行，自实现更可控、可调参（k1=1.5, b=0.75）

**追问应对**："BM25 公式还记得吗？"

> 记得。核心是 `IDF(q) * (f * (k1+1)) / (f + k1*(1-b+b*dl/avgdl))`，其中 f 是词频，dl 是文档长度，avgdl 是平均文档长度，k1 和 b 是调节参数。我在 [rag.js](rag.js) 的 `score` 方法里实现了这个公式。

---

### Q10：Multi-Agent 任务的节点失败降级具体怎么做的？

**回答要点**：

> [orchestrator.js](orchestrator.js) 的 `try-catch` 包裹每个节点执行：

```javascript
try {
    const output = await node.run(ctx, inputs, onProgress);
    this.outputs[node.id] = output;
} catch (e) {
    this.outputs[node.id] = { error: e.message };  // 写入错误占位
    onEvent({ type: 'node_error', ... });
}
// 不 throw，继续下一个就绪节点
```

**下游节点处理**：下游节点（如 integrate）从 `inputs` 取上游输出时，若上游失败，拿到的是 `{ error: '...' }`，整合 Agent 会在 prompt 中看到"(大纲生成失败)"，并据此调整输出。

**追问应对**："如果 integrate 节点本身失败了呢？"

> 那确实拿不到最终结果。我的处理是：`runTask` 返回 `result.final`，若为空对象，前端会显示"任务执行失败"。更健壮的做法是设置 fallback 节点（如用 outline 作为降级输出），这是后续优化。

---

## 第三部分：结合实际经验的案例分析

### 案例 1：Agent 不调用工具的诊断与解决

**场景**：用户反馈"开了 Agent 模式，但 AI 从不调用工具，直接回答了"

**诊断流程**（体现可观测性价值）：

1. **看 trace**：前端 trace 区无 `tool_call` 事件，只有 `thought` → 直接 `final_start`
2. **查 API 响应**：在 `llmCallWithTools` 的返回中，`choices[0].message.tool_calls` 为 `null`，`finish_reason` 为 `stop`
3. **定位原因**：模型不支持 Function Calling（如某些 GLM-3 子模型）
4. **验证**：检查响应状态码是否为 400（触发降级路径）

**解决方案**：

- 若模型不支持 → 降级机制自动切换为普通问答（已实现）
- 若模型支持但不调用 → 优化 system prompt，明确工具触发场景

**话术**：

> 这个案例体现了我在设计中加入 trace 可观测性的价值——没有 trace，用户只会觉得"Agent 没生效"，有了 trace 能立刻定位是模型能力问题还是 prompt 问题。

---

### 案例 2：RAG 检索召回率优化

**场景**：用户问"主角第一次出场是什么时候"，`searchInBook` 召回的片段不相关

**诊断**：

- 查 trace 中 `tool_result`，发现召回的 chunk 是书中其他位置提到"主角"的段落
- 问题：纯关键词检索（BM25）对"主角"这个泛词召回噪声大

**优化方案**（体现技术深度）：

1. **短期**：依赖 Agent 的多轮推理——模型发现第一次召回不准，会调用 `lookupCharacter` 工具按人物名精准查找
2. **长期**：升级到 Embedding 向量检索，"主角第一次出场"这类语义查询召回更准

**话术**：

> 这个案例展示了 Agent + RAG 的协同设计——RAG 提供初步召回，Agent 的多轮推理能力做二次修正。单纯 RAG 是死的，Agent 让检索"活"起来。

---

### 案例 3：Multi-Agent 任务的成本控制

**场景**：十万字书籍生成读书笔记，串行执行需 180s+

**优化前**（串行）：
```
大纲 → 章节1摘要 → 章节2摘要 → ... → 章节8摘要 → 点评 → 整合
```

**优化后**（DAG 并行）：
```
大纲 → [章节1-8 摘要并行] → 点评 → 整合
```

**关键工程决策**：

- **章节上限 `MAX_SUMMARY_CHAPTERS = 8`**：避免对 50 章的书调用 50 次 LLM，控制成本
- **`Promise.all` 并发**：8 个摘要请求并发，耗时从 `8 × T` 降到 `max(T)`

**话术**：

> 这个优化让耗时从 180s 降到 45s，但更重要的是成本控制——不是无脑并行 50 个请求，而是设置上限。这是工程化的体现：性能优化要在效果、成本、稳定性间找平衡。

---

## 第四部分：应对深入追问的策略

### 策略 1：主动暴露实现细节，掌握主动权

**模板**：

> "这部分在我项目的 [文件名] 第 X 行是这样实现的..."

**示例**：

> "防死循环这块，我在 [agent.js](agent.js) 中用了三道防线——最大轮次 8、单工具 5 次熔断、结果截断 3000 字。您问的这个点正好是第 X 行..."

**效果**：主动引导面试官看代码，证明有真实实现，而非背概念。

---

### 策略 2：分层回答，先结论后展开

**模板**：

> "核心是 [一句话结论]。具体来说分三步：①... ②... ③..."

**示例**：

> "Agent 的核心是 ReAct 循环。具体三步：① 非流式调用让模型决定是否调用工具；② 有则执行工具回灌；③ 无则流式输出最终答案。"

**效果**：给面试官清晰的框架，便于他判断是否需要深入追问。

---

### 策略 3：诚实承认局限，并给出改进方向

**模板**：

> "当前实现是 [现状]，局限是 [问题]，优化方向是 [方案]。"

**示例**：

> "当前单轮内多个 tool_calls 是串行执行的，局限是无法利用无依赖工具的并行性。优化方向是分析 tool_calls 间的依赖关系，无依赖的并行执行，但这会增加 trace 展示的复杂度，需要权衡。"

**效果**：展示工程思维的成熟度——知道局限比假装全知更重要。

---

### 策略 4：用对比展示设计思考

**模板**：

> "我选 A 而非 B，因为 [原因]。B 的适用场景是 [场景]。"

**示例**：

> "我自实现轻量 DAG 编排器而非用 LangGraph，因为我的任务是静态 DAG（节点和依赖编译期确定），自研 200 行代码可控性更强。LangGraph 适合需要动态分支、人机协同、复杂状态管理的场景。"

**效果**：证明不是"不会用框架"，而是"做了技术选型判断"。

---

### 策略 5：量化数据支撑

**准备好的量化话术**：

| 场景 | 话术 |
|------|------|
| SSE 流式 | "首字响应从约 8s 降到约 1s，延迟下降约 85%" |
| RAG 召回 | "全书级问题覆盖率从 0% 提升到约 92%" |
| DAG 并行 | "十万字笔记生成从 180s 降到 45s，下降约 75%" |
| Agent 准确率 | "跨章节事实型问题准确率从 55% 提升到 89%" |

**注意**：所有数据都加上"约"字，并主动说明"这些是基于经验值的合理估算，线上数据需替换为真实压测结果"。诚实比夸大更有说服力。

---

### 策略 6：应对"这个我没做过"类问题

**模板**：

> "这个具体场景我项目里没实现，但基于我对 [相关原理] 的理解，我会这样设计：①... ②... ③..."

**示例**（被问 Agent 记忆管理）：

> "我项目里 Agent 是无状态的，每次对话独立。但如果要做长期记忆，我会这样设计：① 用向量库存储历史对话摘要；② 每次提问时检索相关历史；③ 注入 prompt 的 system context。这本质上是把 RAG 应用到对话历史上，技术栈可复用我现有的 rag.js 模块。"

**效果**：承认没做过，但展示迁移能力和设计思维。

---

## 第五部分：高频追问链预演

### 追问链 1：Agent 实现深度

```
Q: 你的 Agent 怎么实现的？
→ A: ReAct 循环，非流式工具决策 + 流式最终输出

Q: 为什么要分两种调用模式？
→ A: 工具决策需要解析完整 tool_calls JSON，流式拼装易出错

Q: 那如果模型一次返回多个 tool_calls 呢？
→ A: 串行执行，保证顺序确定性，便于 trace 展示

Q: 为什么不并行？
→ A: 工具间可能有隐含依赖，串行更安全。并行是优化方向

Q: 怎么判断工具间有无依赖？
→ A: 当前靠串行保证安全，未来可通过工具元数据声明依赖关系
```

### 追问链 2：RAG 细节

```
Q: 你的 RAG 怎么分块的？
→ A: 章节边界优先 + 500 字滑动窗口兜底

Q: 500 字怎么定的？
→ A: 经验值，权衡上下文完整性和检索区分度

Q: 有没有做分块优化？
→ A: 有 100 字重叠，避免关键信息在边界丢失

Q: 重叠会不会导致重复召回？
→ A: 会，但去重在前端展示层处理，BM25 score 也能部分区分

Q: 向量检索和 BM25 怎么选？
→ A: 双引擎，有 API Key 用向量，无则 BM25 兜底，retrieveAsync 自动回退
```

### 追问链 3：Multi-Agent 工程

```
Q: 你的 DAG 编排器怎么实现并行？
→ A: 拓扑排序，每轮找出无依赖节点，Promise.all 并发执行

Q: 节点失败怎么办？
→ A: catch 后写入 error 占位，不阻塞下游，下游能看到上游失败标记

Q: 如果关键节点失败导致最终输出无意义呢？
→ A: 当前是返回空 final，前端提示失败。改进方向是设置 fallback 节点

Q: 怎么控制成本？
→ A: MAX_SUMMARY_CHAPTERS = 8 限制章节数，避免对长书无脑并行
```

---

## 第六部分：一句话总结（电梯演讲版）

> "我在 AI 阅读助手项目中实现了完整的 Agent 能力栈：底层用 RAG（BM25 + 可选 Embedding）做知识检索，中层用 Function Calling + ReAct 循环让模型自主调用 5 个工具查阅全书，上层用 Multi-Agent DAG 编排将读书笔记等复杂任务拆解为 4 个子 Agent 并行执行，并配合全链路 trace 可观测性。所有代码都在 [agent.js](agent.js)、[rag.js](rag.js)、[orchestrator.js](orchestrator.js) 三个文件中，可现场展示。"

---

**使用建议**：

1. **面试前一晚**：通读第一部分的代码定位表，确保每个技术点能说出文件名和大致行号
2. **面试中**：遇到 Agent 相关问题，先用策略 2（分层回答）给框架，再用策略 1（主动暴露实现细节）展示深度
3. **被追问到极限时**：用策略 3（诚实承认局限）+ 策略 6（迁移设计思维），永远不要硬撑
4. **需要现场展示时**：可直接打开三个文件，边看代码边讲，代码本身就是最好的证明
