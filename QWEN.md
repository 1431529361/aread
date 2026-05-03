# AI 阅读助手 (AI Reading Assistant)

## 项目概述

这是一个基于 Web 的智能阅读助手应用，集成多 AI 服务提供商（智谱 AI、硅基流动），帮助用户高效阅读和理解书籍内容。项目采用前后端分离架构，后端使用 Express.js，前端使用原生 JavaScript。

### 核心功能

- **阅读模式**：支持 TXT 文件在线阅读，自动检测文件编码（UTF-8、GBK、GB2312 等）
- **AI 问答**：支持文本选中后的快捷 AI 操作，侧边栏面板自定义问题，流式输出回答
- **书架管理**：书籍上传（TXT、PDF、EPUB、MOBI，最大 50MB），用户数据隔离（基于 Cookie UUID）
- **历史记录**：自动保存 AI 问答历史（最多 50 条）
- **多 AI 提供商**：智谱 AI（glm-4.5-air）、硅基流动（DeepSeek-V4-Flash、Qwen3.6-35B-A3B）
- **密钥管理**：API 密钥 AES-256-CBC 加密存储
- **UI 功能**：字体大小调节、主题切换（明亮/暗黑/护眼）、文章目录导航

## 技术栈

| 类别 | 技术 |
|------|------|
| 后端 | Express.js |
| 前端 | 原生 JavaScript (ES6+) |
| 文件上传 | Multer |
| 编码检测 | jschardet + iconv-lite |
| 用户会话 | cookie-parser (UUID) |
| 密钥加密 | crypto (AES-256-CBC) |
| 环境变量 | dotenv |
| AI 接口 | OpenAI 兼容 API (SSE 流式) |

## 项目结构

```
├── server.js              # Express 后端主服务 (874 行)
├── package.json           # 项目依赖配置
├── .env.example          # 环境变量示例配置
├── .gitignore            # Git 忽略文件配置
├── README.md             # 项目详细文档
│
├── public/               # 前端静态资源
│   ├── index.html        # 前端页面
│   ├── styles.css        # 样式表
│   └── app.js            # 前端逻辑 (1369 行)
│
├── books/                # 书籍文件存储目录（运行时生成）
│   └── {userId}/
│       └── {bookId}.{ext}
│
├── node_modules/         # 依赖包（不提交）
├── .api_keys.json        # 加密的 API 密钥存储（运行时生成）
├── .books_meta.json      # 书籍元数据存储（运行时生成）
└── .users.json           # 用户数据存储（运行时生成）
```

## 环境要求

- Node.js >= 18.0.0
- npm >= 9.0.0

## 安装与运行

### 安装依赖

```bash
npm install
```

### 配置环境变量

```bash
cp .env.example .env
```

编辑 `.env` 文件，配置必要的 API 密钥和加密密钥：

```env
PORT=3000
ENCRYPTION_KEY=<64位十六进制字符>
ZHIPU_API_KEY=your_zhipu_api_key
SILICONFLOW_API_KEY=your_siliconflow_api_key
AI_MODEL=glm-4.5-air
```

生成加密密钥：

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### 启动服务

```bash
# 生产模式
npm start

# 开发模式（等同于 start）
npm run dev
```

访问 http://localhost:3000

## API 接口

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

### 提供商与模型

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/providers` | 获取可用提供商列表和模型 |

### 书籍管理

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/books` | 获取用户书籍列表 |
| POST | `/api/books/upload` | 上传书籍 |
| GET | `/api/books/:bookId` | 获取书籍内容和元数据 |
| GET | `/api/books/:bookId/download` | 下载书籍 |
| DELETE | `/api/books/:bookId` | 删除书籍 |
| PUT | `/api/books/:bookId/progress` | 保存阅读进度 |

## 开发约定

### 代码风格

- 后端使用 CommonJS 模块系统
- 前端使用 ES6+ 类语法（`AIReadingAssistant` 类）
- 使用 `async/await` 处理异步操作
- 错误处理使用 try-catch，返回适当的 HTTP 状态码

### 文件编码处理

系统自动检测 TXT 文件的编码格式，支持：
- UTF-8（含 BOM 检测）
- GBK / GB2312 / GB18030
- BIG5
- UTF-16LE / UTF-16BE

使用 `jschardet` 进行编码检测，`iconv-lite` 进行解码转换。

### 用户隔离

- 使用 Cookie 存储用户 UUID
- 每个用户的书籍存储在独立的 `books/{userId}/` 目录下
- 书籍元数据按用户 ID 分组存储在 `.books_meta.json` 中

### 密钥安全

- API 密钥使用 AES-256-CBC 加密存储
- 加密密钥由 `.env` 中的 `ENCRYPTION_KEY` 决定
- **重要**：`ENCRYPTION_KEY` 必须保持不变，否则重启后无法解密旧密钥

## AI 提供商配置

### 智谱 AI
- API 端点：`https://open.bigmodel.cn/api/paas/v4/chat/completions`
- 默认模型：`glm-4.5-air`
- 验证模型：`glm-4-flash`

### 硅基流动
- API 端点：`https://api.siliconflow.cn/v1/chat/completions`
- 默认模型：`deepseek-ai/DeepSeek-V4-Flash`
- 可选模型：`Qwen/Qwen3.6-35B-A3B`

## 注意事项

1. `.env`、`.api_keys.json`、`.books_meta.json`、`books/` 等敏感文件已加入 `.gitignore`，不会提交到版本控制
2. 上传的文件最大 50MB，支持 TXT、PDF、EPUB、MOBI 格式
3. 流式输出使用 SSE（Server-Sent Events）协议
4. AI 问答历史最多保存 50 条，支持查看和清空
