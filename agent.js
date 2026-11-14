/**
 * Function Calling Agent 引擎（P1a A2）
 * - 自动选择直接回答/工具；维护执行预算；收集本轮证据候选
 * - 不再发 end/最终正文 chunk：终态与最终答案发射由问答服务负责（唯一完成责任）
 * - 工具参数完整校验后执行；结果裁剪后仍为合法 JSON
 * - 模型不支持工具/决策超时 → fallback 标记，由问答服务决定服务端取证或直答
 */
const llmClient = require('./llm-client');
const toolRegistry = require('./tools');

const MAX_ITERATIONS = 8;
const MAX_TOOL_CALLS_PER_NAME = 5;
const MAX_TOOL_RESULT_CHARS = 6000;

function safeParseArgs(argsStr) {
    if (!argsStr || typeof argsStr !== 'string') return { __invalid: true };
    try {
        const obj = JSON.parse(argsStr);
        return (obj && typeof obj === 'object' && !Array.isArray(obj)) ? obj : { __invalid: true };
    } catch { return { __invalid: true }; }
}

/** 裁剪工具结果用于回灌模型：先减候选项数再 stringify，始终合法 JSON */
function trimToolResultForMessage(result, maxChars = MAX_TOOL_RESULT_CHARS * 2) {
    let r = result;
    let str = JSON.stringify(r);
    if (str.length <= maxChars) return { str, truncated: !!r.truncated };
    const candidates = Array.isArray(r.candidates) ? [...r.candidates] : [];
    while (str.length > maxChars && candidates.length > 0) {
        candidates.pop();
        r = { ...r, candidates, truncated: true };
        str = JSON.stringify(r);
    }
    if (str.length > maxChars) {
        r = { status: r.status, candidates: [], data: r.data, truncated: true, error: r.error };
        str = JSON.stringify(r);
    }
    return { str, truncated: true };
}

/**
 * @param {Object} opts { apiKey, providerConfig, model, providerId, systemPrompt, userMessage,
 *   messages, context:{bookId,userId,content}, budget, signal, deadlineAt, onEvent }
 * @returns {Object} { route, content, evidenceCandidates, trace, iterations, llmCallCount,
 *   toolCallCount, usage, fallback, maxedOut, finishReason }
 */
async function runAgentLoop(opts) {
    const { apiKey, providerConfig, model, systemPrompt, userMessage, context, onEvent = () => {} } = opts;
    const ctx = { apiKey, providerConfig, model };
    const budget = opts.budget || {};
    const maxIterations = budget.maxIterations || MAX_ITERATIONS;
    const signal = opts.signal || null;
    const deadlineAt = opts.deadlineAt || null;
    const toolSchemas = toolRegistry.getToolSchemas();
    // 工具只接收授权上下文，不含模型凭据
    const toolContext = { bookId: context.bookId, userId: context.userId, content: context.content };

    const messages = Array.isArray(opts.messages) && opts.messages.length > 0
        ? [...opts.messages]
        : [{ role: 'system', content: systemPrompt }, { role: 'user', content: userMessage }];

    const trace = [];
    const evidenceCandidates = [];
    const toolCallCounts = {};
    let totalToolCalls = 0;
    let llmCallCount = 0;
    let hadTools = false;
    const usageAgg = { kind: 'unavailable', promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    const addUsage = (u) => {
        if (u && u.kind === 'actual') {
            usageAgg.kind = 'actual';
            usageAgg.promptTokens += u.promptTokens || 0;
            usageAgg.completionTokens += u.completionTokens || 0;
            usageAgg.totalTokens += u.totalTokens || 0;
        }
    };

    onEvent({ type: 'status', phase: 'deciding', label: '正在分析问题' });

    for (let iter = 1; iter <= maxIterations; iter++) {
        if (signal && signal.aborted) { const e = new Error('已取消'); e.name = 'AbortError'; throw e; }
        let resp;
        try {
            resp = await llmClient.chat(ctx, {
                messages, tools: toolSchemas, toolChoice: 'auto',
                temperature: 0.3, maxTokens: 1500, timeoutMs: 90000, retries: 1, signal, deadlineAt
            });
            llmCallCount++;
            addUsage(resp.usage);
        } catch (e) {
            const isTimeout = e.name === 'AbortError' || e.name === 'TimeoutError';
            if (signal && signal.aborted) throw e;
            if (e.status === 400 || e.status === 404 || isTimeout) {
                onEvent({ type: 'fallback', reason: isTimeout ? '工具决策超时' : '当前模型不支持 Function Calling' });
                return { route: 'direct', content: '', evidenceCandidates, trace, iterations: iter, llmCallCount, totalToolCalls, usage: usageAgg, fallback: true, fallbackReason: isTimeout ? 'timeout' : 'unsupported' };
            }
            throw e;
        }

        const toolCalls = resp.toolCalls || [];
        if (!toolCalls.length || resp.finishReason === 'stop') {
            // 无工具调用 → 决策轮内容即最终答案草稿（由问答服务门控后发射）
            trace.push({ iteration: iter, type: 'answer', content: resp.content });
            return {
                route: hadTools ? 'tools' : 'direct', content: resp.content || '',
                evidenceCandidates, trace, iterations: iter, llmCallCount, totalToolCalls,
                usage: usageAgg, fallback: false, finishReason: resp.finishReason
            };
        }

        hadTools = true;
        if (resp.content) {
            trace.push({ iteration: iter, type: 'thought', content: resp.content });
        }
        messages.push({ role: 'assistant', content: resp.content || null, tool_calls: toolCalls.map(tc => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: tc.arguments } })) });

        onEvent({ type: 'status', phase: 'retrieving', label: '正在查阅书籍' });
        for (const tc of toolCalls) {
            const toolName = tc.name;
            toolCallCounts[toolName] = (toolCallCounts[toolName] || 0) + 1;
            totalToolCalls++;
            if (toolCallCounts[toolName] > MAX_TOOL_CALLS_PER_NAME) {
                const blocked = { status: 'error', candidates: [], data: null, truncated: false, error: { code: 'TOOL_CALL_LIMIT', message: `工具 ${toolName} 调用次数超限`, retryable: false } };
                onEvent({ type: 'tool_result', callId: tc.id, name: toolName, status: 'error', returnedCount: 0, truncated: false, elapsedMs: 0, error: blocked.error });
                messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(blocked) });
                continue;
            }

            const args = safeParseArgs(tc.arguments);
            onEvent({ type: 'tool_call', callId: tc.id, name: toolName, args: args.__invalid ? { raw: tc.arguments } : args });

            const t0 = Date.now();
            let result;
            if (args.__invalid) {
                result = { status: 'error', candidates: [], data: null, truncated: false, error: { code: 'INVALID_TOOL_ARGS', message: '工具参数 JSON 不完整或非法，未执行', retryable: false } };
            } else {
                result = await toolRegistry.executeTool(toolName, args, toolContext);
            }
            const elapsed = Date.now() - t0;

            if (Array.isArray(result.candidates)) {
                for (const c of result.candidates) evidenceCandidates.push({ ...c, iteration: iter, tool: toolName });
            }
            trace.push({ iteration: iter, type: 'tool', name: toolName, args, elapsed, status: result.status });
            onEvent({ type: 'tool_result', callId: tc.id, name: toolName, status: result.status, returnedCount: (result.candidates || []).length, truncated: !!result.truncated, elapsedMs: elapsed, error: result.error || null });

            const { str } = trimToolResultForMessage(result);
            messages.push({ role: 'tool', tool_call_id: tc.id, content: str });
        }
    }

    // 达到最大轮次：交由问答服务流式生成最终答案
    return { route: hadTools ? 'tools' : 'direct', content: '', evidenceCandidates, trace, iterations: maxIterations, llmCallCount, totalToolCalls, usage: usageAgg, fallback: false, maxedOut: true };
}

module.exports = { runAgentLoop, trimToolResultForMessage };