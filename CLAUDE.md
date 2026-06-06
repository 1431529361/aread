# CLAUDE.md

此文件为 Claude Code (claude.ai/code) 在此仓库中工作时提供指导。

## 常用命令

- **启动服务**: `npm start` 或 `npm run dev` — 运行 `node server.js`
- 无构建步骤、无 linter、无测试框架

## 项目概述

AI 驱动的在线阅读网页应用（支持 TXT 书籍阅读和 AI 问答）。单体 Node.js/Express 后端 + 原生 JavaScript 前端（SPA）。

## 架构

### 后端 (`server.js`)
- Express.js 4.18，提供 `public/` 静态文件和 REST API
- **用户会话**: 基于 Cookie 的 UUID（无认证系统 — `cookie-parser` + `uuid`）
- **文件上传**: Multer（50MB 限制，支持 .txt/.pdf/.epub/.mobi）
- **TXT 编码**: 通过 `jschardet` 自动检测编码，`iconv-lite` 解码（UTF-8/GBK/Big5 等）
- **AI 集成**: OpenAI 兼容 API，支持 SSE 流式输出（`/api/ask-stream`）
- **密钥存储**: AES-256-CBC 加密后存入 JSON（`.api_keys.json`）
- **数据文件**（已 `.gitignore`）: `.api_keys.json`、`.books_meta.json`、`.custom_providers.json`、`.users.json`、`books/`

### 前端 (`public/`)
- 单页 HTML（`index.html`）+ CSS（`styles.css`）+ JS（`app.js`）
- `AIReadingAssistant` 类管理所有 UI 状态和 API 交互
- 核心功能：文本选中工具栏、浮动 AI 面板、SSE 流式展示、字体/主题设置
- 无框架 — 原生 ES6+，使用 `fetch` API

### AI 提供商
- 两个内置：智谱 AI 和硅基流动
- 自定义提供商：存储在 `.custom_providers.json`，必须兼容 OpenAI API
- 提供商配置包括：名称、API 地址、默认模型、可选模型列表

### 关键 API 端点
| 路径 | 说明 |
|------|------|
| POST `/api/ask-stream` | SSE 流式 AI 问答（主要端点） |
| POST `/api/ask` | 非流式 AI 问答 |
| POST `/api/books/upload` | 上传书籍文件（multipart） |
| GET `/api/books` | 获取用户书籍列表 |
| GET `/api/providers` | 获取可用 AI 提供商列表 |
| POST `/api/key/set` | 设置 API 密钥 |

### 核心模式
- **用户隔离**: `getUserId(req)` 读取/创建 Cookie UUID；所有数据按用户存储在 JSON 中
- **SSE 流式**: 服务端写入 `text/event-stream`，发送 `{type, content}` 块；客户端通过 `fetch` reader 循环读取
- **目录生成**: 通过 `app.js` 中的正则表达式检测章节（第X章/章/节/回/卷等）
