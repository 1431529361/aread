/**
 * Function Calling Agent 引擎
 * - 注册 3 个信息检索类工具（searchInBook / getChapterInfo / lookupCharacter）
 * - 翻译/总结等模型原生能力不注册为工具，避免多余 LLM 往返与超时风险
 * - ReAct 风格 tool-call 循环：非流式工具决策 + 最终流式输出
 * - 防死循环：最大轮次 + 单工具调用次数限制
 * - 全链路 trace 事件输出（thinking / tool_call / tool_result / chunk / end）
 * - 工具不可用时 graceful 降级为纯 LLM 流式回答
 */

const rag = require('./rag');

const MAX_ITERATIONS = 8;          // 最大 ReAct 轮次
const MAX_TOOL_CALLS_PER_NAME = 5; // 单个工具最大调用次数
const MAX_TOOL_RESULT_CHARS = 3000;// 单次工具结果截断长度

// ==================== 工具定义（OpenAI function calling 格式） ====================

const AGENT_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'searchInBook',
            description: '在当前阅读的书籍全文中检索与查询最相关的段落（基于 RAG 向量/BM25 检索）。用于回答需要查阅书中其他部分、或超出选中文本范围的问题。',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: '检索查询词或问题' }
                },
                required: ['query']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'getChapterInfo',
            description: '获取书中指定章节的内容摘要与开头文本。可通过章节标题关键词或章节序号（从1开始）定位。',
            parameters: {
                type: 'object',
                properties: {
                    chapterTitle: { type: 'string', description: '章节标题关键词' },
                    chapterIndex: { type: 'integer', description: '章节序号（从1开始）' }
                }
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'lookupCharacter',
            description: '在书中查找某个人物/角色名的所有出现位置及上下文片段，用于分析人物形象、关系或剧情线。',
            parameters: {
                type: 'object',
                properties: {
                    name: { type: 'string', description: '人物姓名或称呼' }
                },
                required: ['name']
            }
        }
    }
];

// ==================== 章节切分（与前端 formatTextContent 对齐） ====================

const CHAPTER_RE = /^(第[一二三四五六七八九十零百千万]+[章节回部篇集]|[第\d]+[章节回部篇集]|[一二三四五六七八九十零]+[、.]|[\d]+[、.]|Chapter\s*\d+|CHAPTER\s*\d+)/i;

function splitChapters(content) {
    const paragraphs = content.split(/\n+/).map(p => p.trim()).filter(Boolean);
    const chapters = [];
    let current = null;
    for (const para of paragraphs) {
        if (CHAPTER_RE.test(para)) {
            if (current) chapters.push(current);
            current = { title: para.substring(0, 60), text: para + '\n' };
        } else if (current) {
            current.text += para + '\n';
        } else {
            current = { title: '前言', text: para + '\n' };
        }
    }
    if (current) chapters.push(current);
    if (chapters.length === 0) chapters.push({ title: '全文', text: content });
    return chapters;
}

function truncate(text, max = MAX_TOOL_RESULT_CHARS) {
    if (!text) return '';
    return text.length > max ? text.substring(0, max) + '\n...(内容已截断)' : text;
}

// ==================== 工具执行器 ====================

/**
 * 执行单个工具
 * @param {string} name 工具名
 * @param {Object} args 参数
 * @param {Object} ctx { bookId, userId, content, apiKey, providerConfig, model, providerId }
 */
async function executeTool(name, args, ctx) {
    switch (name) {
        case 'searchInBook': {
            const query = args.query || '';
            // 优先向量检索（若已 embedding），回退 BM25
            const embedQueryFn = (ctx.apiKey && ctx.providerId)
                ? (q) => rag.embed([q], ctx.apiKey, ctx.providerId).then(v => v[0])
                : null;
            const hits = await rag.retrieveAsync(ctx.userId, ctx.bookId, query, 5, embedQueryFn);
            if (hits.length === 0) {
                // 无 RAG 索引时，回退全文子串搜索
                const idx = ctx.content ? ctx.content.indexOf(query) : -1;
                if (idx >= 0) {
                    return { source: 'fulltext', snippet: truncate(ctx.content.substring(Math.max(0, idx - 200), idx + 800)) };
                }
                return { source: 'empty', message: '未在书中检索到相关内容，建议基于选中文本回答' };
            }
            return {
                source: hits[0].score > 0.5 && ctx.vectors ? 'embedding' : 'bm25',
                results: hits.map(h => ({ chapter: h.chapter, score: Number(h.score.toFixed(4)), text: truncate(h.text, 600) }))
            };
        }
        case 'getChapterInfo': {
            const chapters = splitChapters(ctx.content || '');
            let target = null;
            if (args.chapterIndex != null) {
                target = chapters[args.chapterIndex - 1];
            } else if (args.chapterTitle) {
                target = chapters.find(c => c.title.includes(args.chapterTitle)) ||
                        chapters.find(c => c.text.includes(args.chapterTitle));
            }
            if (!target) return { error: '未找到匹配章节', totalChapters: chapters.length };
            return {
                title: target.title,
                totalChapters: chapters.length,
                preview: truncate(target.text, 1500),
                length: target.text.length
            };
        }
        case 'lookupCharacter': {
            const charName = args.name || '';
            const content = ctx.content || '';
            const contexts = [];
            let pos = 0;
            const MAX_HITS = 6;
            while ((pos = content.indexOf(charName, pos)) !== -1 && contexts.length < MAX_HITS) {
                const start = Math.max(0, pos - 80);
                const end = Math.min(content.length, pos + charName.length + 120);
                contexts.push({
                    position: pos,
                    snippet: content.substring(start, end).replace(/\n+/g, ' ')
                });
                pos += charName.length;
            }
            return {
                name: charName,
                occurrences: contexts.length,
                samples: contexts
            };
        }
        default:
            return { error: `未知工具: ${name}` };
    }
}

// ==================== LLM 调用辅助 ====================

/**
 * 非流式 LLM 调用（工具内部使用，如 summarize/translate）
 */
async function llmComplete(ctx, task, prompt) {
    const apiEndpoint = ctx.providerConfig.apiEndpoint;
    const model = ctx.model || ctx.providerConfig.defaultModel;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60000);
    try {
        const resp = await fetch(apiEndpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${ctx.apiKey}` },
            body: JSON.stringify({
                model,
                messages: [{ role: 'user', content: prompt }],
                temperature: 0.3,
                max_tokens: 800
            }),
            signal: controller.signal
        });
        if (!resp.ok) throw new Error(`LLM调用失败: ${resp.status}`);
        const data = await resp.json();
        return data.choices[0].message.content.trim();
    } finally {
        clearTimeout(timeout);
    }
}

/**
 * 非流式带 tools 的 LLM 调用（用于 ReAct 决策轮）
 */
async function llmCallWithTools(ctx, messages, tools) {
    const apiEndpoint = ctx.providerConfig.apiEndpoint;
    const model = ctx.model || ctx.providerConfig.defaultModel;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60000);
    try {
        const resp = await fetch(apiEndpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${ctx.apiKey}` },
            body: JSON.stringify({
                model,
                messages,
                tools,
                tool_choice: 'auto',
                temperature: 0.3,
                max_tokens: 1500
            }),
            signal: controller.signal
        });
        if (!resp.ok) {
            const errBody = await resp.json().catch(() => ({}));
            const err = new Error(`LLM tools 调用失败: ${resp.status}`);
            err.status = resp.status;
            err.body = errBody;
            throw err;
        }
        const data = await resp.json();
        return data;
    } finally {
        clearTimeout(timeout);
    }
}

/**
 * 流式 LLM 调用（最终答案输出），通过 onEvent 推送 chunk
 */
async function llmStream(ctx, messages, onEvent) {
    const apiEndpoint = ctx.providerConfig.apiEndpoint;
    const model = ctx.model || ctx.providerConfig.defaultModel;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 90000);

    try {
        const resp = await fetch(apiEndpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${ctx.apiKey}` },
            body: JSON.stringify({
                model,
                messages,
                temperature: 0.4,
                max_tokens: 2000,
                stream: true
            }),
            signal: controller.signal
        });
        if (!resp.ok) throw new Error(`LLM 流式调用失败: ${resp.status}`);

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
                        onEvent({ type: 'chunk', content });
                    }
                } catch {}
            }
        }
        return fullContent;
    } finally {
        clearTimeout(timeout);
    }
}

// ==================== Agent 主循环（ReAct） ====================

function safeParseArgs(argsStr) {
    if (!argsStr) return {};
    try { return JSON.parse(argsStr); } catch { return {}; }
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

    // 优先使用调用方预组装的 messages（携带会话历史）；否则回退为 [system, user]
    const messages = Array.isArray(opts.messages) && opts.messages.length > 0
        ? [...opts.messages]
        : [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userMessage }
        ];

    const trace = [];
    const toolCallCounts = {}; // 防止单工具死循环

    onEvent({ type: 'start', model, provider: providerConfig.name, tools: AGENT_TOOLS.map(t => t.function.name) });

    for (let iter = 1; iter <= MAX_ITERATIONS; iter++) {
        let resp;
        try {
            resp = await llmCallWithTools(ctx, messages, AGENT_TOOLS);
        } catch (e) {
            // 若 provider 不支持 function calling（通常返回 400），降级为纯流式问答
            if (e.status === 400 || e.status === 404) {
                onEvent({ type: 'fallback', reason: '当前模型不支持 Function Calling，切换为普通问答模式' });
                onEvent({ type: 'final_start', iteration: iter, fallback: true });
                const content = await llmStream(ctx, messages, onEvent);
                onEvent({ type: 'end', content, iterations: iter, fallback: true });
                return { content, iterations: iter, trace, fallback: true };
            }
            throw e;
        }

        const choice = resp.choices[0];
        const msg = choice.message;
        const finishReason = choice.finish_reason;

        // 无工具调用 → 进入最终流式输出
        if (!msg.tool_calls || msg.tool_calls.length === 0 || finishReason === 'stop') {
            onEvent({ type: 'final_start', iteration: iter });
            // 将 assistant 的中间内容（若有）作为思考记录
            if (msg.content) {
                trace.push({ iteration: iter, type: 'thought', content: msg.content });
                onEvent({ type: 'thought', content: msg.content, iteration: iter });
            }
            const finalMessages = [...messages];
            if (msg.content) finalMessages.push({ role: 'assistant', content: msg.content });
            const content = await llmStream(ctx, finalMessages, onEvent);
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
                result = await executeTool(toolName, args, ctx);
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
    const content = await llmStream(ctx, messages, onEvent);
    onEvent({ type: 'end', content, iterations: MAX_ITERATIONS, reason: 'max_iterations' });
    return { content, iterations: MAX_ITERATIONS, trace, maxedOut: true };
}

module.exports = {
    AGENT_TOOLS,
    runAgentLoop,
    executeTool,
    splitChapters
};
