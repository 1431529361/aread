# AI 阅读助手（Android / Expo）

本地优先的 Android 阅读助手：书籍、索引、会话、笔记、记忆全部存在设备本地；不设账号、服务器与云同步。
完整交接方案见 [`../docs/android-app-spec.md`](../docs/android-app-spec.md)。

## 当前进度

**M0-A + P0/P1 可离线部分已完成（不依赖模拟器/真机）**

- 核心纯逻辑：分词、分块 + locator、FTS5 查询构造、向量排序、RRF、`embed_sig`、prompt
- RAG 管线：自定义 Embedding client、FTS5/向量仓储、索引状态机与断点续跑、单书/书库混合检索
- P1 检索优化：追问查询改写、parent-child small-to-big、复用现有 Provider 的 LLM rerank
- Agent：OpenAI 兼容 LLM client、9 个工具、预检索证据、引用校验、工具并行执行（并发 3）、流式降级
- Memory v2：migration v3、ADD/UPDATE/SUPERSEDE/NOOP 写入合并、分层读取与使用统计
- P1-6 评测：3 本合成样书 × 10 题，真实 Embedding/Chat 检索与 Agent 评测，输出 Markdown/JSON 报告
- SQLite schema、顺序 migration、op-sqlite 适配层、备份 ZIP 格式
- Vitest 单测 218 个

真机 FTS5 验证、EPUB 渲染/引用跳转、Memory 设置页、P1-5 与 M1+ 功能仍待后续里程碑；Expo Go 不可用，必须使用 dev build。

## 常用命令

```bash
npm install
npm test              # Vitest 单测
npm run typecheck     # tsc --noEmit
npm run eval          # P1-6 live 评测（读取 .env.eval.local）
npx expo start        # 启动 Metro（M0-B 起需 dev build）
npx expo run:android --device
```

## 评测

`npm run eval` 会读取项目目录下被 git 忽略的 `mobile/.env.eval.local`：

```bash
cp .env.eval.example .env.eval.local
# 填入 OpenAI 兼容的 chat/embedding 配置
```

报告写入 `evals/reports/latest.md` 与 `latest.json`（均不提交）。密钥只保存在本地 env 文件，不会进入代码或报告。

## 目录

```
app/                  # expo-router 页面（当前仅占位入口）
src/core/             # rag / llm / agent / conversation / embedding 纯逻辑
src/db/               # schema、migrations、op-sqlite 适配器、repositories
src/reader/           # locator
src/services/         # indexing、retrieval、parentExpansion、memory、backup
evals/                # P1-6 数据集、评测执行器、报告（reports 已忽略）
__tests__/            # Vitest 单测
```
