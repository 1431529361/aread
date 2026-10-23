# AI 阅读助手（Android / Expo）

本地优先的 Android 阅读助手：书籍、索引、会话、笔记、记忆全部存在设备本地；不设账号、服务器与云同步。
完整交接方案见 [`../docs/android-app-spec.md`](../docs/android-app-spec.md)。

## 当前进度

**M0-A 已完成（纯逻辑，不依赖模拟器/真机）**

- 核心纯逻辑：分词、分块 + locator、FTS5 查询构造、向量排序、RRF、记忆去重、`embed_sig`、prompt
- SQLite schema、顺序 migration、op-sqlite 适配层
- 备份 ZIP 的 manifest 定义与导入/导出纯逻辑（JSZip）
- Vitest 单测 74 个

M0-B 起需要 Android 设备或模拟器验证原生模块与流式输出；Expo Go 不可用，必须使用 dev build。

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
src/core/             # 纯逻辑：rag / llm prompts / conversation / embedding
src/db/               # schema、migrations、op-sqlite 适配器
src/reader/           # locator
src/services/         # backup
__tests__/            # Vitest 单测
```
