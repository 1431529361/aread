# CLAUDE.md

此文件为 Claude Code (claude.ai/code) 在此仓库中工作时提供指导。

## 常用命令

- **启动服务**: `npm start` 或 `npm run dev` — 运行 `node server.js`
- 无构建步骤、无 linter、无测试框架
- 启动时会输出加密密钥警告（如果 `ENCRYPTION_KEY` / `JWT_SECRET` 未配置）
- 修改数据库 schema：编辑 [migrations.js](file:///workspace/migrations.js) 末尾追加新版本（不要直接改 `database.js` 的 CREATE TABLE）

## 项目概述

AI 驱动的在线阅读网页应用（支持 TXT 书籍阅读和 AI 问答）。单体 Node.js/Express 后端 + 原生 JavaScript 前端（SPA，ES Modules）。

## 架构

### 后端（Node.js）
| 文件 | 职责 |
|------|------|
| [server.js](file:///workspace/server.js) | Express 应用：路由、限流、加密、AI 调用 |
| [auth.js](file:///workspace/auth.js) | JWT 注册/登录/验证中间件 |
| [database.js](file:///workspace/database.js) | sql.js 包装：CRUD + 200ms 防抖落盘 + 优雅关闭 |
| [migrations.js](file:///workspace/migrations.js) | Schema 迁移系统（事务安全、幂等、`_migrations` 表） |
| [logger.js](file:///workspace/logger.js) | 结构化日志（分级、JSON 输出、子 logger） |

**核心特性**：
- **认证**：JWT (jsonwebtoken)，默认 7 天 / 30 天 (rememberMe)
- **加密**：API 密钥 AES-256-CBC 加密后存入 `api_keys` 表
- **数据库**：sql.js（纯 JS 实现），所有表都通过 migrations 创建
- **AI**：OpenAI 兼容 API，支持 SSE 流式（`/api/ask-stream`）
- **限流**：express-rate-limit — 登录 15min/20，AI 1min/30，上传 1min/10
- **TXT 编码**：jschardet 自动检测 + iconv-lite 解码（UTF-8/GBK/Big5 等）
- **文件上传**：Multer（50MB 限制）
- **优雅退出**：SIGINT/SIGTERM 触发 DB flush

### 前端（`public/js/`）
原生 ES Modules（无构建步骤、无打包器）。所有模块用 `<script type="module">` 加载。

| 模块 | 职责 |
|------|------|
| [main.js](file:///workspace/public/js/main.js) | 入口：编排各模块初始化、视图切换 |
| [api.js](file:///workspace/public/js/api.js) | 后端 API 客户端封装（fetch + 401 自动登出 + XHR 上传进度） |
| [store.js](file:///workspace/public/js/store.js) | 极简状态容器（订阅模式 + localStorage 自动同步） |
| [utils.js](file:///workspace/public/js/utils.js) | escapeHtml / toast / DOM helpers |
| [auth.js](file:///workspace/public/js/auth.js) | 登录/注册/退出 UI |
| [reader.js](file:///workspace/public/js/reader.js) | TXT 上传、章节解析、目录、字号/主题 |
| [shelf.js](file:///workspace/public/js/shelf.js) | 书架管理（列表/上传/下载/删除） |
| [ai.js](file:///workspace/public/js/ai.js) | 浮动工具栏 + AI 面板 + 流式问答 + 历史 |
| [settings.js](file:///workspace/public/js/settings.js) | API 密钥 + 自定义提供商 + 模型管理 |

**模块间无循环依赖**：
- `utils` / `store` 是基础模块，无依赖
- `api` 依赖 `store`
- `auth` / `reader` / `shelf` / `ai` / `settings` 依赖 `store` + `api` + `utils`
- `shelf` 还依赖 `reader`（openBook 后渲染）
- `settings` 还依赖 `ai`（复用 showModal/hideModal）
- `main` 编排所有 `init*()` 函数

### AI 提供商
- 两个内置：智谱 AI 和硅基流动
- 自定义提供商：存储在 `custom_providers` 表，必须兼容 OpenAI API
- 提供商配置：名称、API 地址、默认模型、可选模型列表

### 关键 API 端点
| 路径 | 限流 | 说明 |
|------|------|------|
| POST `/api/auth/register` | authLimiter | 用户注册 |
| POST `/api/auth/login` | authLimiter | 用户登录，返回 JWT |
| GET `/api/auth/me` | - | 获取当前用户信息 |
| POST `/api/ask-stream` | aiLimiter | SSE 流式 AI 问答（主要端点） |
| POST `/api/ask` | aiLimiter | 非流式 AI 问答 |
| POST `/api/books/upload` | uploadLimiter | 上传书籍（multipart） |
| GET `/api/books` | - | 获取用户书籍列表 |
| PUT `/api/books/:id/progress` | - | 保存阅读进度（0-100） |
| GET `/api/providers` | - | 获取可用 AI 提供商列表 |
| POST `/api/providers` | aiLimiter | 添加自定义提供商 |
| POST `/api/key/set` | aiLimiter | 设置 API 密钥 |
| POST `/api/key/verify` | aiLimiter | 验证 API 密钥 |
| GET `/api/key/status` | - | 获取各提供商密钥状态 |
| POST `/api/history` | aiLimiter | 保存一条 AI 问答历史 |
| GET `/api/history?limit&offset` | - | 拉取用户历史（默认 50，最多 200） |
| DELETE `/api/history` | - | 按 id 删除或清空（body 可选 `{id}`） |

### 核心模式
- **Schema 迁移**：所有 CREATE TABLE/INDEX 都在 `migrations.js` 的 `MIGRATIONS` 数组中。`database.js` 启动时调用 `runMigrations()`，自动应用未执行的迁移。`SCHEMA_VERSION` 必须与最大 version 同步。
- **SQL.js 防抖**：每次 `run()` 不立即写盘，200ms 内多次写入合并为一次 export + writeFile。SIGTERM 时强制 flush。
- **共享函数**（`server.js`）：
  - `getApiKeyForUser(userId, providerId)` — 优先 DB，回退 env
  - `buildAIRequestBody({...})` — 构造 system + user prompt
  - `getProviderConfig(provider, userId)` — 合并内置 + 自定义
- **SSE 流式**：`/api/ask-stream` 用 `sseStarted` 标志区分错误分支（已发送 header 时只能写 SSE 事件，不能返回 JSON）
- **客户端断开**：`req.on('close')` 主动 abort 上游 fetch
- **用户隔离**：所有数据通过 `req.user.id`（来自 JWT）过滤
- **目录生成**：前端正则检测章节（第X章/章/节/回/卷等）

## 未来方向（按优先级）

### 🔴 高优先级
- **测试框架**：当前 0 测试。优先加 Jest + supertest 覆盖：认证、AI、文件上传、限流
- **CI/CD**：加 GitHub Actions（lint + test + 自动构建 Docker 镜像）
- **AI 多轮对话**：当前每次问答独立，浪费 token 也无法追问；需引入 session 机制（数据库存消息历史）
- **整书搜索 / 笔记 / 高亮 / 书签**：基础阅读功能
- **/api/history 端点** ✅ 已实现（POST/GET/DELETE，单用户 200 条上限） |

### 🟡 中优先级
- **RAG（检索增强生成）**：当前只用"选中文本+书名"做 prompt；对全书做 embedding 检索可大幅提升问答质量
- **PDF/EPUB 在线解析**：当前只能下载；引入 `pdf-parse` / `epub2` 等库
- **笔记导出**：Markdown / JSON 导出阅读数据
- **结构化日志 + 监控**：用 pino + Loki/CloudWatch 采集；记录 token 用量、响应时间、错误率
- **Linter/Formatter**：加 ESLint + Prettier，建立 `project_rules.md` 自动跑
- **TypeScript 化**：JSDoc → TS 渐进改造

### 🟢 低优先级
- **i18n**：硬编码中文文案抽离到 i18n 文件
- **a11y**：ARIA 标签、键盘导航、屏幕阅读器支持
- **PWA / 离线缓存**：Service Worker + 离线阅读
- **Docker 化**：Dockerfile + docker-compose（Postgres / Redis 可选）
- **分享问答**：生成可分享链接
- **响应式设计强化**：移动端阅读体验

## 调试技巧

- 查看后端日志：`npm start` 直接看 stdout（开发模式彩色 + JSON 字段）
- 查看 SQL：临时在 `database.js` 的 `run` 里加 `console.log(sql)`
- 前端调试：浏览器 DevTools → Network → 看 `js/*.js` 模块加载
- 清空数据库：删 `data.db` 重启（迁移系统会自动重建表）
- 测试限流：用 `for` 循环快速打 `/api/auth/login` 22 次
