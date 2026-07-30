/**
 * 统一 LLM Client
 * - agent / orchestrator / conversation / server 共用的 OpenAI 兼容调用层
 * - 收敛此前散落各处的 fetch + 超时 + 重试 + SSE 解析逻辑
 * - ctx 约定：{ apiKey, providerConfig, model }，模型解析 ctx.model || providerConfig.defaultModel
 */

function resolveTarget(ctx) {
    return {
        endpoint: ctx.providerConfig.apiEndpoint,
        model: ctx.model || ctx.providerConfig.defaultModel
    };
}

function buildHeaders(ctx) {
    return { 'Content-Type': 'application/json', 'Authorization': `Bearer ${ctx.apiKey}` };
}

/** 非 2xx 响应统一转为带 status/body 的错误（供调用方做降级判断，如 400/404 → fallback） */
async function toHttpError(resp) {
    const errBody = await resp.json().catch(() => ({}));
    const err = new Error(`LLM调用失败: ${resp.status}`);
    err.status = resp.status;
    err.body = errBody;
    return err;
}

/**
 * 非流式对话调用，返回原始响应 data（choices[0].message 可含 tool_calls）
 * 重试策略：4xx（429 除外）不重试直接抛出；超时/429/5xx 按 1500ms*(attempt+1) 退避重试
 * @param {Object} ctx { apiKey, providerConfig, model }
 * @param {Object} opts { messages, tools?, toolChoice?, temperature, maxTokens, timeoutMs, retries }
 */
async function chat(ctx, {
    messages,
    tools = null,
    toolChoice = 'auto',
    temperature = 0.3,
    maxTokens = 1500,
    timeoutMs = 60000,
    retries = 0
} = {}) {
    const { endpoint, model } = resolveTarget(ctx);
    const body = { model, messages, temperature, max_tokens: maxTokens };
    if (tools && tools.length > 0) {
        body.tools = tools;
        body.tool_choice = toolChoice;
    }

    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const resp = await fetch(endpoint, {
                method: 'POST',
                headers: buildHeaders(ctx),
                body: JSON.stringify(body),
                signal: controller.signal
            });
            if (!resp.ok) throw await toHttpError(resp);
            return await resp.json();
        } catch (e) {
            lastErr = e;
            // 4xx 客户端错误（模型不存在/请求非法，429 限流除外）重试无意义
            const status = e.status || 0;
            const isFatalClientError = status >= 400 && status < 500 && status !== 429;
            if (isFatalClientError) break;
            if (attempt < retries) await new Promise(r => setTimeout(r, 1500 * (attempt + 1)));
        } finally {
            clearTimeout(timeout);
        }
    }
    throw lastErr;
}

/**
 * 便捷封装：单 prompt 或 messages → 返回 content 字符串（trim 后）
 * @param {Object} ctx
 * @param {string|Array} promptOrMessages
 */
async function complete(ctx, promptOrMessages, {
    maxTokens = 800,
    temperature = 0.3,
    timeoutMs = 60000,
    retries = 0
} = {}) {
    const messages = typeof promptOrMessages === 'string'
        ? [{ role: 'user', content: promptOrMessages }]
        : promptOrMessages;
    const data = await chat(ctx, { messages, maxTokens, temperature, timeoutMs, retries });
    return data.choices[0].message.content.trim();
}

/**
 * 流式对话调用（SSE），每个内容增量回调 onChunk(content)，返回完整拼接文本
 * - onStart：在响应确认 2xx 之后、开始读流之前回调（供路由在此时机写 SSE 头/start 事件）
 * - 流式不做重试（内容可能已部分下发）；非 2xx 抛带 status/body 的错误
 * @param {Object} ctx
 * @param {Object} opts { messages, temperature, maxTokens, timeoutMs, onStart?, onChunk }
 */
async function stream(ctx, {
    messages,
    temperature = 0.4,
    maxTokens = 2000,
    timeoutMs = 90000,
    onStart = null,
    onChunk = null
} = {}) {
    const { endpoint, model } = resolveTarget(ctx);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const resp = await fetch(endpoint, {
            method: 'POST',
            headers: buildHeaders(ctx),
            body: JSON.stringify({ model, messages, temperature, max_tokens: maxTokens, stream: true }),
            signal: controller.signal
        });
        if (!resp.ok) throw await toHttpError(resp);

        onStart && onStart({ model });

        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let fullContent = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                const dataStr = line.slice(6);
                if (dataStr.trim() === '[DONE]') continue;
                try {
                    const parsed = JSON.parse(dataStr);
                    const content = parsed.choices?.[0]?.delta?.content || '';
                    if (content) {
                        fullContent += content;
                        onChunk && onChunk(content);
                    }
                } catch {}
            }
        }
        return fullContent;
    } finally {
        clearTimeout(timeout);
    }
}

module.exports = { chat, complete, stream };
