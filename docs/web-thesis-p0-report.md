# P0 阶段完成报告：实验基线与开题演示底线

日期：2026-11-14。分支：`qoder/web-thesis`。关联：[P0方案](web-thesis-p0-plan.md)、[总方案](web-thesis-plan.md)、[测试计划](baseline/test-plan.md)、[浏览器冒烟](baseline/browser-smoke.md)。

状态：**P0 工程关卡 P0-01~10 全部通过；在线开发集初测（P0-07）已完成。** 未提交、未推送（按方案约束）。

## 1. 修改文件及理由

| 文件 | 改动 | 理由 |
| --- | --- | --- |
| `database.js` | 新增进程级数据根 `READER_DATA_ROOT`（`getDataRoot/getDbPath/getBooksDir/getRagIndexDir`）+ 安全护栏；`initDB` 自动建父目录 | P0-01 隔离：默认业务路径不变，测试写操作全部落临时根；护栏拒绝仓库根/上级/books/rag_index，失败即停不回退 |
| `server.js` | `BOOKS_DIR` 跟随数据根；删除 `/api/ask` 全部 `[DEBUG]` 密钥日志（含解密前缀）；6 处错误日志改为仅记录 status+message，不打印上游响应体/完整错误对象 | P0-01 路径统一；P0-03 去除 Key 前缀与可能回显密钥的上游响应日志 |
| `auth.js` | `BOOKS_DIR` 跟随数据根；默认书源优先隔离根 `__defaults`，否则只读复制仓库默认书 | P0-01 用户书目录隔离；真实默认书只读复制，原件不改 |
| `rag.js` | `LEGACY_RAG_DIR` 跟随数据根 | P0-01 旧索引清理不触及真实 `rag_index/` |
| `conversation.js` | 记忆 kind 固定枚举校验 `sanitizeMemoryKind`（非法值降级 fact），应用于抽取与 upsert | P0-04 模型返回 kind 属不可信输入，禁止任意字符串进入前端样式/HTML |
| `public/app.js` | 记忆渲染仅用固定枚举映射样式与文案，未知 kind 安全降级；content 仍 escapeHtml | P0-04 移除 `m.kind` 直接拼 class/HTML 的注入路径 |
| `package.json` | 新增 `test`（离线 node:test）与 `test:online`（显式在线评测）脚本 | P0-02 默认测试零付费；在线评测显式启动 |

新增支持文件（方案允许的最小扩展）：
- `tests/helpers/`：假模型服务、隔离运行器、人工样本；`tests/*.test.js`：5 个离线测试文件（31 用例）。
- `scripts/inspect-books.js`（书籍元数据只读检查）、`scripts/verify-devset.js`（金标准校验）、`scripts/run-baseline.js`（在线基线运行器）、`scripts/smoke-server.js`（浏览器冒烟环境）。
- `docs/baseline/`：元数据、开发集、校验报告、测试计划、冒烟记录、截图、离线输出。

未改动：`tools/`、`embedding.js`、`text-utils.js`、`agent.js`、`orchestrator.js`、`llm-client.js`（P0 不需要）；`mobile/`、Android 分支、Git 配置未触碰。

## 2. 验证结果（通过/失败/未测）

### 确定性离线测试（`npm test`）
**31/31 通过，退出码 0**（`baseline/offline-test-output.txt`）。覆盖数据根护栏、跨用户隔离、密钥日志、记忆 kind、RAG 建库/检索/降级/KNN 范围、流式/Agent/降级/断流。无新引入回归。

### 浏览器验证（browser-use，隔离+假模型）
**P0-08 通过**：登录→打开 TXT→建索引→选提供商→普通问答→Agent 工具问答→恢复会话→查看记忆，8 步全通过；控制台无 error/warn；25 条网络请求全 200（含 2 条 SSE）。**P0-04 浏览器实测**：非法 kind 降级「事实」、HTML content 仅渲染文字（img/script 节点=0）、`window.__p0_xss=null`。详见 `baseline/browser-smoke.md`，截图 8 张。

### 在线基线（P0-07，开发集初测完成）
模型：通用 OpenAI 兼容端点 `qwen3.8-flash`（凭据存于被 git 忽略的 `.env.baseline.local`，不打印）。该端点无 Embedding 模型，故 P0 基线检索为纯 BM25；混合/重排对照见增强功能报告。产物：`baseline-results/online-2026-11-14T09-10-14-630Z/`。

**检索（BM25，固定 query，16 可答题）**：Hit@5=0.750，Evidence Recall@5=0.625，MRR@5=0.580。

**答案（20题×3次=60运行/入口）**：

| 入口 | 错误率 | 平均工具调用 | 首字P50 | 首字P95 | 总耗时P50 |
| --- | --- | --- | --- | --- | --- |
| normal | 10.0%（6/60） | 0 | 6378ms | 24426ms | 12725ms |
| agent-bm25 | 0% | 2.30 | 17747ms | 61877ms | 17747ms |

**关键基线问题（P1a/P2 证据）：**
- **工具漏查率 11.7%（7/60）**：需取证问题被模型凭先验直答（gg-01×3、gg-07、rs-01、rs-08×2）；normal 入口完全不检索，甚至引用非本地译本（范晔译本）冒充原文。
- **agent 首字延迟高**（P50≈17.7s）：非流式决策轮后才流式输出，决策耗时计入首字（已知问题，P1a 真流式处理）。
- **记忆抽取召回低且不稳定**：10 段脚本中 7 段抽取 0 条记忆（含明确「请记住」的 mem-01），mem-03 抽到 3 条；mem-01/08/10 断言失败。明确偏好常被漏抽（P2 核心问题）。
- normal 错误样本：gg-06、rs-03、rs-06、rs-07、rs-10（超时/空答案），全部计入错误率。

> 口径：仅开发集初测，非正式保留集成绩；答案正确率/记忆 precision/偏好遵从率待人工标注。首字时间从请求发起到首个答案内容，不含「开始检索」事件。

## 3. 产出文档/数据（均在 docs/）

- `baseline/book-metadata.json`：忏悔录 463,787 字符/12 章/UTF-8；百年孤独 251,753 字符/20 章/UTF-8；含 SHA-256。两本均完整译本（百年孤独为高长荣译本，人名奥雷连诺/乌苏娜/布恩蒂亚/梅尔加德斯）。
- `baseline/dev-rag-questions.json` + `devset-verification.json`：20 题，23 条金标准引文**全部命中本地原文**（含偏移与章节）。
- `baseline/dev-memory-scripts.json`：10 段记忆脚本。
- `baseline/test-plan.md`、`baseline/browser-smoke.md`、`baseline/offline-test-output.txt`、`baseline/screenshots/`（8 张）。
- `baseline-results/fake-*/`：评测流程验证产物（FAKE，质量数字无效）。

## 4. 已知失败样本与下一阶段问题

- **断流**：上游中途断开时有界结束并报错，但部分答案未落库、未区分正常结束/提前断开（`llm-client.js` EOF 尾缓冲）→ P1a。
- **记忆治理**：当前精确去重、无来源分离/作用域/冲突处理；书籍剧情与助手推断可能被误抽为用户事实（开发脚本 mem-05/06 预期暴露）→ P2。
- **引用不可跳转**：融合结果无块 ID/locator → P1b。
- **总结禁工具、普通问答依赖模型原著知识**：提示词策略问题 → P1a。
- **任务采样覆盖**：读书笔记前 8 章/人物首次出现 → 可选阶段，v1 如实标注采样。
- 这些保留为基线失败样本，不在 P0 强制修复（避免失去对照基线）。

## 5. 边界自查（P0-10）

- 分支仍 `qoder/web-thesis`；无 `mobile/` 改动；未切换 Android 分支；未改 Git 配置；**未提交、未推送**。
- `data.db`、`books/`、`rag_index/`、`.env` 完整未删改（git 忽略项，运行前后一致）。
- 无密钥进入版本文件：测试用人工 Key 仅存于临时进程；日志泄漏检查通过；docs 不含真实 Key/私人对话/整本原文（召回仅存 120 字预览）。

## 6. 下一步（等待确认，不自动开工）

1. **P0-07 在线基线**：已完成开发集初测（见上）。正式保留集评测在 P4 冻结后进行。
2. **P1a 统一问答与自动取证**：P0 验收后提交具体实施方案与验收标准（合并问答链路、移除前端模式开关、自动工具决策与证据门控、统一流式/预算/取消、接入既有长任务），独立确认后实施。基线已量化漏查率 11.7%、agent 首字延迟、记忆漏抽等问题作为改造对照。
3. P1b 可核验引用闭环随后独立确认。
4. **自定义向量+重排增强**：已按用户授权实现并验证（见 [增强报告](web-thesis-embedding-rerank-report.md)）；重排默认关闭，开发集上 MRR 收益伴随覆盖损失，是否启用待更大标注集评测。

开题表述建议（与方案一致）：已实现具备阅读、工具调用、混合检索和基础记忆的 Web 原型；后续重点研究证据可追溯问答与可控个性化记忆，并通过对照实验验证工程效果。不将拟实现功能写成已完成。