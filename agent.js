/**
 * Function Calling Agent 引擎
 * - 工具由 tools/ 目录自注册（schema 与实现同处一地），本文件只负责 ReAct 主循环
 * - LLM 调用统一走 llm-client（非流式工具决策 + 最终流式输出）
 * - 防死循环：最大轮次 + 单工具调用次数限制
 * - 全链路 trace 事件输出（thinking / tool_call / tool_result / chunk / end）
 * - 模型不支持 function calling 时 graceful 降级为纯 LLM 流式回答
 */

const llmClient = require('./llm-client');
const toolRegistry = require('./tools');
const { MAX_TOOL_RESULT_CHARS } = require('./text-utils');

const MAX_ITERATIONS = 8;          // 最大 ReAct 轮次
const MAX_TOOL_CALLS_PER_NAME = 5; // 单个工具最大调用次数

function safeParseArgs(argsStr) {
    if (!argsStr) return {};
    try { return JSON.parse(argsStr); } catch { return {}; }
}

/** 最终答案流式输出（事件格式与既有 SSE 协议保持一致） */
function streamFinal(ctx, messages, onEvent) {
    return llmClient.stream(ctx, {
        messages,
        temperature: 0.4,
        maxTokens: 2000,
        timeoutMs: 90000,
        onChunk: (content) => onEvent({ type: 'chunk', content })
    });
}

/**
 * 运行 Agent ReAct 循环
 * @param {Object} opts
 *   - apiKey, providerConfig, model, providerId
 *   - systemPrompt, userMessage
 *   - messages: 可选，预组装好的完整 messages 数组（含 system + 历史 + 当前 user）；
 *               提供时优先使用，用于携带会话历史上下文
 *   - context: { bookId, userId, content }
 *   - onEvent: (event) => void  SSE 事件回调
 * @returns {Object} { content, iterations, trace }
 */
async function runAgentLoop(opts) {
    const { apiKey, providerConfig, model, providerId, systemPrompt, userMessage, context, onEvent } = opts;
    const ctx = { apiKey, providerConfig, model, providerId, ...context };
    const toolSchemas = toolRegistry.getToolSchemas();

    // 优先使用调用方预组装的 messages（携带会话历史）；否则回退为 [system, user]
    const messages = Array.isArray(opts.messages) && opts.messages.length > 0
        ? [...opts.messages]
        : [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userMessage }
        ];

    const trace = [];
    const toolCallCounts = {}; // 防止单工具死循环

    onEvent({ type: 'start', model, provider: providerConfig.name, tools: toolRegistry.getToolNames() });

    for (let iter = 1; iter <= MAX_ITERATIONS; iter++) {
        let resp;
        try {
            resp = await llmClient.chat(ctx, {
                messages,
                tools: toolSchemas,
                toolChoice: 'auto',
                temperature: 0.3,
                maxTokens: 1500,
                timeoutMs: 90000,
                retries: 1
            });
        } catch (e) {
            // 降级为纯流式问答：
            // - 400/404：provider 不支持 function calling
            // - 超时（AbortError）：带思考的模型非流式工具决策可能过长，重试后仍超时则不阻断回答
            const isTimeout = e.name === 'AbortError' || e.name === 'TimeoutError';
            if (e.status === 400 || e.status === 404 || isTimeout) {
                onEvent({
                    type: 'fallback',
                    reason: isTimeout ? '工具决策超时，切换为普通问答模式' : '当前模型不支持 Function Calling，切换为普通问答模式'
                });
                onEvent({ type: 'final_start', iteration: iter, fallback: true });
                const content = await streamFinal(ctx, messages, onEvent);
                onEvent({ type: 'end', content, iterations: iter, fallback: true });
                return { content, iterations: iter, trace, fallback: true };
            }
            throw e;
        }

        const choice = resp.choices[0];
        const msg = choice.message;
        const finishReason = choice.finish_reason;

        // 无工具调用 → 决策轮产出的内容就是最终回答，直接输出；
        // 不要追加 assistant 消息后再请求一轮"续写"——部分模型（如 qwen）对已完整回答的续写会返回空内容，
        // 且多一轮调用纯属浪费
        if (!msg.tool_calls || msg.tool_calls.length === 0 || finishReason === 'stop') {
            onEvent({ type: 'final_start', iteration: iter });
            if (msg.content && msg.content.trim()) {
                const content = msg.content;
                trace.push({ iteration: iter, type: 'answer', content });
                onEvent({ type: 'chunk', content });
                onEvent({ type: 'end', content, iterations: iter });
                return { content, iterations: iter, trace };
            }
            // 决策轮内容为空（个别模型 stop 时不带正文）：流式补一轮最终回答
            const content = await streamFinal(ctx, messages, onEvent);
            onEvent({ type: 'end', content, iterations: iter });
            return { content, iterations: iter, trace };
        }

        // 有工具调用 → 执行工具并回灌
        if (msg.content) {
            trace.push({ iteration: iter, type: 'thought', content: msg.content });
            onEvent({ type: 'thought', content: msg.content, iteration: iter });
        }
        messages.push({
            role: 'assistant',
            content: msg.content || null,
            tool_calls: msg.tool_calls
        });

        for (const tc of msg.tool_calls) {
            const toolName = tc.function.name;
            toolCallCounts[toolName] = (toolCallCounts[toolName] || 0) + 1;

            // 单工具调用次数熔断
            if (toolCallCounts[toolName] > MAX_TOOL_CALLS_PER_NAME) {
                const result = { error: `工具 ${toolName} 调用次数超限（${MAX_TOOL_CALLS_PER_NAME}次），已熔断` };
                onEvent({ type: 'tool_result', id: tc.id, name: toolName, result, iteration: iter, blocked: true });
                messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) });
                continue;
            }

            const args = safeParseArgs(tc.function.arguments);
            onEvent({ type: 'tool_call', id: tc.id, name: toolName, args, iteration: iter, callCount: toolCallCounts[toolName] });

            const t0 = Date.now();
            let result;
            try {
                result = await toolRegistry.executeTool(toolName, args, ctx);
            } catch (e) {
                result = { error: e.message };
            }
            const elapsed = Date.now() - t0;

            trace.push({ iteration: iter, type: 'tool', name: toolName, args, elapsed, result });
            onEvent({ type: 'tool_result', id: tc.id, name: toolName, result, elapsed, iteration: iter });

            const resultStr = JSON.stringify(result);
            messages.push({
                role: 'tool',
                tool_call_id: tc.id,
                content: resultStr.length > MAX_TOOL_RESULT_CHARS * 2 ? resultStr.substring(0, MAX_TOOL_RESULT_CHARS * 2) + '...' : resultStr
            });
        }
    }

    // 达到最大轮次，强制生成最终答案
    onEvent({ type: 'final_start', iteration: MAX_ITERATIONS, reason: 'max_iterations' });
    const content = await streamFinal(ctx, messages, onEvent);
    onEvent({ type: 'end', content, iterations: MAX_ITERATIONS, reason: 'max_iterations' });
    return { content, iterations: MAX_ITERATIONS, trace, maxedOut: true };
}

module.exports = {
    runAgentLoop
};
