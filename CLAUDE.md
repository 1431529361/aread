# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 常用命令

- 安装依赖：`npm install`
- 启动服务：`npm start`（运行 `node server.js`）
- 开发模式：`npm run dev`（当前同样运行 `node server.js`）
- 当前项目没有构建步骤、没有 linter、没有测试框架。

## 项目概述

AI Reading Assistant 是一个单体 Node.js/Express 应用，前端为原生 JavaScript SPA。它支持用户注册/登录、TXT/PDF/EPUB/MOBI 书籍上传、TXT 在线阅读、自动目录生成、选中文本 AI 问答、SSE 流式响应、按用户隔离的书籍/历史记录、API 密钥管理和自定义 OpenAI 兼容 AI 提供商。

## 架构

### 后端

- `server.js` 是 Express 入口，负责初始化数据库、注册认证/API/静态文件路由、处理文件上传、检测/解码 TXT 编码、管理 AI 提供商配置，并代理 AI 请求。
- `auth.js` 包含 JWT 认证相关逻辑：
  - `registerHandler`
  - `loginHandler`
  - `meHandler`
  - `authMiddleware`
  - `addDefaultBooksForUser`
- `database.js` 用 `sql.js` 封装进程内 SQLite，数据库文件为 `data.db`。初始化用户、API 密钥、自定义提供商、书籍元数据和历史记录表。
- API 密钥使用 AES-256-CBC 加密存储；如果配置了 `ENCRYPTION_KEY` 会使用固定密钥，否则启动时生成随机密钥。切换 `ENCRYPTION_KEY` 可能导致已有密钥无法解密。
- 文件上传使用 Multer，限制 50MB。上传文件存放到 `books/<userId>/`；TXT 文件通过 `jschardet` 检测编码并用 `iconv-lite` 解码。
- AI 调用兼容 OpenAI chat-completions 接口，支持非流式 `/api/ask` 和 SSE 流式 `/api/ask-stream`。

### 前端

- `public/index.html` 是 SPA 页面。
- `public/styles.css` 定义响应式 UI 和主题。
- `public/app.js` 通过 `AIReadingAssistant` 类管理前端状态和 API 交互，包括：
  - auth token 存储和统一 API fetch
  - 书架、阅读页、目录、阅读进度、字体/主题设置
  - 文本选择工具栏和 AI 面板
  - 提供商切换、API 密钥配置、自定义提供商管理
  - SSE 响应解析和历史记录渲染

## 关键接口

- 认证：`POST /api/auth/register`、`POST /api/auth/login`、`GET /api/auth/me`
- AI：`POST /api/ask`、`POST /api/ask-stream`
- API 密钥：`GET /api/key/status`、`POST /api/key/set`、`POST /api/key/verify`、`DELETE /api/key`
- 提供商：`GET /api/providers`、`POST /api/providers`、`PUT /api/providers/:id`、`DELETE /api/providers/:id`
- 书籍：`GET /api/books`、`POST /api/books/upload`、`GET /api/books/:id`、`GET /api/books/:id/download`、`DELETE /api/books/:id`、`PUT /api/books/:id/progress`
- 历史：`GET /api/history`、`POST /api/history`、`DELETE /api/history`

除注册和登录外，所有 API 都需要请求头 `Authorization: Bearer <token>`。

## 运行时数据和忽略文件

- `.env`、`.env.local`、`.env.*.local` 已忽略。
- `data.db`、`books/`、`.api_keys.json`、`.custom_providers.json` 是运行时数据/配置文件，已忽略。
- `node_modules/` 已忽略。
- `.env.example` 说明了可选环境变量，例如 `PORT`、`ENCRYPTION_KEY`、`JWT_SECRET` 和提供商 API Key。
