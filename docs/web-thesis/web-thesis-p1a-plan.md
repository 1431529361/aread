# P1a 实施方案：统一问答与自动取证

日期：2026-11-14。状态：**已实施完成（A1~A4），见 [P1a报告](web-thesis-p1a-report.md)**。关联：[总方案](web-thesis-plan.md) §2.0/§2.4、[SC-1.1](web-thesis-shared-contracts.md)、[P0报告](web-thesis-p0-report.md)、[RAG方案](web-thesis-rag-plan.md)、[记忆方案](web-thesis-memory-plan.md)。

P0 基线已量化改造对照：工具漏查率 11.7%、normal 入口零检索且引用非本地译本、agent 首字 P50≈17.7s、记忆漏抽。P1a 目标是统一入口与证据约束，不重做检索算法（P1b）或记忆治理（P2）。

## 1. 当前代码事实（实施前已核对）

| 现状 | 位置 | 问题 |
| --- | --- | --- |
| 前端按 agentMode 分流 askAI/askAgent | `public/app.js:921-922,1027` | 用户须手选模式 |
| 两入口分别请求 ask-stream / agent/stream | `public/app.js:933,1039`；`server.js:843,1081` | 两套业务链路 |
| end 后另 POST /api/history | `public/app.js:1002,2068` | 重复写历史（历史页实际读 conversations） |
| Agent 自己发 end，服务端之后才存答案 | `agent.js:99-111`；`server.js:1157-1173` | 终态责任分散、可能未持久化先发 end |
| 直答分支决策轮整段答案当 chunk 发出 | `agent.js:99-106` | 非真流式，首字含决策耗时 |
| SSE 仅逐行解析，EOF 不当中断 | `llm-client.js:130-150`；`public/app.js:971-1008` | 断流误判成功 |
| 工具结果硬切字符 | `agent.js:152-156` | 截断后 JSON 可能非法 |
| 总结等禁工具、普通问答靠模型先验 | `server.js:1106-1120,893-901` | 漏查/无据冒充原文 |
| 回答结束后才检查压缩 | `server.js:918-931` | 缺发送前完整预算检查 |

## 2. 范围

### 做（P1a 验收必需）
1. **统一问答服务**：`POST /api/ask-stream` 单一业务入口；RequestContext；请求记录与幂等；唯一完成责任（先持久化后发 end）；一次后处理调度。
2. **自动决策与证据门控**：复用现有 function-calling 自动选工具（不加独立分类模型）；Decision{route, evidenceRequirement}；服务端证据登记与门控（需取证无证据→补查/澄清/缺证）；工具参数完整校验后执行、结果裁剪后合法 JSON。
3. **统一 SSE 封套 + 真流式**：{type,requestId,seq,data}；status/tool/evidence/answer_start/chunk/warning/end；最终答案逐 token 流式；决策/取证阶段展示进度；EOF 无终态按中断。
4. **预算与取消**：发送前完整上下文预算检查；总时长/调用数/token 三类预算；AbortSignal 贯穿；取消传播上游、保留部分正文标状态、不触发记忆抽取。
5. **长任务接入**：明确长任务路由复用既有 DAG 入口与缓存；显示覆盖/部分失败状态。
6. **前端单入口**：移除 Agent 开关；统一请求与事件消费；停止生成 vs 关闭弹窗区分；新问答不再 POST /api/history；迁移全部 Web 调用者后移除 /api/agent/stream（不留两套）。

### 不做（后续阶段）
- 不做 locator/引用跳转/规范文本（P1b）；P1a 证据 verified=false、标「不可跳转」。
- 不做记忆作用域/冲突/来源治理（P2）；P1a 仅保证一次抽取、用原始 question 而非拼接文本作抽取源。
- 不做检索算法增量/重排策略调整（P3；重排已作为可选配置存在）。
- 不引入新框架/外部依赖；不改 mobile/、受保护数据。

## 3. 子任务与文件（单一集成负责人串行合入）

### A1 请求契约与生命周期（database.js + server.js + conversation.js）
- 迁移 `web_001_request_contract`（先在隔离副本验证、备份、不删真实数据）：
  - 新表 `requests`(user_id, request_id, fingerprint, conversation_id, user_message_id, assistant_message_id, status, error, post_processing, created_at, updated_at)，UNIQUE(user_id, request_id)。
  - `messages` 增列 request_id、status、metadata(JSON)；旧消息 metadata=NULL，UI 标旧版。
- 统一 handler 顺序（SC §10.1）：校验→幂等判定→短事务建请求+用户消息+待完成助手消息→start→决策/工具/任务→短事务提交助手正文+metadata+状态+后处理待办→end→异步一次抽取。
- 幂等：同 requestId+同指纹已终结→重放(start replayed=true + end)；running→409 REQUEST_RUNNING；异指纹→409 REQUEST_CONFLICT。
- 会话串行：繁忙 409 CONVERSATION_BUSY；不在长事务等 API。
- 重启遗留 running→interrupted，不自动重放付费调用。
- 文件：`database.js`（迁移登记）、`server.js`（统一 handler）、`conversation.js`（消息/会话读写适配 metadata、压缩串行边界）。

### A2 自动决策与证据门控（agent.js + tools/ + server.js）
- `runAgentLoop` 重构为返回结构化结果，**不再发 end/写响应**；终态由问答服务发。
- Decision{route: direct|tools|task|clarify, evidenceRequirement: none|selection|book|coverage, reasonCode, taskType}；由 action+选文+书籍+模型工具决策产生，服务端最终检查。
- 证据登记：本轮实际送入模型的候选分配 E1/E2（P1a locator=null、verified=false）；answer_start 冻结集合。
- 门控：requirement=book 但无可用证据→预算内补查/澄清/insufficient_evidence，不输出无据书内结论。
- 工具：参数完整+schema 校验后执行；结果先裁剪项数/文本再 stringify，truncated 标记；未知工具/非法参数结构化错误。
- `tools/search-in-book.js` 等返回统一 ToolResult{status,candidates,data,diagnostics,truncated,error}（P1a candidates 可无 locator）。
- 文件：`agent.js`、`tools/*.js`、`server.js`（证据登记/门控）。

### A3 统一流式与预算取消（llm-client.js + server.js）
- llm-client 归一化 {content,toolCalls,finishReason,usage}；流式工具数据客户端拼接校验；UTF-8 跨块/SSE 分帧/残留缓冲/完成标识；EOF 无完成→中断异常；区分 400/404 原因；signal/deadlineAt/timeoutMs/maxTokens/retries；已输出正文不重试拼接。
- 统一 SSE 封套与事件（SC §11）；status 阶段 preparing/deciding/retrieving/task/generating/persisting。
- 预算：发送前上下文预算（系统+schema+摘要+记忆+证据+历史+输出预留）；模型窗口可配置；总时长/调用数/token 预算；metrics{elapsedMs,timeToFirstAnswerMs,toolCallCount,llmCallCount,tokenUsage}。
- 取消：AbortController 贯穿 Agent/LLM/Embedding/工具/DAG；客户端断开传播；部分正文标 cancelled/interrupted。
- 文件：`llm-client.js`、`server.js`。

### A4 前端单入口与长任务（public/index.html + public/app.js）
- 移除 agentModeToggle；askAI 统一发 {requestId,conversationId,bookId,question,selection:{text,locator:null},action,provider,model}。
- 新 SSE 解析（封套/跨块/残留缓冲/终态）；status 进度展示；evidence 展示（不可跳转标记）；answer_start delivery；安全渲染；EOF 无 end→「连接中断，正在核对结果」+ 请求状态查询。
- 停止生成（AbortController）vs 关闭弹窗区分；成功 end 后刷新持久化消息，不再 POST /api/history。
- 长任务：聊天入口+书架按钮复用 task 入口；task_progress 与 coverage/partial 展示。
- 迁移全部 Web 调用者后移除 /api/agent/stream 与无调用者旧路径。
- 文件：`public/index.html`、`public/app.js`。

## 4. 验收（确定性测试 + 浏览器 + 真实模型）

| 编号 | 场景 | 标准 | 对应 SC |
| --- | --- | --- | --- |
| A-T01 | 伪造 userId/他人 bookId/错配 conversationId | 不进工具/不建错绑消息，404/409 | C01 |
| A-T02 | 同 requestId 重发 | 不重复调用/落库/抽取；异指纹冲突 | C02 |
| A-T03 | 非法/不完整工具 JSON | 不执行；裁剪后结果可解析 | C03 |
| A-T04 | 向量失败 BM25 命中；取消 | ok+真实路径；取消不转 empty 继续 | C04 |
| A-T05 | 选文足够 vs 需取证 | 分别遵守门控，不每题强制 RAG | C07 |
| A-T06 | 需取证无证据 | 补查/澄清/缺证，不冒充原文 | C07 |
| A-T07 | end 与持久化 | end 在持久化后且仅一次；保存失败/EOF/取消/重放不假成功 | C08 |
| A-T08 | 长任务两入口 | 同一结果/缓存契约；采样/部分失败不显示全书成功 | C09 |
| A-T09 | 压缩后历史 | UI 仍可查旧消息；未完成回答不进下一轮 | C10 |
| A-T10 | 直答/书内/缺证/长任务分流 | 同一入口完成；浏览器主流程通过 | — |
| A-T11 | 流式/取消/断流 | 真流式首字；取消传播；断流有界结束 | — |
| A-T12 | 真实模型对照 | 开发集漏查率/冗余调用率/首字时延 vs P0 基线（11.7%/2.30/17.7s） | — |

确定性约束（A-T01~09）须全通过；模型决策质量门槛在开发集约定、保留集验证，不事后调门槛。

## 5. 风险与取舍
- 改动面大（server/agent/llm-client/conversation/public/database），按 A1→A4 串行，每子任务离线测试+浏览器冒烟后再继续。
- 迁移先在隔离副本验证，备份真实库结构（不删数据）；旧消息保留标旧版。
- 真流式与工具决策缓冲是难点：决策轮非流式、最终答案流式；status 事件展示进度，不以整段 chunk 冒充流式。
- 证据门控的隐含意图识别仍可能错，单独测漏查率；不宣称所有意图识别正确。
- 不保留两套问答业务作兼容层；迁移完成即移除旧入口（SC 要求）。

## 6. 待确认决策
1. **范围**：是否按上述完整 P1a（含 requestId 幂等/重放、请求记录表）实施？或先做精简核心（统一入口+门控+统一事件+持久化一次+取消/预算+真流式+长任务），requestId 完整重放端点延后？
2. **旧入口移除时机**：迁移全部 Web 调用者后立即移除 /api/agent/stream（推荐，符合 SC），还是保留一个过渡期？
3. **证据展示**：P1a 证据标「不可跳转」（P1b 补 locator）是否接受？