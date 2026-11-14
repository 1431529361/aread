/**
 * 本地假模型服务（OpenAI 兼容），仅供离线测试使用。
 * - /v1/chat/completions：非流式 / 流式 / function calling，按控制面脚本返回确定性结果
 * - /v1/embeddings：字符哈希确定性向量（1024 维），相似文本余弦相近
 * - /__control：测试设置行为（错误注入、断流、工具脚本、记忆抽取结果等）
 * 不访问外网，不读取任何真实密钥。
 */
const http = require('http');

function defaultState() {
    return {
        chatReply: '这是本地假模型的确定性回答。',
        streamChunks: ['这是', '本地假模型', '的确定性回答。'],
        extraction: '[]',
        summary: '摘要：本地假模型生成的会话摘要。',
        toolScript: null,
        finalAfterTools: '基于工具检索结果的最终回答。',
        httpError: null,
        toolHttpError: null,
        cutStreamAfter: null,
        embedError: null,
        rerankError: null,
        latencyMs: 0
    };
}

function embedText(text, dims = 1024) {
    const v = new Array(dims).fill(0);
    for (const ch of String(text)) {
        const code = ch.codePointAt(0);
        v[code % dims] += 1;
        v[(code * 31) % dims] += 0.5;
    }
    const norm = Math.sqrt(v.reduce((a, b) => a + b * b, 0)) || 1;
    return v.map(x => x / norm);
}

function lastUserContent(body) {
    const msgs = body.messages || [];
    for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].role === 'user') return String(msgs[i].content || '');
    }
    return '';
}

function pickReply(body, state) {
    const content = lastUserContent(body);
    if (content.includes('记忆抽取器')) return state.extraction;
    if (content.includes('压缩为简洁的要点摘要')) return state.summary;
    const toolMsgCount = (body.messages || []).filter(m => m.role === 'tool').length;
    if (toolMsgCount > 0) return state.finalAfterTools;
    return state.chatReply;
}

function startFakeModelServer() {
    let state = defaultState();
    const requests = [];

    const server = http.createServer((req, res) => {
        let raw = '';
        req.on('data', c => { raw += c; });
        req.on('end', async () => {
            let body = {};
            try { body = raw ? JSON.parse(raw) : {}; } catch {}
            const url = req.url || '';

            if (url === '/__control' && req.method === 'POST') {
                state = { ...state, ...body };
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ ok: true, state }));
            }
            if (url === '/__control' && req.method === 'GET') {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify(state));
            }
            if (url === '/__reset' && req.method === 'POST') {
                state = defaultState();
                requests.length = 0;
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ ok: true }));
            }

            requests.push({ path: url, auth: req.headers.authorization || null, body });
            if (state.latencyMs) await new Promise(r => setTimeout(r, state.latencyMs));

            if (url.endsWith('/embeddings')) {
                if (state.embedError) {
                    res.writeHead(state.embedError.status || 500, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify(state.embedError.body || { error: { message: 'fake embed error' } }));
                }
                const texts = body.input || [];
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({
                    data: texts.map((t, i) => ({ index: i, embedding: embedText(t) })),
                    model: body.model || 'fake-embed',
                    usage: { prompt_tokens: texts.join('').length, total_tokens: texts.join('').length }
                }));
            }

            if (url.endsWith('/rerank')) {
                if (state.rerankError) {
                    res.writeHead(state.rerankError.status || 500, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify(state.rerankError.body || { error: { message: 'fake rerank error' } }));
                }
                const query = String(body.query || '');
                const docs = body.documents || [];
                const qSet = new Set([...query]);
                const scored = docs.map((d, index) => {
                    let overlap = 0;
                    for (const ch of String(d)) if (qSet.has(ch)) overlap++;
                    return { index, relevance_score: overlap / (String(d).length || 1) };
                });
                scored.sort((a, b) => b.relevance_score - a.relevance_score);
                const n = Math.min(body.top_n || scored.length, scored.length);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ results: scored.slice(0, n), meta: { tokens: { input_tokens: query.length } } }));
            }

            if (url.endsWith('/chat/completions')) {
                const err = (body.tools && state.toolHttpError) || state.httpError;
                if (err) {
                    res.writeHead(err.status || 500, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify(err.body || { error: { message: 'fake error' } }));
                }

                const toolMsgCount = (body.messages || []).filter(m => m.role === 'tool').length;
                const script = state.toolScript;
                if (body.tools && script && toolMsgCount < script.length) {
                    const step = script[toolMsgCount];
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({
                        choices: [{
                            message: {
                                role: 'assistant',
                                content: step.thought || null,
                                tool_calls: [{
                                    id: `call_${toolMsgCount + 1}`,
                                    type: 'function',
                                    function: { name: step.name, arguments: step.rawArguments !== undefined ? step.rawArguments : JSON.stringify(step.args || {}) }
                                }]
                            },
                            finish_reason: 'tool_calls'
                        }],
                        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 }
                    }));
                }

                const reply = pickReply(body, state);
                if (body.stream) {
                    res.writeHead(200, {
                        'Content-Type': 'text/event-stream',
                        'Cache-Control': 'no-cache',
                        'Connection': 'keep-alive'
                    });
                    const chunks = state.streamChunks && state.streamChunks.length
                        ? state.streamChunks
                        : [reply];
                    let sent = 0;
                    for (const c of chunks) {
                        if (state.cutStreamAfter !== null && sent >= state.cutStreamAfter) {
                            res.destroy();
                            return;
                        }
                        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`);
                        sent++;
                        await new Promise(r => setTimeout(r, 5));
                    }
                    res.write('data: [DONE]\n\n');
                    return res.end();
                }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({
                    choices: [{ message: { role: 'assistant', content: reply }, finish_reason: 'stop' }],
                    usage: { prompt_tokens: 10, completion_tokens: reply.length, total_tokens: 10 + reply.length }
                }));
            }

            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'not found' }));
        });
    });

    return new Promise((resolve, reject) => {
        server.listen(0, '127.0.0.1', () => {
            const port = server.address().port;
            const url = `http://127.0.0.1:${port}`;
            resolve({
                server,
                port,
                url,
                chatEndpoint: `${url}/v1/chat/completions`,
                embedEndpoint: `${url}/v1/embeddings`,
                requests,
                getState: () => state,
                async control(patch) {
                    const res = await fetch(`${url}/__control`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(patch)
                    });
                    return res.json();
                },
                async reset() {
                    await fetch(`${url}/__reset`, { method: 'POST' });
                },
                close() {
                    return new Promise(r => server.close(r));
                }
            });
        });
        server.on('error', reject);
    });
}

module.exports = { startFakeModelServer, embedText };