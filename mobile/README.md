# AI 阅读助手（Android / Expo）

本地优先的 Android 阅读助手：书籍、索引、会话、笔记、记忆全部存在设备本地；不设账号、服务器与云同步。
完整交接方案见 [`../docs/android-app-spec.md`](../docs/android-app-spec.md)。

## 当前进度

**M0-A + P0 离线优化已完成（不依赖模拟器/真机）**

- 核心纯逻辑：分词、分块 + locator、FTS5 查询构造、向量排序、RRF、`embed_sig`、prompt
- RAG 管线：自定义 Embedding client、FTS5/向量仓储、索引状态机与断点续跑、单书/书库混合检索
- Agent：OpenAI 兼容 LLM client、三个基础工具、预检索证据、引用校验、流式降级
- Memory v2：migration v3、ADD/UPDATE/SUPERSEDE/NOOP 写入合并、分层读取与使用统计
- SQLite schema、顺序 migration、op-sqlite 适配层、备份 ZIP 格式
- Vitest 单测 173 个

真机 FTS5 验证、EPUB 渲染/引用跳转、Memory 设置页、P1 优化与 M1+ 功能仍待后续里程碑；Expo Go 不可用，必须使用 dev build。

## 常用命令

```bash
npm install
npm test              # Vitest 单测
npm run typecheck     # tsc --noEmit
npx expo start        # 启动 Metro（M0-B 起需 dev build）
npx expo run:android --device
```

## 目录

```
app/                  # expo-router 页面（当前仅占位入口）
src/core/             # rag / llm / agent / conversation / embedding 纯逻辑
src/db/               # schema、migrations、op-sqlite 适配器、repositories
src/reader/           # locator
src/services/         # indexing、retrieval、memory、backup
__tests__/            # Vitest 单测
```
