# AI 阅读助手（Android / Expo）

本地优先的 Android 阅读助手：书籍、索引、会话、笔记、记忆全部存在设备本地；不设账号、服务器与云同步。
完整交接方案见 [`../docs/android-app-spec.md`](../docs/android-app-spec.md)。

## 当前进度

**M0-B 实现完成，待真机验收**

- M0-A/P1 离线核心不变：分块 + locator、FTS5 查询、向量/RRF、Agent 工具、Memory v2、长任务、评测
- M0-B 设备集成：Expo dev build 配置、onboarding、书架/导入 TXT、WebView 阅读器、划词提问、划线、目录、字号/主题、关键词检索、引用跳转、会话流式输出
- 能力探测：启动时探针检测 op-sqlite FTS5；不可用时自动降级到 `rag_lexical` + JS BM25
- 流式：优先 `expo/fetch`，失败自动切 XHR SSE（无新增依赖）
- 持久化：阅读进度/locator、书架、会话与引用快照、划线、设置均落库；密钥仅存 SecureStore
- 导入仅接受 UTF-8/UTF-16 TXT（≤50MB）；GBK 明确报错，留待 M1
- Vitest 单测 313 个；`npx tsc --noEmit` 与 Android JS bundle 导出通过

真机验收项见 [`../docs/m0-b-verification.md`](../docs/m0-b-verification.md)。当前环境无 Android 设备/模拟器，飞行模式阅读、重启持久化等设备侧结果仍需按清单执行。EPUB、Memory 设置页、M1+ 功能仍待后续里程碑；Expo Go 不可用，必须使用 dev build。

## 常用命令

```bash
npm install
npm test              # Vitest 单测
npm run typecheck     # tsc --noEmit
npm run eval          # P1-6 live 评测（读取 .env.eval.local）
npm run eval:p1-5     # P1-5 真实书笔记/人物分析（可用 P15_BOOK=bainian|chanhui 筛选）
npx expo start        # 启动 Metro（M0-B 起需 dev build）
npx expo run:android --device
npx expo export --platform android --output-dir /tmp/aread-export  # 无设备时校验 bundle
```

## 评测

`npm run eval` 会读取项目目录下被 git 忽略的 `mobile/.env.eval.local`：

```bash
cp .env.eval.example .env.eval.local
# 填入 OpenAI 兼容的 chat/embedding 配置
# EVAL_RERANK_MODEL 可选，复用 Embedding Base URL/Key；留空不启用
```

报告写入 `evals/reports/latest.md` 与 `latest.json`（均不提交）。密钥只保存在本地 env 文件，不会进入代码或报告。

## 目录

```
app/                  # expo-router 页面：onboarding、书架、设置、阅读器、书籍详情、搜索、会话
src/components/       # 通用 UI、ProviderForm、书卡、导入进度
src/core/             # rag / llm / agent / conversation / embedding / orchestrator / import 纯逻辑
src/db/               # schema、migrations、op-sqlite 适配器、repositories
src/reader/           # locator、进度换算、阅读器 HTML
src/services/         # 导入、索引、检索、chat 流式、诊断、provider 测试、备份
src/stores/           # Zustand 应用状态（初始化、FTS5、阅读偏好）
src/navigation/       # 路由跳转封装
evals/                # P1-5/P1-6 数据集、评测执行器、报告（reports 已忽略）
__tests__/            # Vitest 单测
```
