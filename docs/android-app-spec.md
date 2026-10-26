# Android 本地优先 AI 阅读助手 — 开发交接方案（v1.1）

> 版本：v1.1
> 日期：2026-10-26
> 仓库：`1431529361/aread`
> 源分支：`qoder/android-app`
> 当前产出分支：`qoder/general-session-4r5ung`
> 代码位置：`mobile/`
> 当前状态：M2 实现完成，M0-B/M1/M2 待 Android 真机验收；M3 未开始
> 用途：实现约束、验收基线与后续交接

---

## 0. 任务目标

把现有 Web 版 AI 阅读助手重建为 **Android 本地优先 App**：书籍、索引、会话、笔记、记忆默认保存在用户设备上；不设账号、不设自有服务器、不做云同步。用户自带 LLM 和 Embedding API Key。使用 AI 功能时，必要的对话、查询和书籍片段会发送到用户配置的第三方模型端点，因此“本地优先”不等于“内容从不离开设备”。

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
| 长任务上下文 | chat 设置可选 `context_window`（默认 200000）；单次预算 = min(context_window × 0.6, 100000)，超限自动走分层 map-reduce |
| 数据 | 纯本地 SQLite；不做 Web 版数据迁移；M3 必须做 App 内备份导出/导入 |
| 网络隐私 | 模型调用只允许 HTTPS；内容仅发送到用户配置的第三方端点，界面必须明确披露发送范围 |
| 加密 | v1 不做数据库加密、不做应用锁；Key 存 SecureStore，关闭 Android 自动备份；Key 会随请求发送到所配置端点鉴权 |
| 会话 | 本书会话（默认）+ 独立书库会话（跨书检索） |
| 记忆 | 长期记忆全局共享，设置页可见、可逐条删除 |
| AI 生成任务 | 读书笔记 + 人物关系分析，结果缓存、可重新生成、可导出 |
| 代码位置 | 当前仓库新建 `mobile/` 子目录，Web 版保持不动 |
| 分支 | 源分支 `qoder/android-app`；当前产出分支 `qoder/general-session-4r5ung` |
| 不做 | 账号、云同步、服务端、PDF、数据库加密、多 embedding 模型、Web 数据迁移、通用聊天、多套提供商预设/自动兜底 |

## 2. 现有代码库与复用边界

仓库：`1431529361/aread`。移动端位于 `mobile/`，Web 版保持不变。源分支为 `qoder/android-app`；当前工作发布到会话指定的产出分支，不回写源分支。

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
- **向量存储**：`rag_vectors` 表，归一化 float32 BLOB；按书加载；`rag_book_vectors` 保存当前 sig 的书级 centroid 用于跨书路由
- **阅读器**：TXT 和 EPUB 统一走 WebView；EPUB 由自研容错 XML/OPF/spine 解析器 + JSZip 解包，按章节消毒后惰性渲染
- **流式**：优先 `expo/fetch`；失败切到内置 XHR SSE 解析，不增加 SSE 依赖
- **密钥**：`expo-secure-store`
- **状态管理**：Zustand
- **文件与导入**：`expo-file-system`、`expo-document-picker`、`expo-sharing`
- **备份（M3 设计）**：流式或原生 ZIP；禁止用 JSZip 把整库和 100MB EPUB 一次性读入内存
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
    core/                      # RAG / LLM / Agent / 对话 / EPUB / 文本纯逻辑
    db/                        # adapter、schema、migrations、repositories
    reader/                    # locator、阅读器 HTML、WebView bridge
    services/                  # 导入、索引、检索、chat、诊断、provider；M3 增加 backup
    components/, stores/, theme/
  __tests__/
```

## 5. 数据模型

保留现有表结构与命名，按移动端增补：

- `users`：只保留一行，id 固定 `LOCAL_USER_ID`
- `books_meta`：新增 `file_uri`、`file_hash`、`char_count`、`index_status`、`index_progress`、`embed_sig`、`embed_dims`
- `rag_chunks`：locator 字段 `loc_kind`、`loc_href`、`loc_start`、`loc_end`，另有 `parent_index`
- `rag_vectors`：`chunk_id`、`book_id`、`embed_sig`、`dims`、`vector BLOB`；主键必须是 `(chunk_id, embed_sig)`，索引 `(book_id, embed_sig)`，以允许配置切换期间新旧向量共存
- `rag_book_vectors`：`book_id`、`embed_sig`、`dims`、`vector BLOB`；主键 `(book_id, embed_sig)`，保存书内全部 chunk 向量的归一化 centroid
- `rag_fts`：FTS5 独立表 `(chunk_id UNINDEXED, book_id UNINDEXED, tokens)`；设备无 FTS5 时降级到 `rag_lexical` + JS BM25
- `highlights`：`id`、`book_id`、locator 字段、`selected_text`、`note`、`color`、时间
- `conversations`：新增 `scope TEXT DEFAULT 'book'`（`book` / `library`）；书库会话 `book_id` 为空
- `messages`、`user_memories`、`task_results`、`user_settings`：沿用现有结构
- `index_jobs`：记录 `book_id`、`stage`、`cursor`、`error`、`updated_at`，用于断点续跑
- **`provider_config`**（替代原 `api_keys` + `custom_providers`）：
  - `kind TEXT PRIMARY KEY`（`chat` / `embedding`）
  - `base_url`、`model`、`dims`（embedding 输出固定 1024）、`dimensions_param`（可选，可空）、`rerank_model`（可选，仅 embedding 行；留空不启用）、`context_window`（可选，仅 chat 行，默认 200000）、`masked_key`、`updated_at`
  - 真实 Key 存 SecureStore：`chat_api_key`、`embedding_api_key`
- `embed_sig` = `sha256(base_url + '|' + model + '|' + dimensions_param + '|' + dims).slice(0, 16)`；Base URL 先规范化，用于判断索引是否过期

迁移管理：`PRAGMA user_version` + 顺序 migration 数组。当前 schema v8；每个 migration 与 `user_version` 更新必须在同一事务中执行。

## 6. 核心业务规则

### 6.1 索引状态机

```
pending → chunking → lexical_ready → embedding → ready
                          ↓               ↓
                     可阅读/BM25       partial（可重试）
```

- 到 `lexical_ready` 即可阅读，不等向量
- embedding 每批 10 条，批次成功即持久化；失败后续跑只查询当前 sig 缺失的 chunk
- 同一进程内同一本书只允许一个索引任务；全库重建与单书重试共用同一互斥入口
- 每批开始前及最终提交事务内重新计算当前 provider 配置的 `embed_sig`；配置变化立即停止旧任务
- App 被杀后可恢复：已写入向量是续跑事实来源，`index_jobs` 记录状态、进度和错误
- 换 embedding 配置：新 `embed_sig` 向量写入，旧向量保留到该书重建成功；书级 centroid 写入、旧 chunk/书级向量清理、`books_meta` active sig 切换和任务完成状态必须在同一事务内
- 删除书：级联删文件、chunks、FTS/降级词法索引、chunk 向量、书级向量、划线和任务结果

### 6.2 定位与引用

- TXT：归一化全文的字符 offset
- EPUB：`{href, start, end}`（spine 文档路径 + 文档内字符 offset）
- 划线、chunk、引用卡片共用同一套 locator
- 点击引用 → 打开书 → 按 locator 滚动并高亮原文
- 禁止用“章节 + 百分比”定位
- 当前 locator/文本归一化规则定义为 v1，并随数据库 schema 版本管理；未来若改变消毒或归一化算法，必须迁移旧 locator 或保留 v1 解释器，禁止用新规则直接解释旧 offset

### 6.3 检索

- 单书：FTS5 Top-20 + 该书向量 Top-20 → RRF；任一路失败时使用另一路
- 书库：FTS5 Top-200 与语义路由并行。语义路先将查询向量与 `rag_book_vectors` 比较，选择正相似度最高的 8 本书，再加载这些书及 FTS 命中书的 chunk 向量，每书 Top-20、全局最多 100 条，最后 RRF
- 无关键词命中时仍必须执行书级语义路由；不得恢复为“FTS 是向量召回前置条件”
- 向量计算：写入前归一化、检索用点积；纯向量候选只保留正相似度，避免零/负相关块占据 Top-K
- 查询 embedding、书级向量和 chunk 向量必须使用同一 active `embed_sig` 和 dims；状态不是 `ready` 的半成品向量不得参与检索
- schema v8 前已 ready 的书允许首次检索时懒补书级 centroid；后续索引完成时直接事务写入

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

### 6.6 隐私与传输边界

- 本地保存：原始书籍、SQLite 数据、索引、会话、划线、任务结果和记忆默认只存设备；App 不提供账号、自有后端或云同步
- 对话请求：会把用户消息、必要历史、长期记忆和检索到/选中的原文片段发送到用户配置的 Chat 端点
- Embedding 请求：建索引时发送书籍分块；检索时发送查询文本
- Rerank 请求：启用后发送查询和候选原文片段；该 `/rerank` 协议不是 OpenAI 标准，只承诺兼容文档约定的请求/响应格式，失败回退 RRF
- API Key 仅持久化在 SecureStore，但会作为鉴权头发送到用户配置的端点；数据库只保存掩码
- Base URL 必须使用 HTTPS。错误、诊断、测试报告和日志不得记录 Key、Authorization 头、完整请求体或完整书籍原文
- onboarding 和设置页必须在用户配置端点前披露以上边界，不得使用“不上传服务器”等误导文案

### 6.7 模型配置（简化版）

设置页只有两块，各一套自定义 OpenAI 兼容配置：

**对话模型**

- Base URL、API Key、Model
- 可选 `context_window`（默认 200000；用于读书笔记/人物分析等长任务的上下文预算）
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
- Base URL 只接受 `https://` 前缀，自动去除末尾 `/`
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

自动化实现状态不等于设备验收状态。M0-A 已完成；M0-B、M1、M2 已实现但仍须按 `docs/m1-verification.md`、`docs/m2-verification.md` 在 Android dev build 真机回归；当前不得进入 M3 实现。

### M0-A：纯逻辑（已完成）

- 初始化 `mobile/` 项目与 Expo 配置
- 核心逻辑 TS 移植：`chunkText`、`tokenize`、locator、RRF、prompt
- DB schema、migration、op-sqlite 适配器接口层
- 备份 ZIP 格式原型与纯逻辑测试（不代表 M3 大规模生产实现）
- Vitest 单测：分词、分块、locator、FTS 查询构造、向量排序、RRF、记忆去重
- **验收**：`npm test` 与 `tsc --noEmit` 通过

### M0-B：设备集成（已实现，待真机验收）

- 配置模拟器或真机，跑通 Expo dev build 安装
- 技术验证：op-sqlite FTS5；不可用降级 SQLite 倒排表 + JS BM25；`expo/fetch` 流式失败切 XHR SSE
- 导入 TXT、阅读、划词提问、FTS5/降级检索、引用跳转
- **真机验收**：飞行模式下能读书；重启 App 后书架、会话、进度都在

### M1：EPUB 与标注（已实现，待真机验收）

- EPUB 导入、目录、章节渲染、图片显示、进度
- 统一 locator；划线持久化；划线与引用都能跳回原文
- **验收**：带图片的真实 EPUB 正常阅读；GBK 编码 TXT 不乱码；DRM EPUB 被拒绝

### M2：向量、跨书与记忆（已实现，待真机验收）

- 自定义向量端点配置、全局 `embed_sig`、索引状态机、进度、暂停/恢复
- chunk 向量表、书级 centroid 路由、单书混合检索、无关键词命中的跨书语义召回、书库会话
- 记忆抽取、设置页可见可删
- **验收**：在第 9 节固定条件下验证 30 万字书索引目标约 1～2 分钟；跨章节与无关键词跨书提问带正确引用；杀进程后能续跑；改向量配置不会发生旧任务覆盖

### M3：产出、备份与打磨（未开始）

- 读书笔记 + 人物关系任务、缓存、重新生成、导出 Markdown
- 将现有 JSZip 内存版 `backup.ts` 视为格式原型，不直接接入生产 UI；改用经 Expo SDK 58/Android 验证的流式或原生 ZIP 方案，逐文件读写，支持单个 100MB EPUB 和多书库
- manifest 至少记录格式版本、DB schema、每个文件的相对归档路径、大小和 SHA-256；导入前校验 ZIP 路径、防目录穿越、条目重复、总解压大小和校验和
- 恢复时解压到临时目录，校验数据库与文件后重写 `books_meta.file_uri` 为新私有目录；关闭 DB，原子替换数据库/书籍目录，失败回滚，成功后再清理旧目录
- 默认不导出 SecureStore 中的 API Key；恢复后要求用户重新配置或沿用本机 Key
- 存储管理、删除级联、空状态、错误态、性能与视觉打磨
- **验收**：至少覆盖“1 个 100MB EPUB + 多本书 + 大于 50MB 数据库”的导出/恢复；卸载重装后书、索引、会话、划线、记忆可用，引用 locator 正确；损坏/恶意备份不能污染现有数据

## 9. 测试要求

- **自动化**：分词、分块、locator、FTS 转义、向量排序/RRF、书级 centroid 路由、无 FTS 语义召回、`embed_sig`、中断续跑、配置切换竞态、migration
- **端点兼容性**：Chat/XHR SSE、Embedding 1024 维、可选 `dimensions`、非标准 Rerank 成功与回退、401/429/超时、HTTPS 和 Base URL 规范化
- **真机功能**：UTF-8/UTF-16/GBK TXT、50MB TXT、带图/目录/DRM EPUB、无网、错误 Key、索引暂停、杀进程续跑、配置切换、跨书引用跳转
- **可复现性能基线**：固定测试设备/Android 版本、release/dev build 类型、书籍 SHA-256/格式/字符数、chunk 数、端点/模型/网络、冷启动与重复次数；分别记录索引总耗时、请求批次数、峰值内存、无 FTS 跨书检索延迟 p50/p95。目标“30 万字 1～2 分钟”只在以上条件齐全时判定
- **安全**：FTS 特殊字符参数绑定；Base URL 拒绝 HTTP；错误和报告不含 Key/Authorization/完整原文；M3 备份另测路径穿越、ZIP bomb 上限、校验失败与原子回滚
- **大文件**：TXT ≤50MB、EPUB ≤100MB；EPUB 按章节渲染，禁止一次性加载整本 HTML

完成前必须运行：

```bash
cd mobile
npx tsc --noEmit
npx vitest run
npm run lint -- --no-cache
npx expo export --platform android --output-dir /tmp/aread-export
```

## 10. 已知风险与验证顺序

1. **真机基线未完成**：M0-B/M1/M2 的自动化和 Hermes bundle 已通过不代表 op-sqlite、WebView、文件 URI、内存和网络行为已在目标设备通过，必须先执行真机清单
2. **自定义端点兼容性**：OpenAI 兼容通常只覆盖 Chat/Embedding；`/rerank` 是扩展协议，必须实测，失败时回退原排序
3. **书级 centroid 的召回损失**：它避免全库 chunk 扫描，但主题高度分散的书可能被均值稀释；以无关键词测试集记录 recall，必要时在后续版本改为每书多 centroid，不在 M2 临时扩展
4. **跨书内存与延迟**：路由默认 8 本、每书 20 条、全局 100 条；用目标规模书库记录 p50/p95 和峰值内存后再调常量
5. **前台索引**：v1 不依赖 WorkManager；系统杀进程后靠已持久化 chunk 向量续跑，不保证后台持续执行
6. **locator 漂移**：改变 EPUB 消毒或 TXT 归一化会使旧 offset 失效，必须执行 v1 兼容或数据迁移
7. **备份规模与原子性**：现有 JSZip helper 只用于格式原型；M3 未完成流式、路径重写、校验与回滚前，不得宣称支持备份
8. **隐私与第三方处理**：App 无自有服务器，但用户配置端点会接收书籍片段和对话；发布前复核 UI 披露、HTTPS 与日志脱敏
9. **Android 自动备份**：保持 `app.json` 的 `android.allowBackup: false`

## 11. 当前环境与分支

```bash
cd <workspace>/aread
git switch qoder/general-session-4r5ung
cd mobile
npm ci
```

- Expo SDK 58、React Native 0.88、Hermes、Android minSdk 26 / targetSdk 35
- Expo Go 不可用；设备验收必须使用 dev build
- 源分支 `qoder/android-app` 作为输入；完成内容提交并推送到 `qoder/general-session-4r5ung`
- 当前环境没有 Android 设备/模拟器时，只能完成自动化与 Hermes export，不能把它表述为真机通过

## 12. 工作方式

- 修改前读取相关实现、测试与 `mobile/AGENTS.md`，复用现有架构和依赖
- 保持 Web 版行为不变；只修改 `mobile/` 和对应文档
- 每个里程碑分别报告实现、自动化验证、真机验证和已知风险，不混淆这些证据
- 不记录或提交 API Key、端点请求体、真实书籍原文和本地评测配置
- M2 完成后先执行 M0-B/M1/M2 真机验收；未经用户确认不进入 M3 实现

## 13. 当前下一步

1. 在 Android dev build 执行 `docs/m1-verification.md` 和 `docs/m2-verification.md`
2. 记录固定设备、测试书、端点、网络与性能数据，验证无关键词跨书语义召回和配置切换竞态
3. 真机问题回修并重新运行第 9 节全量命令
4. 用户确认后再单独开始 M3；备份必须采用第 8 节的流式、校验和原子恢复设计
