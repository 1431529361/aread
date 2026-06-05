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

### 📚 书架管理

- **多格式支持**：TXT、PDF、EPUB、MOBI（最大 50MB）
- **上传进度**：实时显示上传进度条
- **书籍操作**：在线阅读（TXT）、下载、删除
- **数据隔离**：每个用户的书籍、书架、阅读进度完全独立

### 👤 用户系统

- **注册登录**：支持用户名+密码注册登录，用户名支持中文
- **JWT 认证**：登录后自动保持登录状态（7天），支持"记住我"（30天）
- **密码安全**：bcrypt 加密存储，不保存明文密码
- **数据隔离**：每个用户的 API 密钥、自定义提供商、书架、阅读进度完全独立
- **历史同步**：AI 问答历史保存在服务器（每用户最多 200 条），换设备登录也能查看，可单条删除或一键清空

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
| 后端 | Express.js 4.18 |
| 前端 | 原生 JavaScript (ES6+) ES Modules |
| 数据库 | SQLite (sql.js - 纯 JS 实现，无需 C++ 编译) |
| 用户认证 | JWT (jsonwebtoken) |
| 密码加密 | bcryptjs |
| 文件上传 | Multer |
| 编码检测 | jschardet + iconv-lite |
| 密钥加密 | crypto (AES-256-CBC) |
| 环境变量 | dotenv |
| 速率限制 | express-rate-limit |
| 日志 | 自研轻量结构化 logger |
| Schema 管理 | 自研迁移系统（事务安全） |
| AI 接口 | OpenAI 兼容 API (SSE 流式) |

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

## 安全特性

### 速率限制
通过 `express-rate-limit` 防止滥用：

| 端点 | 限制 |
|------|------|
| `/api/auth/login`、`/api/auth/register` | 15 分钟 20 次 |
| `/api/ask*`、`/api/key/set`、`/api/key/verify`、`/api/providers` (POST) | 1 分钟 30 次 |
| `/api/books/upload` | 1 分钟 10 次 |

### 密钥持久化警告
启动时若未设置 `ENCRYPTION_KEY` 或 `JWT_SECRET` 环境变量，控制台会高亮警告：
- **ENCRYPTION_KEY** 未配置 → 每次启动重新生成，所有已加密的 API Key 重启后无法解密
- **JWT_SECRET** 未配置 → 每次启动重新生成，所有已签发的 token 重启后立即失效

### CORS
生产环境（`NODE_ENV=production`）下禁止跨域，仅允许同源访问。

### 输入验证
- `/api/ask*` 限制文本 ≤ 50,000 字符，问题 ≤ 2,000 字符
- `/api/books/:id/progress` 限制进度 0-100
- `express.json` 请求体上限 2MB

## 注意事项

1. 上传文件最大 50MB
2. 流式输出使用 SSE，需浏览器支持
3. 建议定期备份 `data.db` 数据库文件
4. 数据库写入采用 200ms 防抖，避免高频写盘；进程退出时会强制 flush
5. 如需持久化保存 API 密钥和服务端 token，**必须**配置 `ENCRYPTION_KEY` 和 `JWT_SECRET`

### 环境变量配置（可选）

如需配置，可在 `.env` 文件中设置：

```env
# 运行环境（development | production）
NODE_ENV=development

# 固定加密密钥（强烈建议设置，不配置则每次启动自动生成）
# 生成命令：node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
ENCRYPTION_KEY=your_64_char_hex_key

# JWT 密钥（强烈建议设置，不配置则每次启动自动生成）
JWT_SECRET=your_random_secret_at_least_32_chars

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

## 项目结构

```
trae02airead/
├── server.js              # Express 后端主服务
├── auth.js                # JWT 认证中间件 (register/login/me)
├── database.js            # SQLite 数据库封装 (sql.js + 防抖落盘)
├── migrations.js          # Schema 迁移系统（事务安全、幂等）
├── logger.js              # 轻量结构化日志器
├── package.json           # 项目依赖配置
├── .env.example           # 环境变量配置示例
├── .gitignore             # Git 忽略配置
├── README.md              # 项目文档
│
├── public/                # 前端静态资源
│   ├── index.html         # 主页面 (单页应用)
│   ├── styles.css         # 样式表
│   └── js/                # 前端 ES Modules
│       ├── main.js        # 入口：编排各模块初始化
│       ├── api.js         # 后端 API 客户端（fetch 封装）
│       ├── store.js       # 极简状态容器 + localStorage 同步
│       ├── utils.js       # 通用工具 (escapeHtml/toast/DOM helpers)
│       ├── auth.js        # 登录/注册/退出/Token 验证
│       ├── reader.js      # TXT 阅读器（上传/解析/目录/主题）
│       ├── shelf.js       # 书架管理（列表/上传/下载/删除）
│       ├── ai.js          # AI 面板 + 文本选区工具栏 + 历史
│       └── settings.js    # API 密钥 + 自定义提供商 + 模型
│
├── books/                 # 书籍文件存储（运行时）
│   └── {userId}/
│
└── data.db                # SQLite 数据库文件（运行时生成）
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

## 许可证

MIT License