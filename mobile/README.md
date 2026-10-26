# AI 阅读助手（Android / Expo）

本地优先的 Android 阅读助手：书籍、索引、会话、笔记、记忆全部存在设备本地；不设账号、服务器与云同步。
完整交接方案见 [`../docs/android-app-spec.md`](../docs/android-app-spec.md)。

## 当前进度

**M1 实现完成，待真机验收（M0-B 一并验收）**

- M0-A/P1 离线核心不变：分块 + locator、FTS5 查询、向量/RRF、Agent 工具、Memory v2、长任务、评测
- M0-B 设备集成：Expo dev build 配置、onboarding、书架/导入、WebView 阅读器、划词提问、划线、目录、字号/主题、关键词检索、引用跳转、会话流式输出
- **M1 EPUB**：自研容错 XML 解析 + JSZip 解压 + 章节级消毒渲染（未采用 epub.js，理由见 `docs/m1-verification.md`）
  - 导入：解析 `container.xml` / OPF / manifest / spine，读元数据（书名、作者），按 spine 分块建索引
  - 阅读：逐章惰性渲染（不一次性加载整本 HTML），上一章/下一章、目录跳转、章内进度
  - 图片：`<img>` / SVG `<image>` 按需读成 `data:` URI，飞行模式下也能显示
  - 目录：EPUB3 `nav` 优先，回退 EPUB2 `toc.ncx`，都没有时按 spine 生成「第 N 节」
  - DRM：`META-INF/rights.xml` 或正文加密直接拒绝；仅字体混淆（IDPF / Adobe）放行
- **M1 统一 locator**：`{kind:'txt'|'epub', href, start, end}`；TXT offset 相对归一化全文，EPUB offset 相对各 spine 文档消毒后的纯文本；划线与引用都按 `href + offset` 跳回原文
- **M1 GBK TXT**：纯 JS GB18030 解码器（内置 65KB 映射表，无 Buffer/TextDecoder 依赖）；控制字符启发式拦截伪 TXT 二进制
- 能力探测：启动时探针检测 op-sqlite FTS5；不可用时自动降级到 `rag_lexical` + JS BM25
- 流式：优先 `expo/fetch`，失败自动切 XHR SSE（无新增依赖）
- 持久化：阅读进度/locator、书架、会话与引用快照、划线、设置均落库；密钥仅存 SecureStore
- 导入上限：TXT ≤50MB，EPUB ≤100MB
- Vitest 单测 389 个；`npx tsc --noEmit` 通过

真机验收项见 [`../docs/m1-verification.md`](../docs/m1-verification.md)（含 M0-B 的清单）。已知限制、与 spec 的偏差说明也记录在该文档。当前环境无 Android 设备/模拟器，设备侧结果仍需按清单执行；Expo Go 不可用，必须使用 dev build。

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
src/core/             # rag / llm / agent / conversation / embedding / orchestrator / import / epub / text 纯逻辑
src/core/epub/        # EPUB：容错 XML 解析、消毒成带 offset 的块、资源路径、OPF/spine、目录
src/core/text/        # 共享文本层：实体解码/转义、字节 ↔ base64 / UTF-8 / UTF-16
src/db/               # schema、migrations、op-sqlite 适配器、repositories
src/reader/           # locator、进度换算、TXT/EPUB 阅读器 HTML（共用一套前端脚本）
src/services/         # 导入、书籍内容、EPUB 内容、索引、检索、chat 流式、诊断、provider 测试、备份
src/stores/           # Zustand 应用状态（初始化、FTS5、阅读偏好）
src/navigation/       # 路由跳转封装
scripts/              # GBK/GB18030 映射表生成脚本
evals/                # P1-5/P1-6 数据集、评测执行器、报告（reports 已忽略）
__tests__/            # Vitest 单测
```
