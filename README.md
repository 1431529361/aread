# AI 阅读助手 (AI Reading Assistant)

11一个现代化的智能阅读应用，集成多 AI 服务提供商，帮助用户高效阅读和理解书籍内容。支持在线阅读、AI 智能问答、书架管理、自定义 AI 提供商等功能。

##特性

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
- **多用户隔离**：基于 Cookie UUID 实现用户数据隔离

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
| 文件上传 | Multer |
| 编码检测 | jschardet + iconv-lite |
| 用户会话 | cookie-parser (UUID) |
| 密钥加密 | crypto (AES-256-CBC) |
| 环境变量 | dotenv |
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

## 注意事项

1. 上传文件最大 50MB
2. 流式输出使用 SSE，需浏览器支持
3. 建议定期备份密钥和数据文件
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

## 文件编码支持

系统自动检测 TXT 文件编码，支持：

- UTF-8（含 BOM）
- GBK / GB2312 / GB18030
- BIG5
- UTF-16LE / UTF-16BE

## API 接口文档

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
├── package.json           # 项目依赖配置
├── .env.example          # 环境变量示例
├── .gitignore            # Git 忽略配置
├── README.md             # 项目文档
│
├── public/               # 前端静态资源
│   ├── index.html        # 主页面
│   ├── styles.css        # 样式表
│   └── app.js            # 前端逻辑
│
├── books/                # 书籍存储（运行时）
│   └── {userId}/
│
├── node_modules/         # 依赖包
├── .api_keys.json        # 加密密钥存储
├── .books_meta.json      # 书籍元数据
├── .custom_providers.json # 自定义提供商
└── .users.json           # 用户数据
```

## 安全说明

1. **密钥加密**：所有 API 密钥使用 AES-256-CBC 加密存储
2. **密钥保护**：`ENCRYPTION_KEY` 改变后无法解密旧密钥
3. **数据隔离**：用户数据基于 UUID 隔离
4. **敏感文件**：以下文件已加入 `.gitignore`：
   - `.env`
   - `.api_keys.json`
   - `.custom_providers.json`
   - `.books_meta.json`
   - `.users.json`
   - `books/`

## 注意事项

1. 首次运行前必须配置 `ENCRYPTION_KEY`
2. 上传文件最大 50MB
3. 流式输出使用 SSE，需浏览器支持
4. 建议定期备份密钥和数据文件

## 许可证

MIT License
