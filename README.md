# AI 阅读助手 (AI Reading Assistant)

一个现代化的智能阅读应用，集成多 AI 服务提供商，帮助用户高效阅读和理解书籍内容。支持在线阅读、AI 智能问答、书架管理、自定义 AI 提供商等功能。

## 特性

### 📖 智能阅读

- **在线阅读**：支持 TXT 文件在线阅读，预置《百年孤独》经典章节作为示例
- **编码自动检测**：自动检测文件编码（UTF-8、GBK、GB2312、BIG5 等），解决中文乱码问题
- **文章目录**：自动生成章节目录，支持快速导航
- **个性化设置**：
  - 字体大小调节（12px - 28px）
  - 三种主题模式：明亮 / 暗黑 / 护眼
  - 选中文本浮动工具栏

### 🤖 AI 智能问答

- **快捷操作**：选中文本后弹出工具栏，支持解释说明、总结概括、翻译、扩展阅读
- **自定义问题**：输入自定义问题，AI 结合书籍上下文提供精准回答
- **流式输出**：SSE 流式传输，打字机效果，提升阅读体验
- **模型显示**：回答中实时显示当前使用的 AI 提供商和模型信息
- **对话历史**：自动保存最近 50 条问答记录，随时回顾

### 🧠 Agent 智能体

- **Function Calling 工具 Agent**：开启"Agent 模式"后，AI 自主决定调用工具查阅全书内容，而非仅依赖选中文本
  - 内置 5 个工具：`searchInBook`（全书检索）、`getChapterInfo`（章节内容）、`summarizeSection`（摘要）、`translateText`（翻译）、`lookupCharacter`（人物查找）
  - ReAct 风格多轮工具调用循环（思考→调用工具→观察结果→再推理）
  - 实时展示 Agent 思考链与工具调用 trace
- **RAG 检索增强**：为书籍建立智能索引，实现"全书级"问答
  - 章节边界 + 滑动窗口分块
  - BM25 关键词检索（默认，纯 JS 无依赖）+ 可选 Embedding 向量召回
  - 向量索引持久化，支持跨会话复用
- **Multi-Agent 任务编排**：复杂阅读任务自动拆解为子 Agent 并行执行
  - 读书笔记生成：大纲 → 逐章并行摘要 → 批判性点评 → 整合输出
  - 人物关系分析：人物检测 → 并行人物分析 → 关系图谱整合
  - DAG 拓扑排序并行调度，节点失败自动降级
- **安全防护**：最大 8 轮工具调用 + 单工具 5 次熔断，防止死循环；模型不支持 Function Calling 时自动降级为普通问答

### 📚 书架管理

- **多格式支持**：TXT、PDF、EPUB、MOBI（最大 50MB）
- **上传进度**：实时显示上传进度条
- **书籍操作**：在线阅读（TXT）、下载、删除
- **AI 智能任务**（TXT）：一键建立 RAG 索引、生成读书笔记、人物关系分析
- **数据隔离**：每个用户的书籍、书架、阅读进度完全独立

### 👤 用户系统

- **注册登录**：支持用户名+密码注册登录，用户名支持中文
- **JWT 认证**：登录后自动保持登录状态（7天），支持"记住我"（30天）
- **密码安全**：bcrypt 加密存储，不保存明文密码
- **数据隔离**：每个用户的 API 密钥、自定义提供商、书架、问答历史完全独立
- **历史同步**：AI 问答历史存储在服务器端，换设备也能查看

### 🔧 自定义 AI 提供商

- **灵活添加**：支持添加任意 OpenAI 兼容 API
- **模型管理**：可配置默认模型和可选模型列表
- **一键切换**：在已添加的提供商之间快速切换
- **独立存储**：每个提供商的 API 密钥独立加密存储

### 🎨 现代化 UI 设计

- **卡片式布局**：圆角卡片、渐变背景、阴影层次
- **流畅动画**：按钮悬浮效果、面板滑入、淡入淡出
- **统一滚动条**：自定义美化滚动条样式
- **响应式设计**：适配不同屏幕尺寸

## 技术栈

| 类别 | 技术 |
|------|------|
| 后端 | Express.js 4.18.2 |
| 前端 | 原生 JavaScript (ES6+) |
| 数据库 | SQLite (sql.js - 纯 JS 实现，无需 C++ 编译) |
| 用户认证 | JWT (jsonwebtoken) |
| 密码加密 | bcryptjs |
| 文件上传 | Multer |
| 编码检测 | jschardet + iconv-lite |
| 密钥加密 | crypto (AES-256-CBC) |
| 环境变量 | dotenv |
| AI 接口 | OpenAI 兼容 API (SSE 流式) |
| Agent 引擎 | Function Calling + ReAct 循环（[agent.js](agent.js)） |
| RAG 检索 | BM25 + 可选 Embedding 向量召回（[rag.js](rag.js)） |
| 多 Agent 编排 | DAG 拓扑排序并行调度（[orchestrator.js](orchestrator.js)） |

## 快速开始

### 环境要求

- Node.js >= 18.0.0
- npm >= 9.0.0

### 🚀 零配置启动

```bash
# 1. 克隆项目
git clone <your-repo-url>
cd trae02airead

# 2. 安装依赖并启动
npm install
npm start
```

然后打开 http://localhost:3000 即可使用！

> **零配置**：所有配置都有默认值，无需手动配置即可启动。所有密钥（API Key）都通过 UI 填写，无需写在配置文件中。

### 开发模式

```bash
npm run dev
```

## 注意事项

1. 上传文件最大 50MB
2. 流式输出使用 SSE，需浏览器支持
3. 建议定期备份 data.db 数据库文件
4. 如需持久化保存 API 密钥，可配置 `ENCRYPTION_KEY` 环境变量（固定密钥，重启后不会丢失）

### 环境变量配置（可选）

如需配置，可在 `.env` 文件中设置：

```env
# 固定加密密钥（可选，不配置则每次启动自动生成）
ENCRYPTION_KEY=your_64_char_hex_key

# AI 提供商 API Key（可选，也可直接在 UI 中配置）
ZHIPU_API_KEY=your_zhipu_key
SILICONFLOW_API_KEY=your_siliconflow_key
CUSTOM_API_KEY=your_custom_key

# 服务端口（默认 3000）
PORT=3000
```

### AI 提供商配置

#### 内置提供商

| 提供商 | API 端点 | 默认模型 | 特点 |
|--------|----------|----------|------|
| 智谱 AI | `https://open.bigmodel.cn/api/paas/v4/chat/completions` | `glm-4.5-air` | 国产优选 |
| 硅基流动 | `https://api.siliconflow.cn/v1/chat/completions` | `deepseek-ai/DeepSeek-V4-Flash` | 新用户送代金券 |

#### 自定义提供商

1. 在设置页面选择"➕ 自定义"标签
2. 填写配置信息：
   - **显示名称**：如 OpenAI、DeepSeek、Moonshot
   - **API 地址**：完整的聊天补全 API 地址
   - **默认模型**：如 `gpt-4`、`deepseek-chat`
   - **可选模型列表**（选填）：JSON 格式
   - **API 密钥**：提供商的 API Key（也可通过环境变量 `CUSTOM_API_KEY` 配置）
3. 点击"添加提供商"保存
4. 添加后可选择该提供商并切换不同模型

> **提示**：自定义提供商的 API 密钥也可以通过环境变量 `CUSTOM_API_KEY` 配置，这样无需在 UI 中输入。

```json
// 可选模型列表示例
[
  {"id": "gpt-4", "name": "GPT-4"},
  {"id": "gpt-3.5-turbo", "name": "GPT-3.5 Turbo"}
]
```

## Agent 智能体使用指南

### 1. Agent 模式问答（工具调用）

在阅读页打开 AI 面板，开启顶部的 **"Agent 模式"** 开关后提问：

- Agent 会自主判断是否需要调用工具（如检索全书其他章节）
- trace 区实时展示思考链、工具调用参数与返回结果
- 若问题可直接基于选中文本回答，Agent 不会调用工具，直接输出答案

> **模型要求**：需所配置模型支持 Function Calling（如 GLM-4 系列、DeepSeek 等）。不支持时自动降级为普通流式问答，不影响使用。

### 2. RAG 智能索引

在书架的 TXT 书籍卡片上点击 **"AI索引"** 按钮：

- 系统按章节边界 + 滑动窗口将全书分块
- 默认使用 BM25 关键词检索（纯 JS，无外部依赖）
- 若提供商支持 Embedding（智谱 / 硅基流动），自动升级为向量检索，召回更精准
- 索引持久化到 `rag_index/<userId>/<bookId>.json`，跨会话可复用
- 建立索引后，Agent 模式中的 `searchInBook` 工具会优先使用该索引

### 3. Multi-Agent 任务

在书架的 TXT 书籍卡片上点击 **"读书笔记"** 按钮，或调用 `/api/agent/task` 接口：

- **读书笔记生成**（`generate-notes`）：大纲 Agent → 逐章并行摘要 Agent → 点评 Agent → 整合 Agent，输出完整 Markdown 读书笔记
- **人物关系分析**（`character-analysis`）：人物检测 Agent → 并行人物分析 Agent → 关系整合 Agent，输出人物关系图谱

任务执行过程中，弹窗实时展示各子 Agent 的启动/进度/完成状态，最终结果以 Markdown 渲染呈现。

### Agent 工具说明

| 工具 | 功能 | 触发场景 |
|------|------|----------|
| `searchInBook` | 全书 RAG 检索相关段落 | 问题超出选中文本范围 |
| `getChapterInfo` | 获取指定章节内容 | 需查阅特定章节 |
| `summarizeSection` | 总结指定文本 | 用户想快速了解大段内容 |
| `translateText` | 翻译文本 | 跨语言理解需求 |
| `lookupCharacter` | 查找人物出场上下文 | 人物形象/关系分析 |

## 文件编码支持

系统自动检测 TXT 文件编码，支持：

- UTF-8（含 BOM）
- GBK / GB2312 / GB18030
- BIG5
- UTF-16LE / UTF-16BE

## API 接口文档

### 用户认证

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/auth/register` | 注册新用户（username + password） |
| POST | `/api/auth/login` | 用户登录，返回 JWT token |
| GET | `/api/auth/me` | 获取当前登录用户信息 |

> 除注册和登录外，所有 API 接口均需在请求头携带 `Authorization: Bearer <token>`

### AI 问答

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/ask` | 非流式 AI 问答 |
| POST | `/api/ask-stream` | 流式 AI 问答（SSE） |

### Agent 智能体

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/agent/stream` | Function Calling Agent 流式问答（SSE，推送思考链/工具调用/最终答案） |
| GET | `/api/agent/tasks` | 获取可用的 Multi-Agent 任务列表 |
| POST | `/api/agent/task` | 执行 Multi-Agent 任务（SSE，推送节点进度与最终结果） |

**Agent 流式事件类型**（`/api/agent/stream` 返回的 SSE data）：

| 事件 type | 含义 |
|-----------|------|
| `start` | Agent 启动，返回模型/提供商信息 |
| `thought` | Agent 中间思考内容 |
| `tool_call` | 发起工具调用（含工具名、参数、轮次） |
| `tool_result` | 工具执行结果（含耗时） |
| `fallback` | 模型不支持 Function Calling，降级为普通问答 |
| `final_start` | 进入最终答案流式输出 |
| `chunk` | 最终答案文本片段 |
| `end` | Agent 结束 |

**Multi-Agent 任务类型**（`/api/agent/task` 的 `taskType`）：

| taskType | 任务 | DAG 节点 |
|----------|------|----------|
| `generate-notes` | 读书笔记生成 | 大纲 → 并行摘要 → 点评 → 整合 |
| `character-analysis` | 人物关系分析 | 人物检测 → 并行分析 → 关系整合 |

### 密钥管理

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/key/status` | 获取各提供商密钥状态 |
| POST | `/api/key/set` | 设置指定提供商的 API 密钥 |
| POST | `/api/key/verify` | 验证 API 密钥 |
| DELETE | `/api/key` | 删除指定提供商的 API 密钥 |

### 提供商管理

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/providers` | 获取可用提供商列表和模型 |
| POST | `/api/providers` | 添加自定义提供商 |
| PUT | `/api/providers/:id` | 更新自定义提供商 |
| DELETE | `/api/providers/:id` | 删除自定义提供商 |

### 书籍管理

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/books` | 获取用户书籍列表 |
| POST | `/api/books/upload` | 上传书籍 |
| GET | `/api/books/:bookId` | 获取书籍内容和元数据 |
| GET | `/api/books/:bookId/download` | 下载书籍 |
| DELETE | `/api/books/:bookId` | 删除书籍 |
| PUT | `/api/books/:bookId/progress` | 保存阅读进度 |
| POST | `/api/books/:bookId/index` | 建立 RAG 智能索引（仅 TXT） |
| GET | `/api/books/:bookId/index-status` | 查询 RAG 索引状态 |
| DELETE | `/api/books/:bookId/index` | 删除 RAG 索引 |

## 项目结构

```
trae02airead/
├── server.js              # Express 后端主服务
├── database.js            # SQLite 数据库封装 (sql.js)
├── auth.js                # 用户认证中间件
├── agent.js               # Function Calling Agent 引擎（ReAct 循环 + 工具调用）
├── rag.js                 # RAG 检索增强（分块 + BM25 + 可选 Embedding）
├── orchestrator.js        # Multi-Agent DAG 编排引擎
├── package.json           # 项目依赖配置
├── .env                   # 环境变量配置
├── .gitignore             # Git 忽略配置
├── README.md              # 项目文档
│
├── public/                # 前端静态资源
│   ├── index.html         # 主页面
│   ├── styles.css         # 样式表
│   └── app.js             # 前端逻辑
│
├── books/                 # 书籍文件存储（运行时）
│   └── {userId}/
│
├── rag_index/             # RAG 向量索引存储（运行时）
│   └── {userId}/{bookId}.json
│
├── data.db                # SQLite 数据库文件（运行时生成）
└── node_modules/          # 依赖包
```

## 安全说明

1. **密钥加密**：所有 API 密钥使用 AES-256-CBC 加密存储
2. **密钥保护**：`ENCRYPTION_KEY` 改变后无法解密旧密钥
3. **数据隔离**：用户数据基于 UUID 隔离
4. **数据库存储**：用户数据、API 密钥、书籍元数据等均存储在 SQLite 数据库 (data.db) 中
5. **敏感文件**：以下文件已加入 `.gitignore`：
   - `.env`
   - `data.db`
   - `books/`
   - `rag_index/`（RAG 向量索引）

## 许可证

MIT License