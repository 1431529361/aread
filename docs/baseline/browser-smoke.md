# P0 浏览器主流程冒烟记录（P0-08）

日期：2026-11-14。环境：隔离数据根 + 本地假模型（确定性、零费用），**非真实模型**。
服务：`scripts/smoke-server.js` 启动的隔离实例（临时端口），测试账号 `smoke-user`。
浏览器：Qoder 内置 browser-use 自动化。截图位于 `docs/baseline/screenshots/`。

> 说明：本冒烟验证 UI 主流程与安全渲染是否正确，不代表真实模型回答质量。在线真实模型基线见 P0-07（单独记录）。

## 步骤与结果

| # | 步骤 | 结果 | 证据 |
| --- | --- | --- | --- |
| 1 | 测试账号登录 | 通过 | 登录后书架显示用户名 smoke-user；`01-bookshelf.png` |
| 2 | 打开 TXT 阅读 | 通过 | 章节/目录正确渲染（第一章启程…第四章归途）；`02-reading.png` |
| 3 | 建立智能索引 | 通过 | 索引弹窗显示「4 个文本块 · 向量+BM25」；`08-index-status.png` |
| 4 | 选择本地提供商 | 通过 | 设置页 FakeLocal 已配置，密钥掩码 `sk-p0-sm****cdef`，模型 fake-model；`03-settings-provider.png` |
| 5 | 普通流式问答 | 通过 | 用户问题+助手回答渲染，含提供商标签；`04-chat-normal.png` |
| 6 | Agent 问答（工具循环） | 通过 | 显示 `调用工具：searchInBook`、`命中 4 条（hybrid(embedding+bm25)）`、章节标注片段、最终答案；`05-chat-agent-trace.png` |
| 7 | 恢复会话 | 通过 | 关闭再打开对话面板，4 条消息（2 用户+2 助手）回显，conversationId 持久 |
| 8 | 查看记忆 | 通过 | 记忆弹窗渲染 5 条；`06-memory-safe-render.png` |

## 安全渲染验证（P0-04，浏览器实测）

记忆抽取注入样本含非法 kind 与 HTML content，实测结果：

- 非法 kind（`<img src=x onerror=...>`、`FACT`、`123`）全部安全降级为「事实」，class 固定为 `memory-kind-fact`，无任意字符串拼入 class。
- 合法 kind（preference/interest）正常显示「偏好」「兴趣」。
- 含 HTML 的记忆 content 以**纯文本**显示：DOM 中 `img` 节点数=0、`script` 节点数=0。
- 阅读视图打开 HTML 注入书：同样仅渲染文字，`img`/`script` 节点数=0；`07-reading-html-safe.png`。
- 全局 `window.__p0_xss` 始终为 `null`，**无脚本执行**。

## 控制台与网络检查

- 控制台 error/warn：**无**。
- 网络请求：25 条 xhr/fetch **全部 200**，含 `/api/ask-stream` 与 `/api/agent/stream` 两条 SSE（text/event-stream）。

## 结论

P0-08 浏览器主流程冒烟通过；P0-04 安全渲染在浏览器层面验证通过。已知限制：使用假模型，回答质量为确定性占位文本，不用于效果结论。