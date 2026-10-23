# Android 本地优先 AI 阅读助手 — 开发交接方案（v1 定稿）

> 版本：v1.0
> 日期：2026-10-23
> 仓库：`E:\BaiduNetdiskDownload\trae02airead`
> 分支：`qoder/android-app`（从 `qoder/chatpage` 新建）
> 代码位置：仓库根目录下新建 `mobile/`
> 用途：新开发对话的完整交接文档，可整份作为提示词使用

---

## 0. 任务目标

把现有 Web 版 AI 阅读助手，重建为 **Android 本地优先 App**：书籍、索引、会话、笔记、记忆全部存在用户设备上；不设账号、不设服务器、不做云同步。用户自带 LLM 和 Embedding API Key。

目标用户：中文长文本精读人群（学生、研究者、知识工作者）。核心价值不是“和 PDF 聊天”，而是“**把一本书读完，并沉淀成自己的笔记和可检索的记忆**”。

## 1. 已锁定决策（不可改）

| 项 | 决策 |
|---|---|
| 平台 | 只做 Android；M0-B 起用真机（或模拟器）验证 |
| 形态 | React Native + Expo **dev build**（不能用 Expo Go，op-sqlite 需要原生模块） |
| 阅读格式 | TXT + EPUB；PDF 不做；DRM EPUB 直接拒绝 |
| 对话模型 | **一个自定义 OpenAI 兼容端点**：Base URL + API Key + Model，只保留一套配置 |
| 向量化 | **一个自定义 OpenAI 兼容 Embedding 端点**，用户自带 Key，统一 1024 维 |
| 向量模型 | 整个书库统一一个模型；换模型触发全库重建；只接受 1024 维；不做自动兜底 |
| 重排 | 向量模型设置下可选 Rerank Model，复用 Embedding 的 Base URL/API Key；留空即不启用 |
| 数据 | 纯本地 SQLite；不做 Web 版数据迁移；但必须做 App 内备份导出/导入 |
| 加密 | v1 不做数据库加密、不做应用锁；Key 必须存 SecureStore，关闭 Android 自动备份 |
| 会话 | 本书会话（默认）+ 独立书库会话（跨书检索） |
| 记忆 | 长期记忆全局共享，设置页可见、可逐条删除 |
| AI 生成任务 | 读书笔记 + 人物关系分析，结果缓存、可重新生成、可导出 |
| 代码位置 | 当前仓库新建 `mobile/` 子目录，Web 版保持不动 |
| 分支 | 从当前 `qoder/chatpage` 新建 `qoder/android-app` |
| 不做 | 账号、云同步、服务端、PDF、数据库加密、多 embedding 模型、Web 数据迁移、通用聊天、多套提供商预设/自动兜底 |

## 2. 现有代码库与复用边界

仓库：`E:\BaiduNetdiskDownload\trae02airead`，Node.js + Express + better-sqlite3 的 Web 版，当前分支 `qoder/chatpage`。

| 文件 | 用途 | 移动端处理 |
|---|---|---|
| `rag.js` | 分块、分词、BM25、RRF 融合、向量召回 | `chunkText`、`tokenize`、`rrfFuse` 直接移植；`BM25Index` 换 FTS5；`vectorRecall` 重写 |
| `embedding.js` | Embedding 调用、批量、重试、维度校验 | 保留请求/批量/重试/校验逻辑；**删除预置提供商和 auto 解析**，改为单一自定义端点 |
| `llm-client.js` | Chat Completions 封装、流式 | 复用；端点/模型/Key 从设置读取 |
| `conversation.js` | 上下文窗口、滚动摘要、token 估算 | 复用业务逻辑；token 用字符数近似，不打包 gpt-tokenizer |
| `agent.js` | Agent 工具循环 | 复用，DB/文件访问走适配层 |
| `orchestrator.js` | 读书笔记、人物分析任务 | 复用，改为前台执行、可取消、结果缓存 |
| `database.js` | 完整 schema | 以它为蓝本改移动端 schema；删除 `api_keys`、`custom_providers` 两表 |
| `server.js` | 43 个路由与业务编排 | 只参考流程，不移植；拆成 services |
| `auth.js` | 注册登录 | 舍弃，固定 `LOCAL_USER_ID` |
| `public/app.js` | 现有交互与 UI | 只参考交互，UI 全部重写 |

**必须重写、不能靠适配器绕过的**：`sqlite-vec` 的 `MATCH ... k = ?` 语法在移动端不存在，向量召回必须用 JS/原生重写。

## 3. 技术选型（锁定）

- **框架**：React Native + Expo，TypeScript，Hermes，expo-router
- **本地数据库**：`@op-engineering/op-sqlite`（同步 API，接近 better-sqlite3）
- **全文检索**：SQLite FTS5；中文用现有 `tokenize()` 规则预分词（单字 + bigram），存空格分隔的 tokens；不要用 trigram
- **向量存储**：`rag_vectors` 表，float32 BLOB，写入前归一化，检索用点积；按书分片加载
- **阅读器**：TXT 和 EPUB 统一走 WebView；EPUB 用 epub.js 打开 RN 传入的 base64/ArrayBuffer；选区、划线、跳转走 JS bridge
- **流式**：优先 `expo/fetch`；失败则 `react-native-sse`
- **密钥**：`expo-secure-store`
- **状态管理**：Zustand
- **文件与导入**：`expo-file-system`、`expo-document-picker`、`expo-sharing`
- **压缩备份**：JSZip（单文件上限 50MB）
- **测试**：Vitest 做纯逻辑单测；真机做集成验收
- **AI 接口约定**：
  - 对话：`POST {baseUrl}/chat/completions`
  - 向量：`POST {baseUrl}/embeddings`
  - 重排（可选）：`POST {baseUrl}/rerank`，复用向量模型的 Base URL/API Key；请求体 `{ model, query, documents, top_n }`，读取 `results[].index / relevance_score`
  - Base URL 存前缀（如 `https://api.siliconflow.cn/v1`），自动去掉末尾斜杠
  - Embedding 请求体默认只有 `model` 和 `input`；如果配置了可选的 `dimensions` 参数，则一并发送
- **最低版本**：Android 8.0（API 26），targetSdk 35

## 4. 目录结构

```
mobile/
  app/                         # expo-router 页面
    (tabs)/library.tsx         # 书架
    (tabs)/settings.tsx        # 设置
    reader/[bookId].tsx        # 阅读器
    book/[bookId].tsx          # 书籍详情/笔记/索引状态
    chat/[conversationId].tsx  # 会话
  src/
    core/                      # 从 Web 版移植的纯逻辑
      rag/chunk.ts, tokenize.ts, rrf.ts
      llm/client.ts, prompts/
      embedding/client.ts
      conversation/, agent/, orchestrator/
    db/
      adapter.ts               # op-sqlite 适配 better-sqlite3 风格
      schema.ts, migrations.ts
      repositories/
    reader/
      TxtRenderer, EpubRenderer, bridge.ts, locator.ts
    services/
      indexing.ts, retrieval.ts, backup.ts, providers.ts, secureStore.ts
    components/, stores/, theme/
  assets/reader/               # reader.html + epubjs.min.js + jszip.min.js
  __tests__/
```

## 5. 数据模型

保留现有表结构与命名，按移动端增补：

- `users`：只保留一行，id 固定 `LOCAL_USER_ID`
- `books_meta`：新增 `file_uri`、`file_hash`、`char_count`、`index_status`、`index_progress`、`embed_sig`、`embed_dims`
- `rag_chunks`：新增 locator 字段 `loc_kind`、`loc_href`、`loc_start`、`loc_end`
- `rag_vectors`：`chunk_id PK`、`book_id`、`embed_sig`、`dims`、`vector BLOB`，索引 `book_id`
- `rag_fts`：FTS5 独立表 `(chunk_id UNINDEXED, book_id UNINDEXED, tokens)`
- `highlights`：`id`、`book_id`、locator 字段、`selected_text`、`note`、`color`、时间
- `conversations`：新增 `scope TEXT DEFAULT 'book'`（`book` / `library`）；书库会话 `book_id` 为空
- `messages`、`user_memories`、`task_results`、`user_settings`：沿用现有结构
- `index_jobs`：记录 `book_id`、`stage`、`cursor`、`error`、`updated_at`，用于断点续跑
- **`provider_config`**（替代原 `api_keys` + `custom_providers`）：
  - `kind TEXT PRIMARY KEY`（`chat` / `embedding`）
  - `base_url`、`model`、`dims`（embedding 输出固定 1024）、`dimensions_param`（可选，可空）、`rerank_model`（可选，仅 embedding 行；留空不启用）、`masked_key`、`updated_at`
  - 真实 Key 存 SecureStore：`chat_api_key`、`embedding_api_key`
- `embed_sig` = `sha256(base_url + '|' + model + '|' + dimensions_param + '|' + dims)` 的短哈希，用于判断索引是否过期

迁移管理：`PRAGMA user_version` + 顺序 migration 数组。由于不迁移旧数据，从空库开始。

## 6. 核心业务规则

### 6.1 索引状态机

```
pending → chunking → lexical_ready → embedding → ready
                          ↓               ↓
                     可阅读/BM25       partial（可重试）
```

- 到 `lexical_ready` 即可阅读，不等向量
- embedding 每批 10 条，失败块单独标记；重试只补失败块
- App 被杀后可恢复：`index_jobs` 记录进度
- 换 embedding 配置：新 `embed_sig` 向量写入，旧向量保留到每本书重建成功后再清理；检索只查 active `embed_sig`
- 删除书：级联删文件、chunks、FTS、向量、划线、任务结果

### 6.2 定位与引用

- TXT：归一化全文的字符 offset
- EPUB：`{href, start, end}`（spine 文档路径 + 文档内字符 offset）
- 划线、chunk、引用卡片共用同一套 locator
- 点击引用 → 打开书 → 按 locator 滚动并高亮原文
- 禁止用“章节 + 百分比”定位

### 6.3 检索

- 单书：FTS5 Top-10 + 该书向量 Top-10 → RRF
- 书库：FTS5 粗筛 200 条 → 按书分组加载候选向量精排 → RRF
- 向量计算：归一化后点积；单书约 750 块，毫秒级
- 查询 embedding 必须使用当前 active `embed_sig`；不一致直接跳过向量路

### 6.4 会话与记忆

- 本书会话：scope 自动取“选中 / 本章 / 全书”
- 书库会话：跨书回答，引用带书名，点击跳进对应书
- 记忆抽取：每 6 轮用户消息或会话结束异步执行；只存用户偏好/背景/兴趣，不存书内容
- 记忆去重：内容归一化后唯一；注入上限 8 条、总长 500 字
- 设置页展示“AI 对你的了解”，可逐条删除

### 6.5 降级矩阵

| 场景 | 行为 |
|---|---|
| 无网络 | 阅读、划线、BM25 可用；AI 提示离线；索引暂停 |
| 未配置 embedding 端点 | 仅 BM25，书架标“关键词模式” |
| embedding 429 / 超时 | 指数退避，块标记失败，状态 partial |
| LLM 401 | 引导重新配置，不清空对话 |
| 上下文超限 | 自动压缩或裁剪引用块并提示 |
| EPUB DRM | 导入失败并说明原因 |
| 存储不足 | 阻止导入，提供清理入口 |

### 6.6 模型配置（简化版）

设置页只有两块，各一套自定义 OpenAI 兼容配置：

**对话模型**

- Base URL、API Key、Model
- 调用 `POST {baseUrl}/chat/completions`
- 提供“测试连接”

**向量模型**

- Base URL、API Key、Model
- 可选的 `dimensions` 请求参数（默认 1024；填写则随请求发送，留空则不发送）
- **可选的 Rerank Model**：Base URL / API Key 复用向量模型配置；留空即不启用
- 调用 `POST {baseUrl}/embeddings`
- **必须返回 1024 维**；保存前用一条测试文本校验，维度不符直接拒绝并提示
- 启用 Rerank 时调用同一 Base URL 下的 `POST {baseUrl}/rerank`（常见如 `BAAI/bge-reranker-v2-m3`）
- 提供“测试连接”

规则：

- 不内置任何提供商预设，不做自动选择、自动兜底
- Base URL 只存前缀，自动去除末尾 `/`
- 修改对话配置只影响新消息，不触发重建
- 修改向量配置（Base URL / Model / dimensions）会改变 `embed_sig`，提示“需要重建全部索引”，进入重建队列
- 修改 Rerank Model 不改变 `embed_sig`，不触发索引重建；留空则跳过重排
- 占位提示可以写常见端点示例，但代码里不写死
- 若某个端点默认返回非 1024 维（例如部分模型默认 2048 维），在设置里填 `dimensions=1024` 后重新测试

## 7. UI/UX 范围（v1）

- **书架**：网格/列表、封面占位、阅读进度、索引状态徽标、搜索、导入按钮、存储占用
- **阅读器**：TXT/EPUB 渲染、目录、字号/行距/主题、进度恢复、划词菜单（提问/划线/复制/全书搜索）、划线与批注列表
- **对话**：流式输出、停止生成、重试、复制、引用卡片、范围标识、本书/书库会话切换
- **书籍详情**：索引进度与重试、读书笔记、人物关系、导出
- **设置**：对话模型、向量模型、记忆管理、存储管理、备份/恢复、关于
- **首次启动**：配置对话端点（必填）→ 配置向量端点（可跳过，明确提示降级）→ 导入第一本书

## 8. 里程碑与验收

### M0-A：纯逻辑，无需设备（约 2~3 天）

- 创建分支与 `mobile/` 项目，装依赖、写 Expo 配置（不编译）
- 核心逻辑 TS 移植：`chunkText`、`tokenize`、locator、RRF、prompt
- DB schema、migration、op-sqlite 适配器接口层
- 备份 ZIP 格式定义与导入导出纯逻辑
- Vitest 单测：分词、分块、locator、FTS 查询构造、向量排序、RRF、记忆去重
- **验收**：`npm test` 全绿、`tsc --noEmit` 通过；不需要模拟器/真机
- **完成后暂停，向用户汇报，不要直接进入 M0-B 或 M1**

### M0-B：集成，需要设备（约 1~2 天）

- 配置模拟器或真机，跑通 Expo dev build 安装
- 技术验证：op-sqlite 是否带 FTS5；`expo/fetch` 流式是否可用（失败切 `react-native-sse`）
- 导入 TXT、阅读、划词提问、FTS5 检索、引用跳转
- **验收**：飞行模式下能读书；重启 App 后书架、会话、进度都在
- **不得跳过 M0-B 直接进入 M1**

### M1：EPUB 与标注（约 1 周）

- EPUB 导入、目录、章节渲染、图片显示、进度
- 统一 locator；划线持久化；划线与引用都能跳回原文
- **验收**：带图片的真实 EPUB 正常阅读；GBK 编码 TXT 不乱码；DRM EPUB 被拒绝

### M2：向量、跨书与记忆（约 1 周）

- 自定义向量端点配置、全局 `embed_sig`、索引状态机、进度、暂停/恢复
- 向量表、单书向量召回、混合检索、书库会话两阶段检索
- 记忆抽取、设置页可见可删
- **验收**：30 万字书约 1~2 分钟完成索引；跨章节提问答案带正确引用；索引中途杀进程后能续跑；改向量配置后提示重建并成功执行

### M3：产出、备份与打磨（约 3~5 天）

- 读书笔记 + 人物关系任务、缓存、重新生成、导出 Markdown
- ZIP 备份导出/导入、存储管理、删除级联
- 空状态、错误态、onboarding、性能与视觉打磨
- **验收**：导出 → 卸载 → 重装 → 导入后书、笔记、会话恢复；所有降级场景有明确提示

## 9. 测试要求

- **单测**：分词、分块、locator 映射、FTS 查询构造、向量排序、RRF、记忆去重、`embed_sig` 计算
- **端点兼容性**：流式输出、1024 维校验、可选 `dimensions` 参数、401/429 处理、Base URL 末尾斜杠规范化
- **真机用例**：UTF-8 TXT、GBK TXT、大文件 TXT、带图 EPUB、DRM EPUB、无网、错误 Key、索引中断
- FTS5 查询特殊字符（引号、`*`、`-`）必须转义并用参数绑定
- 大文件上限 50MB；EPUB 按章节渲染，避免一次性加载超大 HTML

## 10. 已知风险与验证顺序

1. **自定义端点兼容性**：部分“OpenAI 兼容”服务不支持流式或返回维度不符，必须用“测试连接”提前拦住
2. **op-sqlite + FTS5**：M0-B 第一天验证；若不可用，退化为 SQLite 倒排表 + JS BM25（复用现有算法，持久化 tf/df）
3. **RN 流式**：M0-B 验证 `expo/fetch`；失败切 `react-native-sse`
4. **WebView + epub.js**：M1 第一天验证 base64 载入、图片、选区、locator 映射；失败则改为 JSZip 解析 + 章节 HTML 渲染
5. **Windows 构建**：需要 JDK 17、Android SDK 35、platform-tools；Node 24 若与 Expo 不兼容，切 Node 22 LTS
6. **后台索引**：v1 只做前台执行 + 进度，不依赖 WorkManager
7. **自动备份**：`app.json` 设 `android.allowBackup: false`

## 11. 环境与分支操作

```bash
cd /e/BaiduNetdiskDownload/trae02airead
git status                                  # 若有未提交改动，先提交到 qoder/chatpage
git checkout -b qoder/android-app

npx create-expo-app@latest mobile --template default
cd mobile
npm i @op-engineering/op-sqlite zustand jszip epubjs
npx expo install expo-dev-client expo-secure-store expo-document-picker \
  expo-file-system expo-sharing react-native-webview
npm i -D vitest

# M0-A 阶段不需要 Android SDK；M0-B 再执行：
npx expo run:android --device
```

真机要求：开发者选项 + USB 调试已开启，`adb devices` 能看到设备。Expo Go 不可用，必须 dev build。

## 12. 工作方式

- 开始前先读现有 `rag.js`、`embedding.js`、`llm-client.js`、`conversation.js`、`agent.js`、`orchestrator.js`、`database.js`
- 只新增 `mobile/`，不修改 Web 版行为
- 每个里程碑结束汇报：完成了什么、如何验证、已知问题、需要用户拍板的点
- 不要擅自添加依赖或扩展范围；先问再做
- 每个里程碑单独 commit，提交信息说明范围
- M0-A 完成后必须暂停汇报，不要直接开始 M0-B

## 13. 第一步动作

1. `git status` 确认工作区状态，必要时先提交现有改动
2. 创建并切换到 `qoder/android-app`
3. 初始化 `mobile/`，只执行 **M0-A**：核心逻辑移植、schema/migration、Vitest 单测、备份格式
4. M0-A 完成后汇报结果与实际耗时，等用户确认再进入 M0-B
