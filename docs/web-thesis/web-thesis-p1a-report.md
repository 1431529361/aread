# P1a 阶段报告：统一问答与自动取证

日期：2026-11-14。分支：`qoder/web-thesis`。关联：[P1a方案](web-thesis-p1a-plan.md)、[SC-1.1](web-thesis-shared-contracts.md)、[P0报告](web-thesis-p0-report.md)。
状态：A1~A4 实现完成；离线 52/52 通过（含 9 项 P1a 验收）；浏览器统一入口验证通过；真实模型对照见 `baseline-results/p1a-*/`。未提交未推送。

## 1. 修改文件及理由

| 文件 | 改动 | 理由 |
| --- | --- | --- |
| `database.js` | 迁移登记机制 + `web_001_request_contract`（requests 表、messages 增 request_id/status/metadata、seq 唯一索引） | 请求生命周期与幂等的数据基础；只做加法不删数据 |
| `request-store.js`（新增） | 请求 CRUD、稳定指纹、终态判定、重启遗留 running→interrupted | 幂等/重放/去重 |
| `qa-service.js`（新增） | 统一问答服务：校验→幂等→短事务建请求/消息→start→决策/工具/任务→证据门控→短事务提交→end→异步一次抽取；唯一完成责任 | 合并双入口业务链路；先持久化后发 end；取消/失败标状态不抽取 |
| `conversation.js` | appendMessage 支持 metadata/status/requestId 并返回 id；updateMessage/getMessageById；buildModelMessages 仅纳入完成轮次 | 消息契约；未完成回答不进上下文 |
| `agent.js` | 重构：结构化返回（route/content/证据候选/预算计数），不再发 end/最终 chunk；工具参数校验、结果裁剪合法 JSON；fallback 标记 | 自动决策与证据收集；终态责任上移 |
| `tools/*.js` + `tools/tool-result.js`（新增） | 统一 ToolResult{status,candidates,data,diagnostics,truncated,error}；注册表跳过辅助文件+参数 schema 校验 | 证据候选契约；非法参数不执行 |
| `llm-client.js` | 归一化 {content,toolCalls,finishReason,usage}；signal/deadlineAt；UTF-8 跨块/SSE 分帧/残留缓冲；EOF 无完成→interrupted；流式工具增量拼接 | 真流式与取消/中断语义 |
| `server.js` | 挂载统一 /api/ask-stream + /api/ask-requests/:id；移除旧 /api/agent/stream；注入 qa-service | 单入口；不留两套业务 |
| `public/index.html` + `public/app.js` | 移除 Agent 开关；askAI 统一请求+新 SSE 封套解析；停止生成 vs 关闭弹窗；证据展示（不可跳转）；EOF 无终态→核对请求；不再 POST /api/history | 前端单入口；安全渲染；诚实状态 |

## 2. 验证

### 离线确定性测试（`npm test`，52/52）
- P0 回归 43 项（含迁移到统一入口的对话/RAG/安全/重排测试）。
- P1a 验收 9 项（`tests/p1a-qa.test.js`）：
  - A-T01 他人书籍 404、会话书籍错配 409。
  - A-T02 同 requestId 重放不重复落库、异指纹 409、缺 requestId 400。
  - A-T03 不完整工具 JSON 不执行（INVALID_TOOL_ARGS）、无证据。
  - A-T05 选文解释不强制检索。
  - A-T06 需取证无证据→insufficient_evidence，不冒充原文。
  - A-T07 end 在持久化后且仅一次；请求查询可恢复且与 end 一致。
  - A-T08 长任务路由 task_result + 采样覆盖（非全书）。

### 浏览器（隔离+假模型）
- Agent 开关已移除（`agentModeToggle` 不存在）。
- 统一入口自动流程：status（准备/分析/查阅）→ tool_call searchInBook → tool_result ok·4条 → evidence E1-E4（章节标注+「不可跳转」）→ answer_start → 流式 chunk → 正在保存 → end completed。截图 `10-p1a-unified-chat.png`。
- 会话恢复：关闭再打开面板，4 条消息回显。
- 应用本身控制台无错误（仅测试者一次跨域重置假模型被 CORS 拦截，与应用无关）。
- 选文门控「不强制检索」由离线 A-T05 验证（浏览器假模型常驻工具脚本无法体现模型自主决策）。

### 真实模型对照（A-T12）
见 `baseline-results/p1a-2026-11-14T12-04-05-708Z/report.md`（qwen3.8-flash + bge-m3 混合检索，20 题，全部 completed）：

| 指标 | P0 基线(agent-bm25) | P1a 统一入口 |
| --- | --- | --- |
| 需取证漏查率 | 11.7%（7/60） | **0%（0/20）** |
| 无据回答率 | normal 零检索、引用非本地译本 | **0%（0/20，全部有证据）** |
| 平均工具调用 | 2.30 | 2.85 |
| 首字 P50 | 17747ms | 34596ms |
| 错误率 | 0% | 0% |

**分析（开发集初测）：**
- **证据门控生效**：漏查率 11.7%→0%，无据回答率 0%。需取证问题即使模型直答（如 rs-08 tools=0），服务端补查仍提供证据（evidence=5）；每题证据 5~19 条。
- **首字时延上升（17.7s→34.6s）是真实权衡**：P1a 证据型回答走「非流式决策/工具→取证→重新流式生成最终答案」，首字需等待取证完成与最终生成启动；P0 agent 把决策轮整段内容当答案发出（首字早但非真流式）。这是「真流式+证据约束」换取的延迟，P3 可优化（如最终决策轮直接流式、减少补查）。
- **工具调用略增（2.30→2.85）**：门控补查与混合检索带来更多召回。
- **no-answer 题（gg-09/10、rs-09/10）仍标 answerKind=answer**：因检索返回了相关但未必充分的片段，门控按「有证据」放行；是否正确说明「书中无」需人工标注（缺证处理正确率）。当前门控只在检索 0 命中时标 insufficient_evidence，对「相关但不充分」证据的语义判断留待人工评测与 P3。

> 口径：开发集初测，非保留集；答案正确率/缺证处理正确率待人工标注。首字从请求到首个答案 chunk。

## 3. 已知限制与下一阶段
- P1a 证据 verified=false、标「不可跳转」；locator/规范文本/引用跳转属 P1b。
- 直答（选文足够/无需取证）以 delivery=buffered 诚实交付；证据型回答真流式（delivery=stream）。不以整段 chunk 冒充逐 token。
- 记忆仍为 P0 治理水平（一次抽取、原始 question 来源）；作用域/冲突/来源治理属 P2。
- 隐含意图识别仍可能错，漏查率/冗余调用率单独测量，不宣称全对。
- 单进程部署假设；会话繁忙串行（409）；不引入消息队列。
- 首字时延较 P0 上升（真流式+取证的权衡），P3 优化最终轮流式与补查策略。
- no-answer 题「相关但不充分」证据的语义缺证判断留待人工评测与 P3（当前仅检索 0 命中标 insufficient）。

## 4. 边界自查
- 分支 qoder/web-thesis；无 mobile/ 改动；受保护数据完整；迁移只做加法。
- 凭据存于被 git 忽略的 `.env.baseline.local`；日志/事件/导出不含 Key、内部 ctx、完整私有书籍。
- 未提交未推送。