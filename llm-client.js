/**
 * 统一 LLM Client（P1a A3）
 * - agent / orchestrator / conversation / server 共用的 OpenAI 兼容调用层
 * - ctx 约定：{ apiKey, providerConfig, model }
 * - 归一化结果 { content, toolCalls, finishReason, usage }；流式工具数据在本层拼接校验
 * - 支持 signal/deadlineAt/timeoutMs；UTF-8 跨块、SSE 分帧、残留缓冲；无完成信号的 EOF 按中断
 * - 已输出正文的生成不自动重试拼接第二份答案
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

function effectiveTimeout(timeoutMs, deadlineAt) {
    if (!deadlineAt) return timeoutMs;
    const remaining = deadlineAt - Date.now();
    return Math.max(1, Math.min(timeoutMs, remaining));
}

function linkSignal(controller, signal) {
    if (!signal) return () => {};
    const onAbort = () => controller.abort();
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
    return () => signal.removeEventListener('abort', onAbort);
}

async function toHttpError(resp) {
    const errBody = await resp.json().catch(() => ({}));
    const err = new Error(`LLM调用失败: ${resp.status}`);
    err.status = resp.status;
    err.body = errBody;
    return err;
}

function normalizeUsage(usage) {
    if (!usage) return { kind: 'unavailable' };
    return {
        kind: 'actual',
        promptTokens: usage.prompt_tokens ?? null,
        completionTokens: usage.completion_tokens ?? null,
        totalTokens: usage.total_tokens ?? null
    };
}

function normalizeToolCalls(toolCalls) {
    if (!Array.isArray(toolCalls)) return [];
    return toolCalls.map(tc => ({
        id: tc.id,
        name: tc.function?.name,
        arguments: tc.function?.arguments ?? ''
    }));
}

/**
 * 非流式对话调用，返回归一化 { content, toolCalls, finishReason, usage, raw }
 */
async function chat(ctx, {
    messages, tools = null, toolChoice = 'auto', temperature = 0.3,
    maxTokens = 1500, timeoutMs = 60000, retries = 0, signal = null, deadlineAt = null
} = {}) {
    const { endpoint, model } = resolveTarget(ctx);
    const body = { model, messages, temperature, max_tokens: maxTokens };
    if (tools && tools.length > 0) { body.tools = tools; body.tool_choice = toolChoice; }

    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
        if (signal && signal.aborted) { const e = new Error('已取消'); e.name = 'AbortError'; throw e; }
        const controller = new AbortController();
        const unlink = linkSignal(controller, signal);
        const timeout = setTimeout(() => controller.abort(), effectiveTimeout(timeoutMs, deadlineAt));
        try {
            const resp = await fetch(endpoint, { method: 'POST', headers: buildHeaders(ctx), body: JSON.stringify(body), signal: controller.signal });
            if (!resp.ok) throw await toHttpError(resp);
            const data = await resp.json();
            const choice = data.choices?.[0] || {};
            const msg = choice.message || {};
            return {
                content: msg.content || '',
                toolCalls: normalizeToolCalls(msg.tool_calls),
                finishReason: choice.finish_reason || null,
                usage: normalizeUsage(data.usage),
                raw: data
            };
        } catch (e) {
            lastErr = e;
            if (signal && signal.aborted) throw e;
            const status = e.status || 0;
            const isFatalClientError = status >= 400 && status < 500 && status !== 429;
            if (isFatalClientError) break;
            if (attempt < retries) await new Promise(r => setTimeout(r, 1500 * (attempt + 1)));
        } finally {
            clearTimeout(timeout);
            unlink();
        }
    }
    throw lastErr;
}

/** 便捷封装：单 prompt 或 messages → content 字符串 */
async function complete(ctx, promptOrMessages, { maxTokens = 800, temperature = 0.3, timeoutMs = 60000, retries = 0, signal = null, deadlineAt = null } = {}) {
    const messages = typeof promptOrMessages === 'string' ? [{ role: 'user', content: promptOrMessages }] : promptOrMessages;
    const res = await chat(ctx, { messages, maxTokens, temperature, timeoutMs, retries, signal, deadlineAt });
    return (res.content || '').trim();
}

/**
 * 流式对话调用（SSE），支持 tools（流式工具增量在本层拼接）。
 * 回调 onChunk(content) 逐增量；返回 { content, toolCalls, finishReason, usage, interrupted }
 * - 无有效完成信号（[DONE]/finish_reason）的 EOF → interrupted=true（不伪装成功）
 * - 流式不做重试（内容可能已部分下发）
 */
async function stream(ctx, {
    messages, tools = null, toolChoice = 'auto', temperature = 0.4, maxTokens = 2000,
    timeoutMs = 90000, onStart = null, onChunk = null, signal = null, deadlineAt = null
} = {}) {
    const { endpoint, model } = resolveTarget(ctx);
    const body = { model, messages, temperature, max_tokens: maxTokens, stream: true };
    if (tools && tools.length > 0) { body.tools = tools; body.tool_choice = toolChoice; }

    const controller = new AbortController();
    const unlink = linkSignal(controller, signal);
    const timeout = setTimeout(() => controller.abort(), effectiveTimeout(timeoutMs, deadlineAt));

    let fullContent = '';
    let finishReason = null;
    let usage = { kind: 'unavailable' };
    let sawDone = false;
    const toolAcc = new Map(); // index -> { id, name, arguments }

    try {
        const resp = await fetch(endpoint, { method: 'POST', headers: buildHeaders(ctx), body: JSON.stringify(body), signal: controller.signal });
        if (!resp.ok) throw await toHttpError(resp);
        onStart && onStart({ model });

        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        const handleLine = (line) => {
            if (!line.startsWith('data:')) return;
            const dataStr = line.slice(5).trim();
            if (!dataStr) return;
            if (dataStr === '[DONE]') { sawDone = true; return; }
            let parsed;
            try { parsed = JSON.parse(dataStr); } catch { return; }
            if (parsed.usage) usage = normalizeUsage(parsed.usage);
            const choice = parsed.choices?.[0];
            if (!choice) return;
            if (choice.finish_reason) finishReason = choice.finish_reason;
            const delta = choice.delta || {};
            if (delta.content) { fullContent += delta.content; onChunk && onChunk(delta.content); }
            if (Array.isArray(delta.tool_calls)) {
                for (const tc of delta.tool_calls) {
                    const idx = tc.index ?? 0;
                    const cur = toolAcc.get(idx) || { id: '', name: '', arguments: '' };
                    if (tc.id) cur.id = tc.id;
                    if (tc.function?.name) cur.name += tc.function.name;
                    if (tc.function?.arguments) cur.arguments += tc.function.arguments;
                    toolAcc.set(idx, cur);
                }
            }
        };

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            for (const line of lines) handleLine(line);
        }
        // 刷新残留缓冲与解码尾缓冲
        buffer += decoder.decode();
        if (buffer.trim()) handleLine(buffer);

        const toolCalls = [...toolAcc.values()].filter(t => t.name).map(t => ({ id: t.id, name: t.name, arguments: t.arguments }));
        const interrupted = !sawDone && !finishReason;
        return { content: fullContent, toolCalls, finishReason, usage, interrupted };
    } catch (e) {
        if (signal && signal.aborted) { e.name = 'AbortError'; }
        // 已产生部分正文时向上抛出带部分内容的错误，供上层标中断状态
        e.partialContent = fullContent;
        throw e;
    } finally {
        clearTimeout(timeout);
        unlink();
    }
}

module.exports = { chat, complete, stream, normalizeUsage };