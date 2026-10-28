# Web 毕设共享接口与协作约定

文档版本：SC-1（2026-10-28）。性质：目标接口规范，供阶段实施和AI交接使用；不表示这些接口已经实现，也不是业务代码开工授权。

阅读顺序：[总方案](web-thesis-plan.md) → 本文 → 当阶段实施方案 → 当前代码与阶段报告。P0先按 [P0方案](web-thesis-p0-plan.md) 建立旧版基线，不提前套用新版协议。

本文约束模块间数据与责任，不决定RAG分块参数、记忆抽取提示词、相关性阈值或具体SQL迁移脚本；这些在对应模块详细方案中制定。文中的类型是结构说明，项目仍使用原生JavaScript，不要求迁移TypeScript。

## 1. 不可违反的边界

- 工作分支为 `qoder/web-thesis`；不读取、修改mobile/，不切换或修改Android分支。
- 不删除或用测试覆盖业务data.db、books/、.env、rag_index/；数据库迁移先在隔离副本验证，真实数据操作另行确认。
- 不把Key、Authorization、密文、私人对话或整本测试书写入文档、评测导出、日志或Git。
- 技术栈保留Express、better-sqlite3、sqlite-vec、原生JS和现有模型客户端；本文不是引入框架或外部服务的理由。
- 统一入口不代表每题RAG，也不代表每题增加一次意图分类模型调用。
- 用户/书籍权限由服务端决定；模型、前端、工具参数都不能改变授权范围。
- 书籍证据回答事实，用户记忆调整个性化，两者不能互相替代。

## 2. 当前接口与目标的差异

以下是当前代码事实，后续执行者必须重新核对行号和实现，不能把旧说明当作当前已完成状态。

| 当前事实 | 证据 | 目标约定 |
| --- | --- | --- |
| 两种问答入口，前端分别请求ask-stream与agent/stream | `public/app.js:933-941,1039-1047` | 统一到ask-stream，见第4节 |
| 请求把选文、问题和书名拼成模型消息 | `server.js:903-914,1122-1138` | 原始用户表达与选文分字段保存，不用拼接文本抽用户画像 |
| 工具共享ctx包含模型配置，返回格式各异 | `agent.js:44-47`；`tools/index.js:49-52` | 检索工具只接收授权上下文，统一ToolResult |
| RAG只返回text/chapter/score，工具再映射一次 | `rag.js:312-352`；`tools/search-in-book.js:30-33` | 保留来源候选和诊断，再由问答服务分配证据ID |
| Agent自己发end，服务端之后才存最终答案 | `agent.js:99-111`；`server.js:1157-1173` | 只有问答服务能发终态，完成必须先持久化 |
| 前端end后另POST旧history，历史页面实际读conversations | `public/app.js:827-835,1970-1999` | 新问答只写会话一次，不再额外写旧history |
| SSE仅逐行解析，EOF不等于完整完成 | `llm-client.js:130-150`；`public/app.js:971-1006` | 统一事件封套、终态规则和残留缓冲处理 |
| 关闭任务弹窗不取消上游请求 | `public/app.js:241-244,1526-1528` | “关闭展示”和“停止任务”必须区分 |
| 记忆只有分类/正文等字段，按用户精确去重 | `conversation.js:293-386` | 增加作用域、来源、状态、版本和删除屏障 |

## 3. 责任边界与公共命名

### 3.1 模块职责

| 模块/负责人 | 拥有的职责 | 不应承担的职责 |
| --- | --- | --- |
| 问答服务，优先落在server.js | 请求鉴权、会话绑定、请求去重、组装上下文、证据登记、统一SSE、最终持久化与后处理调度 | 复制BM25或另建一套记忆冲突规则 |
| agent.js | 自动选择直接回答/工具/任务/澄清；维护执行预算；在取证约束内生成回答 | 写HTTP响应、直接写记忆、自行发请求终态 |
| tools/ | schema与参数校验、调用授权书籍读取/RAG能力、返回结构化结果 | 接受模型传入userId覆盖身份、绕过书籍范围、拼SSE、写会话 |
| rag.js + embedding.js | 索引、召回、融合、候选来源、实际路径诊断；向量模型一致性 | 判断用户偏好、决定整个回答是否完成 |
| text-utils.js | 统一文本规范化、章节与原文位置规则 | 使用另一个trim/换行规则生成不兼容坐标 |
| conversation.js | 会话消息、摘要、用户记忆及其生命周期，按授权参数提供读写方法 | 把书籍检索结果当用户记忆、直接输出SSE |
| orchestrator.js | 有界长任务执行、节点状态、覆盖范围和结果 | 用task_done表示HTTP请求已完成，或宣称采样结果覆盖全书 |
| llm-client.js | 提供商适配、流解析、错误分类、超时/取消、usage收集 | 决定是否越过证据要求、创建用户身份、重复保存答案 |
| database.js | 连接、表与索引迁移、事务约束 | 长事务中等待模型API、单方面修改共享字段含义 |
| public/ | 发统一请求、展示状态/证据/记忆、发用户管理操作 | 伪造引用、维护第二份权威聊天历史、把EOF当成功 |

一个源文件可承载多个职责，但同一个职责只保留一个实现。共享文件按集成负责人串行合入；不要让RAG与记忆两个执行者同时重写server.js、database.js或public/app.js。

### 3.2 标识与空值

- JSON使用camelCase，SQLite列使用snake_case，由模块边界转换。
- userId、bookId、conversationId沿用现有字符串ID；messageId、memoryId沿用正整数，必须在JavaScript安全整数范围内。
- requestId由浏览器为一次用户提交生成UUID；同一次不确定是否送达的重发复用它，用户明确再次提问/重试生成使用新的ID。
- requestId只在当前认证用户范围内唯一，不能作为访问凭证。
- evidenceId形如E1、E2，仅在一个requestId内有效；引用全局身份是requestId与evidenceId的组合。
- chunkId是索引内部定位，不作为永久引用依据；重建可改变chunkId，不能影响原文坐标含义。
- 时间使用UTC ISO 8601字符串；耗时单位ms；文本偏移使用UTF-16码元；token字段必须说明实际usage或估算。
- 契约中的必有但不存在的值使用null，列表无内容使用[]，布尔值不使用字符串。问答文本必填，不能用null代替。
- 不允许同一字段在不同分支有时是字符串、有时是对象。未知能力返回明确不可用状态，不伪造空对象表示成功。

## 4. 统一HTTP入口

### 4.1 问答请求：POST /api/ask-stream

P1a复用这个现有路径，前端不再发送Agent开关。目标请求：

```json
{
  "requestId": "913c2f4e-00b2-4a61-90ae-a9e900000001",
  "conversationId": null,
  "bookId": "book-example",
  "question": "这段话是什么意思？",
  "selection": {
    "text": "用户选中的原文",
    "locator": null
  },
  "action": "explain",
  "provider": null,
  "model": null
}
```

| 字段 | 含义与校验 |
| --- | --- |
| requestId | 必填UUID，用于请求关联和重复提交保护 |
| conversationId | 可省略或null；传入则必须存在、属于当前用户，并与bookId一致；不允许找不到就静默建新会话 |
| bookId | 可省略或null；有书籍则必须属于当前用户且内容可读；无书籍时禁用书内工具 |
| question | 必填非空字符串，单独保留原始用户表达；长度上限由P1a配置并测试边界 |
| selection | 可省略或null；存在时text非空；locator见第6节，不再使用顶层text和bookName |
| action | 可选，默认ask；枚举ask/explain/translate/summarize/rewrite，是用户操作线索，不是跳过取证的授权 |
| provider/model | 可省略或null，由服务端按已存配置解析；不接受Key或任意临时URL；未知配置明确报错，不偷偷换模型 |

进入工具前必须完成鉴权、书籍权限、会话归属、字段校验及本次提供商解析。bookName由服务端读取；不能信任客户端伪造书名来决定原文依据。

不得接受客户端提供的userId、messages、systemPrompt、memories、evidence、工具策略或预算来替换服务端值。书籍ID与会话不匹配返回409；未授权或不存在的资源均返回404，避免枚举。

请求规范化规则对同一次重发保持稳定；去重摘要使用客户端提交的语义字段，包括省略字段的固定默认值，不因之后默认模型变化而重新执行已有请求。

### 4.2 其他共享入口

| 入口 | 约定 |
| --- | --- |
| GET /api/books/:id | P1b的TXT响应为 `{ book, content, contentHash, chapters }`；book沿用书籍元信息，content为第6节规范文本，chapters每项为 `{ id, ordinal, title, start, end }`；阅读器使用服务端章节标识和坐标，不能另算一套 |
| GET /api/ask-requests/:requestId | P1a新增：按当前用户查询请求状态及已保存结果，供断线后核对；未知或无权访问返回404 |
| GET /api/conversations/:id/messages | 历史读取默认返回全部可见消息，不仅是工作窗口；返回第10节消息结构与context统计；摘要出窗不应使UI历史消失 |
| POST /api/agent/task | 保留专用长任务入口；增加requestId，可接收conversationId、bookId、taskType、provider、model、force；内部复用同一请求协调/事件/落库规则，必要时按书创建会话 |
| GET /api/agent/task/result | 保留按bookId+taskType获取缓存，返回第9节TaskResult；内容版本不一致不能作为当前书的新结果复用 |
| /api/memories及/api/memory-settings | P2按第8节新增或扩展管理能力 |

P1a在同一个Web变更中迁移前后端请求与事件消费者；核对全部Web调用者后移除旧/api/agent/stream以及无调用者的旧问答路径，不保留两套问答业务作为兼容层。不改Android调用者。旧history数据不删除，但新问答不再调用POST /api/history。

P1a不要求无限分页或新历史框架；若使用分页，返回明确的hasMore/游标，并保证UI能取到完整历史，不能把上下文窗口过滤伪装成分页。

## 5. 服务端上下文与取证决策

### 5.1 内部RequestContext

此对象不得整体序列化给模型、浏览器或日志。

```text
RequestContext = {
  requestId, userId, conversationId,
  userMessageId, assistantMessageId,
  question, action,
  book: null | { bookId, title, contentHash, content },
  selection: null | { text, locator, verified },
  signal: AbortSignal,
  deadlineAt: 毫秒时间戳,
  budget: { maxIterations, maxToolCalls, maxContextTokens, maxOutputTokens },
  memories: MemoryBundle,
  evidenceRegistry: 本轮服务端证据登记表
}
```

- book.content是服务端授权读取的规范文本；仅相关片段进入模型，不因统一上下文就默认发送整本书。
- 模型凭据单独交给llm-client；RAG通过embedding模块解析已授权配置，不让检索工具收到整个API Key对象。
- 检索工具只能访问该book；它们的schema不包含userId、bookId、文件路径或endpoint。
- AbortSignal贯穿Agent、LLM、Embedding、工具和DAG；任何模块不得吞掉用户取消后当成普通降级继续调用。
- 明确区分信任：系统规则与授权最高；用户本轮表达规定需求；选文、书籍证据、摘要、长期记忆是数据，不具备修改系统规则的权限。

### 5.2 决策结果与证据门控

```text
Decision = {
  route: direct | tools | task | clarify,
  evidenceRequirement: none | selection | book | coverage,
  reasonCode: 不含隐藏思维过程的短原因标识,
  taskType: null | generate-notes | character-analysis
}
```

这是Agent与问答服务之间的结构约定，不意味着每轮必须先独立调用一个分类模型。可依据明确UI操作、现有上下文与工具决策产生，但服务端最终执行检查。

| requirement | 满足条件 |
| --- | --- |
| none | 普通知识/寒暄/表达类任务，不声称获得本地原文依据 |
| selection | 仅解释用户给定文本；若未验证书内位置，只能标“用户提供文本”，不能变成可核验书内引用 |
| book | 有当前授权书籍的可用证据，来自已验证选文、检索或章节读取；选文不足以回答时必须补查 |
| coverage | 需要覆盖式任务与实际处理范围；Top-K不能满足全书覆盖，采样结果必须明确限定 |

服务端维护本轮实际已提供给模型的证据集合。已要求book却只有用户记忆、无命中或未验证选文时，不可直接进入有原文依据的回答：应在预算内补查、澄清或返回缺证说明。

隐含意图识别和“片段是否足以回答”仍可能出错；需要测漏查率、冗余调用率和答案支撑率，不能把有一个非空片段等同于正确回答。

进入answer_start后冻结本次回答的证据集合，不在已输出结论后继续查证再补来源；需要再规划时，在answer_start前完成。工具调度期间的模型思考/草稿不得当作最终正文流出。

## 6. 原文、检索与引用契约

### 6.1 规范文本与Locator

P1b统一采用TXT规范文本v1：服务端按检测编码解码，移除开头BOM，把CRLF与单独CR统一为LF；不trim、不合并空行、不做Unicode归一化。contentHash为规范文本UTF-8字节的SHA-256，表示为 `txt-v1:<64位小写十六进制>`。

```text
Locator = {
  contentHash: string,
  start: integer,
  end: integer
}
```

- 偏移从0开始，区间[start,end)，且0 ≤ start < end ≤ content.length；单位为JavaScript字符串UTF-16码元，不是字节、字数、token或DOM位置。
- 边界不得切断代理对；工具文本必须等于content.slice(start,end)。如截短文本，要同步改end，不把省略号写进原文。
- bookId放在来源对象中；locator与bookId共同标识位置。相同hash不代表不同用户有共享访问权。
- 章节标识在该内容版本内稳定；chapter为null或 `{ id, ordinal, title }`，ordinal从1开始，未知章节不能伪造名称或序号。
- 阅读器、分块器、章节工具、人物工具共用规范文本规则。前端可以改变排版，但必须维护规范文本到DOM文本节点的映射。
- 传入locator时服务端验证版本与选文。版本过期返回409 BOOK_CONTENT_CHANGED；范围非法或文本不符返回422 INVALID_SELECTION；不偷偷定位到第一次同名片段。
- 没有locator的用户选文仍能解释，verified=false；不能直接升级为book证据。P1a的旧检索片段可展示来源但标不可跳转，P1b之后新产出的book_excerpt必须有locator。
- 索引版本与内容hash分开：同一本书重新分块不改变原文hash；因此历史引用不依赖chunkId。原文版本改变后显示引用失效，不跳到碰巧相同的偏移。

### 6.2 检索函数边界

共享语义签名（目标接口，不是当前已存在的函数签名）：

```text
retrieveAsync({ userId, bookId, query, topK, signal, deadlineAt })
  -> RetrievalResult

RetrievalResult = {
  status: ok | empty | unavailable | error,
  candidates: EvidenceCandidate[],
  diagnostics: {
    indexVersion: string | null,
    paths: [{ method, status: ok | skipped | error, code: string | null }],
    elapsedMs: number,
    warnings: AppError[]
  },
  error: AppError | null
}

EvidenceCandidate = {
  bookId: string,
  contentHash: string | null,
  chunkId: integer | null,
  chapter: null | { id, ordinal, title },
  text: string,
  locator: Locator | null,
  method: bm25 | vector | hybrid | fulltext | chapter | character,
  rank: integer | null,
  score: null | { kind: bm25 | rrf | vector_distance | rerank, value: number }
}
```

- topK由服务端策略决定并限定；用户和模型不指定无限返回量。
- status=ok表示至少一条可用候选；empty表示检索执行但无可用命中；unavailable表示无可用索引/能力；error表示请求的能力失败且无可用结果。后三者candidates=[]。
- empty不是异常，unavailable需给出可识别原因；向量失败但BM25有结果为ok+warnings，不把整个请求报错或仍伪称向量成功。
- diagnostics.paths记录本次实际路径。hybrid只在两路实际参与召回/融合时使用，不从建库mode推断；score不是概率，不跨评分类型直接比较。
- 取消/总时限耗尽以可识别异常交给上层终止，不转成empty。
- P1b之后普通RAG候选的bookId、contentHash、locator必须与已授权内容一致。工具可增加方法但不能删掉这些共享字段；父块/邻接扩展也返回真实连续原文区间，多个不连续区间用多条候选。
- RAG不分配E1，不生成引用语法、不落会话消息；同一检索能力也可供评测脚本调用。

### 6.3 工具结果与证据登记

```text
executeTool(name, args, toolContext) -> ToolResult

ToolResult = {
  status: ok | empty | unavailable | error,
  candidates: EvidenceCandidate[],
  data: object | null,
  diagnostics: { paths: array, elapsedMs: number, warnings: AppError[] },
  truncated: boolean,
  error: AppError | null
}
```

检索、章节、人物工具都把原文放candidates。data仅承载工具专有元信息，例如章节总数、人物已返回出现次数；不得另放一套丢失定位的snippet/preview让回答使用。人物只返回前N处时叫returnedOccurrences，不冒充全书totalOccurrences。

参数JSON必须完整且通过schema校验才执行；未知工具/非法参数返回结构化错误，不能用{}替代解析失败后继续调用。工具结果先按项数或文本预算裁剪再JSON.stringify，截断后仍可解析；truncated不能省略。

问答服务校验候选并分配E1、E2等，登记键优先为bookId+contentHash+start+end；无定位的阶段候选按本轮受信任工具结果登记，不做跨版本持久复用。只有进入模型本轮上下文的候选才进入引用白名单，候选召回数量不等于模型实际见过的证据数量。

```text
Evidence = {
  evidenceId: string,
  kind: book_excerpt | user_selection,
  bookId: string | null,
  chapter: object | null,
  text: string,
  locator: Locator | null,
  verified: boolean,
  method: selection | bm25 | vector | hybrid | fulltext | chapter | character
}
```

verified表示来源/位置已核实，不表示证据支持了模型所有结论。P1a无法核验旧片段的精确坐标时不得写verified=true来假装支持跳转；授权工具读取的书内片段可用于阶段性的book取证，但须标未完成精确定位，P1b消除此缺口。

### 6.4 引用表示与历史恢复

- 模型引用固定使用 `[[E1]]`；前端只能把本轮白名单中的完整标记变成可点击引用，不直接渲染模型生成的HTML/链接。
- 流解析保留跨chunk的未完成引用标记；直到完整并通过白名单检查才显示引用。未知ID显示为不可点击的“引用无效”，并记录INVALID_CITATION警告，不猜测它指的是哪个片段。
- 最终citedEvidenceIds从实际输出中的合法标记提取，是evidence集合子集；检索但未提供给模型的结果不能事后补入白名单。
- 回答元数据保存证据快照、有效引用ID、requestId和contentHash；重开会话无需再次检索即可展示同一回答的证据。
- 点击跳转前重新检查书籍权限、当前内容hash与范围。书已删除/无权访问/版本改变时清楚提示，不跳转其他书籍。
- “引用合法率”自动验证ID、权限和坐标；“引用支撑率”人工核实主张与片段关系，两者分别报告。

## 7. 会话上下文与模型调用

### 7.1 输入分区

模型上下文至少区分：系统规则、用户适用偏好/书级目标、会话摘要、已完成历史轮次、当前原始问题与选文、本轮书籍证据。提示中的数据分区不能让外部文本获得系统指令优先级。

- userText始终来自question，不用含书名/选文/工具结果的拼接消息作为记忆抽取源。
- 用户选择的原文保存为用户消息metadata.selection，模型输入构造时再组装。历史重放也遵守相同分区。
- 工作窗口与UI历史分离：in_window控制送入模型，不能限制用户查看完整消息。
- 摘要保持会话级；压缩不自动制造用户长期事实，压缩失败不能导致丢消息。
- 只把完成轮次加入后续模型历史；失败、取消或中断的半截回答可供UI查看，但不作为已确认结论继续推理。

### 7.2 LLM适配边界

沿用chat/stream/complete调用层，不允许各模块自行fetch供应商接口。流式工具数据在客户端层拼接、校验并交给Agent，供应商事件不得直接透传给浏览器。

共享归一化结果为 `{ content, toolCalls, finishReason, usage }`；toolCalls每项包含id/name/arguments对象。chat与stream返回这一结果，complete可保留只返回content的便捷封装，但usage需通过同一观测回调登记；P1a同步迁移已有调用者，不留下字符串/对象两种stream返回约定。

调用选项统一支持signal、deadlineAt、timeoutMs、maxTokens、retries；实际超时不超过剩余总时限。重试只针对明确可恢复错误，发生取消立即停止。400/404不能一概当“模型不支持工具”，必须区分无效模型、请求参数与能力不支持。

客户端需处理UTF-8跨块、SSE空行分帧、残留缓冲和提供商完成标识；无有效完成信号的EOF按中断处理，不能把部分文本伪装成功。已向用户输出正文的生成不自动重试拼接第二份答案。

token预算包含系统提示、schema、摘要、记忆、证据、历史和输出预留。具体数值在P1a/P3配置与评测中冻结；没有准确usage时注明估算来源，不承诺跨模型精确计数。

## 8. 记忆模块共享契约

### 8.1 对外MemoryView与内部隔离

```text
MemoryView = {
  id: integer,
  revision: integer,
  kind: preference | fact | interest | reading_goal | open_question,
  key: string,
  content: string,
  scope: user | book,
  bookId: string | null,
  status: candidate | active | superseded | expired | completed,
  source: {
    type: user_message | user_edit | user_confirmation | legacy,
    conversationId: string | null,
    messageId: integer | null
  },
  createdAt: string,
  updatedAt: string,
  expiresAt: string | null
}
```

- 存储记录另带userId，不依赖前端提交身份；所有读写方法必须接收服务端userId。
- scope=user要求bookId=null；scope=book要求有效且属于用户的bookId。reading_goal/open_question首版限定book范围。
- key用于同类事实/偏好的冲突匹配；具体键表与合并策略由记忆详细方案负责，不直接拿content字符串代替结构化身份。
- revision每次变更递增；candidate不能用于回答，completed用于已完成阅读目标/已解决问题，不再作为当前待办召回。
- 明确稳定陈述可以active并提示；不确定推断只能candidate待用户确认。助手、书籍、引用内容不能成为自动写入用户事实的来源。
- 来源引用只允许当前用户自己的用户消息；用户编辑/确认要记录新操作来源，不能继续冒称原消息逐字表达了修改后的内容。
- source不嵌入完整历史聊天；需要查看时经会话鉴权读取。来源会话已删时返回来源不可用，不猜造来源。
- 老记忆缺来源/作用域/状态时标legacy，迁移如何确认在P2说明，不凭迁移把推断变成已确认事实。

### 8.2 召回与注入

```text
retrieveMemories({ userId, bookId, question, tokenBudget }) -> MemoryBundle

MemoryBundle = {
  enabled: boolean,
  epoch: integer,
  items: [{ memory: MemoryView, reason: global_preference | current_book | relevant_topic }],
  tokenEstimate: integer
}
```

仅active、未过期、作用域匹配的条目可返回。全局风格偏好按适用性筛选，兴趣/事实需相关性门槛；items可为空，不能为凑TopK硬塞无关信息。

问答服务只注入预算内的items，并生成 `{ id, revision, scope, bookId, reason }` 的MemoryRef列表。对外称“本次参考的记忆/偏好”，不宣称能证明模型实际使用了每条记忆。

SSE的memory_context可以显示本轮已注入内容；长期消息metadata只存MemoryRef，不再永久复制一份记忆正文。重开会话时查询当前记忆：已删显示已删除，版本不同显示已更新，不把新正文冒充当时旧版本。

删除记忆不能撤回已经发给模型的内容，也不自动删除聊天中的原话。开始新一轮时重新读取可用记忆；删除/暂停提交之后开始的新轮次不得继续召回旧内容。

### 8.3 写入、并发与暂停

共享后处理输入为 `{ requestId, userId, bookId, conversationId, sourceMessageIds, expectedEpoch }`，只读取这些已完成请求的新增原始用户消息；不接受拼接对话、assistant内容、RAG结果作为抽取证据。

- 普通回答成功落库后至多调度一次抽取；P2决定何时批量处理，但同一来源不能重复抽取造成重复条目。
- 明确“记住/更正/忘记”可走经验证的用户操作路径，不等待普通批量抽取；操作成功才能宣称已记住/已删除，不能由LLM直接许诺成功。
- 每用户有memoryEpoch。明确更正、删除、清空、暂停等会使epoch递增；后台任务提交前验证epoch和来源仍存在。过期任务丢弃或在重新验证后处理，不能覆盖新决定。
- epoch不能单独防止未来重抽旧内容：还需来源处理水位/拒绝记录阻止旧消息重新成为候选。删除后的旧来源必须仍被视为已处理，不能因条目消失而重新抽取。
- 用户关闭enabled时停止长期记忆召回和自动写入，管理界面仍可查看/删除；不会清空聊天或历史记忆。重新开启只处理之后的新来源，不偷偷回溯暂停期间的对话。
- 删除不保留可召回的正文副本；最小防回写记录不得保存敏感正文。删除具体存储清理在P2详细方案验证。
- 候选确认与手动编辑使用revision检查；后台模型结果不能无条件覆盖用户刚编辑的记录。

### 8.4 目标管理API（P2同步更新前端）

| 方法与路径 | 输入与结果 |
| --- | --- |
| GET /api/memories | 可选bookId/status过滤；返回 `{ memories: MemoryView[], epoch }`，仍只能返回当前用户数据 |
| PUT /api/memories/:id | `{ expectedRevision, content }`；验证并更新、递增revision及epoch，返回最新MemoryView |
| POST /api/memories/:id/confirm | `{ expectedRevision }`；确认candidate，处理冲突后返回最新条目及epoch |
| DELETE /api/memories/:id | `{ expectedRevision }`；成功后返回 `{ deleted: true, epoch }` |
| DELETE /api/memories | `{ expectedEpoch }`；清空内容且建立防回写屏障，返回最新epoch |
| GET /api/memory-settings | 返回 `{ enabled, epoch }` |
| PUT /api/memory-settings | `{ enabled, expectedEpoch }`；返回最新设置 |

版本不匹配返回409 MEMORY_CONFLICT，前端刷新并保留用户输入，不盲目覆盖。上述路径是目标，不得宣称当前均已实现。scope/kind/key修改、过期策略和更多管理操作待记忆详细方案定义，不擅自扩展任意字段写接口。

## 9. 长任务共享结果

```text
TaskResult = {
  taskType: generate-notes | character-analysis,
  bookId: string,
  contentHash: string | null,
  status: completed | partial | failed | cancelled,
  content: string,
  cached: boolean,
  coverage: {
    mode: full | sampled | unknown,
    processedChars: integer | null,
    totalChars: integer | null,
    completedUnits: integer,
    totalUnits: integer,
    failedUnits: integer
  },
  warnings: AppError[]
}
```

completed表示约定任务执行完，不自动意味着全文覆盖；coverage.mode单独表达采样程度。进度为已结束单元数/总单元数，结束不等于成功，failedUnits另计。

只有规范文本连续区间成功处理并去重后才能统计processedChars；旧结果没记录范围时用unknown/null，不拿前八章标题数推算100%。全书覆盖详细算法不属于本共享约定。

TaskResult经问答服务转换为统一回答，不把LLM生成的摘要当book_excerpt登记。缓存复用必须至少匹配用户、书籍、任务类型和contentHash；依赖用户阅读目标时，还须匹配注入记忆版本或不共享复用，不能把旧目标下笔记当新目标结果。

自动识别明确长任务可调用现有编排；意图不明确先澄清。书架快捷按钮和聊天入口复用执行/缓存逻辑，不同时启动两份任务；force=true是用户明确重生成，不由模型暗中设置。

## 10. 请求生命周期、持久化与幂等

### 10.1 唯一完成责任

问答服务是请求协调者，负责以下顺序：

1. 校验请求和权限，检查同用户requestId是否已存在，再解析/创建会话。
2. 对同一会话串行接纳生成与压缩：繁忙返回409 CONVERSATION_BUSY，不长时间持有SQLite写事务等待API。
3. 在短事务中创建请求记录、用户消息和待完成助手消息，保留两条messageId；随后才发start并调用模型。
4. 准备工作窗口、适用记忆与证据，执行自动决策/工具/任务，汇总正文和轨迹。
5. 成功生成后校验引用等契约，将助手正文、metadata、请求状态和一次后处理待办在短事务中提交。
6. 提交成功后才发end(status=completed)；内层Agent/工具/编排器不发终态。
7. 持久化后的记忆抽取异步执行。流结束后不继续写SSE；通过记忆接口和请求查询显示处理结果。

不能承诺分布式“恰好一次”。目标是本地同一请求不重复执行/落库/调度；外部模型调用在进程崩溃时是否已计费不可保证，不自动重放有副作用的请求。

### 10.2 请求与消息最小数据要求

P1a由database与问答集成负责人统一设计迁移SQL，必须表达下列逻辑字段，不要求其他模块各自增表：

- 请求记录：userId、requestId、原请求指纹、conversationId、两个messageId、status、error、postProcessing、创建/更新时间。
- status：running、completed、failed、cancelled、interrupted。校验拒绝不创建消息；重启遗留running转interrupted，不自动再次调用模型。
- 对(userId,requestId)建立唯一约束；对会话消息序号建立唯一约束，序号分配与消息插入处于短事务。
- messages增加request关联、状态与结构化metadata。既有消息数据保留，旧消息无metadata时在UI标为旧版记录，不伪造证据或记忆来源。
- request完成记录与助手内容/metadata必须原子更新；失败不能留下completed状态却没有对应答案。

目标历史消息视图：

```text
MessageView = {
  id: integer,
  requestId: string | null,
  role: user | assistant,
  content: string,
  status: running | completed | failed | cancelled | interrupted,
  createdAt: string,
  metadata: object | null
}

AssistantMetadata = {
  schemaVersion: 1,
  answerKind: answer | clarification | insufficient_evidence | task_result,
  evidence: Evidence[],
  citedEvidenceIds: string[],
  memoryRefs: MemoryRef[],
  task: TaskResult | null,
  warnings: AppError[]
}
```

用户metadata保存selection和action，content只存question；助手metadata存上述快照，不保存API Key、完整提示词或隐藏思维链。工具中间对话可在请求内存运行，不强制全部成为永久聊天消息。

### 10.3 重发、取消与失败

- 同requestId+不同请求指纹返回409 REQUEST_CONFLICT；相同指纹且running返回409 REQUEST_RUNNING；相同指纹且已终结，返回已保存结果，不再调用模型/抽取记忆。
- 重放使用start(replayed=true)后end，完整答案由end提供；不伪造逐字流式。seq在这次HTTP响应内重新从1开始，不支持跨连接SSE续传，客户端重建该请求展示而非累加旧序号。
- 请求查询结果为 `{ requestId, status, conversationId, userMessage, assistantMessage, postProcessing, error }`；断线且未见start时也可凭requestId查询是否已接纳。
- 用户停止用fetch AbortController断开；服务端只对未正常结束的响应断开传播取消，不因正常close事件取消已完成结果。
- 取消或上游失败保留已产生的部分正文并标相应状态；不进入后续模型上下文、不启动自动记忆抽取。无正文也不能用空字符串冒充成功答案。
- completed持久化已经提交后发生的客户端断线，不回滚已完成状态；客户端以查询结果为准。提交失败则不能发成功end。
- 记忆后台失败不把已成功答案改成失败；postProcessing区分pending/completed/skipped/failed，用户只有在实际完成后才能看见“已保存记忆”的确认。
- 自动/手动压缩与同会话生成使用同一串行边界，避免在压缩过程中追加的消息被旧统计覆盖。基础上下文超限检查必须发生在模型请求前。

## 11. SSE与前端状态契约

### 11.1 统一封套

```text
data: {"type":"chunk","requestId":"请求UUID","seq":6,"data":{"content":"回答正文增量"}}\n\n
```

所有事件使用type/requestId/seq/data；seq为当前HTTP流从1递增的整数。data是JSON对象。每帧以空行结束；正文换行由JSON转义，不按未转义文本拼帧。start带schemaVersion=1。

| type | data最小字段 | 规则 |
| --- | --- | --- |
| start | schemaVersion、conversationId、userMessageId、assistantMessageId、model、provider、replayed | 一次，在请求已接纳后 |
| status | phase、label | phase为preparing/deciding/retrieving/task/generating/persisting；label是简短状态，不是隐藏思维链 |
| memory_context | refs、items | 仅当需要展示时发送；items是实际注入的MemoryView，refs是对应MemoryRef；P2前可省略，不能声称不存在的记忆功能 |
| tool_call | callId、name、args | 参数完整验证后；不得包含身份、Key、任意路径 |
| tool_result | callId、name、status、returnedCount、truncated、elapsedMs、error | 摘要视图，原文通过evidence发送，不把内部ctx/data整包透传 |
| evidence | items: Evidence[] | 在answer_start前登记，ID不可复用为其他内容；前端按ID合并 |
| task_progress | taskType、phase、completedUnits、totalUnits、failedUnits | 长任务用，不能只用100%表示所有子任务成功 |
| answer_start | answerKind、delivery | delivery=stream/buffered/cached；明确区分真实流式与完整结果/缓存展示 |
| chunk | content | 仅最终正文增量；在answer_start后，前端安全渲染，不与工具JSON混合 |
| warning | code、message、retryable | 可继续运行的降级或部分结果告警，非终态 |
| end | status、assistantMessage、metrics、postProcessing、error | 唯一终态，status为completed/failed/cancelled/interrupted；完整assistantMessage用于校准显示，不再追加正文 |

在连接仍可写且请求已接纳时，必须发且仅发一次end；关闭连接后不保证发送成功，但服务端仍应保存终态。end后不发compressed/session_update或记忆事件，相关统计合入end或通过查询读取。

前端收到HTTP非2xx先解析JSON错误，不进入SSE流程；开始SSE后失败也通过end(status=failed,error=...)，不混用另一种error事件或再次调用res.json。

### 11.2 前端状态与流解析

- 状态：idle → running → completed/failed/cancelled/interrupted。status/tool事件只更新运行中展示。
- 完整解析UTF-8与SSE帧，处理CRLF、跨块、多帧、最后残留缓冲；无终态EOF显示“连接中断，正在核对结果”，不能显示成功。
- 每条回复按requestId关联，切书或恢复会话不能把迟到事件拼到另一本书；终态后忽略该流的重复事件。
- 模型正文和引用均使用安全文本/受限渲染，不允许原样innerHTML。记忆内容同样是不可信文本。
- 清楚区分“停止生成”与“关闭弹窗”；后者不应给用户造成已取消的假象。
- 成功end后刷新持久化消息，不再POST旧history；重放/历史恢复不再次触发记忆抽取。
- 本契约不要求SSE断点续传、后台服务重启后续跑或跨设备实时同步，不提前引入消息队列。

### 11.3 最小完整事件例

书内查询的顺序为start → status(retrieving) → tool_call → tool_result → evidence → answer_start → chunk若干 → status(persisting) → end。直答省略工具/evidence事件；重放仅start和end；失败在任何接纳后的阶段以end结束。

真实模型流式决策如何缓冲、如何在验证取证要求后进入最终流式阶段，属于P1a详细方案；接口验收必须检查不先流出无据答案、不执行半截工具JSON、也不二次生成已完成答案来伪造实时感。

## 12. 错误与指标

```text
AppError = {
  code: string,
  message: 用户可读且不含敏感细节的说明,
  retryable: boolean
}
```

HTTP错误统一 `{ error: AppError, requestId: string | null }`。缺失/非法requestId时返回null；不泄露堆栈、SQL、Key、完整供应商响应或服务器文件路径。

| 类别 | 示例code与处理 |
| --- | --- |
| 请求/权限 | INVALID_REQUEST、UNAUTHENTICATED、RESOURCE_NOT_FOUND；对应400/401/404，先于SSE |
| 冲突/版本 | CONVERSATION_BOOK_MISMATCH、CONVERSATION_BUSY、REQUEST_CONFLICT、REQUEST_RUNNING、BOOK_CONTENT_CHANGED、MEMORY_CONFLICT；409 |
| 选文非法 | INVALID_SELECTION；422，不悄悄定位到别处 |
| 能力与证据 | INDEX_UNAVAILABLE、NO_EVIDENCE、VECTOR_UNAVAILABLE、TOOLS_UNSUPPORTED；通常是工具状态/警告，可澄清或缺证，不一定使整个请求失败 |
| 上游失败 | MODEL_UNAVAILABLE、UPSTREAM_AUTH_FAILED、RATE_LIMITED、UPSTREAM_ERROR、UPSTREAM_INTERRUPTED；是否可重试依据实际错误，不能都说不支持工具 |
| 执行与存储 | REQUEST_TIMEOUT、BUDGET_EXCEEDED、CANCELLED、PERSISTENCE_FAILED；终态与partial正文按第10节处理 |

metrics最小字段：elapsedMs、timeToFirstAnswerMs（无正文为null）、toolCallCount、llmCallCount、tokenUsage。tokenUsage区分actual、estimated、unavailable；多次调用混合来源时逐调用记录，不能把部分usage总和标成精确总成本。

进一步评测记录检索耗时、路径、证据数量、记忆ID/版本、降级code、数据集/模型/提示版本。原始评测内容只限授权的测试集；业务默认日志不收集完整question、selection、book正文或记忆正文。

## 13. 分阶段落地与契约测试

| 阶段 | 对本契约的责任 |
| --- | --- |
| P0 | 测现有接口，不更改请求/事件协议；保存可直答/需取证标签及旧Agent基线 |
| P1a | 落实统一请求、授权上下文、工具状态、事件封套、生命周期、去重/取消、真实流式语义；已有候选无locator时明确不可跳转，不伪造坐标 |
| P1b | 落实规范文本、完整Locator、稳定引用、证据快照与跳转；所有新book_excerpt满足定位不变量 |
| P2 | 落实MemoryView、MemoryBundle、管理API、来源校验与epoch/来源屏障；接入已有问答后处理点，不另建问答路由 |
| P3 | 改进检索与个性化，但不得自行改变共享字段与终态；若修改契约，先做版本化文档变更并同步所有消费者 |
| P4 | 验证全过程与回归，输出真实效果、失败样本和成本数据 |

阶段尚未完成的能力如P1a的locator、P2前memory_context必须在报告注明；不为它们增加永久产品功能开关或多套返回类型。类型中的null仅按本文列明的合法场景使用，不用于掩盖已承诺但失败的能力。

最小契约测试清单（对应阶段完成时必须通过）：

- [ ] C01：伪造userId、其他用户bookId、错配conversationId不能进入工具或创建错绑消息。
- [ ] C02：同requestId重复请求不重复调用/落库/抽取；不同请求正文复用ID返回冲突。
- [ ] C03：模型非法参数与不完整JSON不执行工具，裁剪后工具结果始终可JSON解析。
- [ ] C04：向量失败而BM25命中返回ok+真实路径警告；取消不被转为empty继续运行。
- [ ] C05：规范文本中BOM/CRLF/空行/重复段落/代理对用例均满足text等于slice，版本失配不误跳。
- [ ] C06：合法引用跨chunk仍正确显示，非法ID不可点击；历史引用无需重检索，权限/版本失败明确提示。
- [ ] C07：证据不足与选文足够两类用例分别遵守门控，不是所有请求强制RAG。
- [ ] C08：end在持久化之后且只有一次；保存失败、无终态EOF、取消和重放不显示虚假成功。
- [ ] C09：两个入口调度同类长任务遵循同一结果/缓存契约，采样和部分失败不显示全书成功。
- [ ] C10：工作窗口压缩后UI仍可查看旧消息；未完成回答不进入下一轮已完成上下文。
- [ ] C11：用户原话、选文、工具证据、助手内容分离，后者不能自动成为用户记忆来源。
- [ ] C12：只有有效active记忆按scope注入；书级目标不串书，revision冲突不能覆盖人工更正。
- [ ] C13：删除/清空/暂停后，旧任务和旧来源不会把记忆写回；新请求不注入已删除条目。
- [ ] C14：抽取完成前UI不宣称已保存；删除记忆后历史MemoryRef不恢复正文，不承诺删除聊天原话。
- [ ] C15：日志、工具事件、错误和导出不含Key、内部ctx、完整私有书籍或无关私人记忆。

## 14. 多AI交接与变更规则

1. 接手者先读总方案、本文、阶段方案，再核对当前代码和Git状态；文档中目标类型不能被当作现有函数直接调用。
2. 接手前列明已完成阶段、未实现字段、计划修改文件和验证命令。若总方案与本文不一致，先指出差异，不私自选一个实现。
3. RAG负责人只确定检索内部实现；记忆负责人只确定记忆内部实现。server/database/public/llm-client的共享改动由当阶段集成负责人合入，避免并发覆盖。
4. 调整字段名、枚举、引用格式、偏移单位、错误语义或SSE终态时，先更新本文版本与变更说明，再同步生产者、消费者、测试和模块方案；不靠双方各加兼容分支解决分歧。
5. 数据库迁移需一个连续编号/版本方案，双方不得独立创建相同列或重复执行迁移。具体DDL与备份、回滚、旧记录显示方案在实施阶段写清并验证。
6. 每阶段报告记录文件、接口变化、迁移、测试/未测、图表数据与已知限制，放docs/；只有验收后才能把相应契约状态改为已实现。
7. 本文完成后仍需要RAG、记忆和P1a各自的实施方案；它不是完整代码任务清单，不允许用“实现本文全部内容”绕过逐阶段确认。

交接提示可直接使用：

> 请先阅读docs/web-thesis-plan.md、docs/web-thesis-shared-contracts.md、当前阶段方案和最近的阶段报告，再核对Web代码。严格遵守共享字段、权限、原文定位、终态和记忆来源规则。只处理指定阶段，先列差异与验收方案，确认后实施；不碰mobile/、Android分支或受保护运行数据，不提交密钥，不擅自修改其他模块契约。
