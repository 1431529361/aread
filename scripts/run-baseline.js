/**
 * P0 基线评测运行器（显式启动，默认 dry-run 展示计划）。
 *
 * 在线：npm run test:online -- --env-file <凭据env> --suite all --repeat 3
 *   凭据env至少含 ZHIPU_API_KEY 或 SILICONFLOW_API_KEY；Embedding 可选
 *   EMBED_BASE_URL / EMBED_MODEL_NAME / EMBED_API_KEY（阿里云），否则复用对话Key走预置。
 *  plumbing 验证（非在线成绩）：node scripts/run-baseline.js --fake --suite all --repeat 1
 *
 * 产出：docs/baseline-results/<runId>/ 下 JSONL 原始记录 + summary.json + report.md
 * 记录：样本ID、语料hash、模型、检索路径、召回片段预览、答案、延迟、调用数、错误/降级。
 * 不打印任何密钥；召回片段仅存预览与命中标记，不整段复制受版权保护原文。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const REPO_ROOT = path.join(__dirname, '..');
const BASELINE = path.join(REPO_ROOT, 'docs', 'baseline');
const { startIsolatedServer, api, registerUser } = require('../tests/helpers/isolated-server');

function parseArgs(argv) {
    const args = { suite: 'all', repeat: 3, provider: 'zhipu', model: null, limit: null, dryRun: false, fake: false, envFile: null };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--suite') args.suite = argv[++i];
        else if (a === '--repeat') args.repeat = parseInt(argv[++i], 10);
        else if (a === '--provider') args.provider = argv[++i];
        else if (a === '--model') args.model = argv[++i];
        else if (a === '--limit') args.limit = parseInt(argv[++i], 10);
        else if (a === '--env-file') args.envFile = argv[++i];
        else if (a === '--dry-run') args.dryRun = true;
        else if (a === '--fake') args.fake = true;
    }
    return args;
}

function normalize(s) { return String(s).replace(/\s+/g, ''); }

function loadEnvFile(file) {
    if (!file) return;
    const abs = path.resolve(file);
    if (!fs.existsSync(abs)) throw new Error(`凭据env文件不存在: ${abs}`);
    require('dotenv').config({ path: abs, override: true });
}

function resolveConfig(args) {
    const provider = args.provider;
    const model = args.model || process.env.AI_MODEL || null;
    const hasZhipu = !!process.env.ZHIPU_API_KEY;
    const hasSilicon = !!process.env.SILICONFLOW_API_KEY;
    // 通用 OpenAI 兼容端点（自定义 base URL + key + model）
    const genericEndpoint = process.env.CUSTOM_API_ENDPOINT || process.env.AI_BASE_URL || null;
    const genericKey = process.env.CUSTOM_API_KEY || process.env.AI_API_KEY || null;
    const hasGeneric = !!(genericEndpoint && genericKey);
    const embed = {
        mode: process.env.EMBED_BASE_URL && process.env.EMBED_API_KEY ? 'aliyun' : (hasZhipu ? 'zhipu' : (hasSilicon ? 'siliconflow' : (hasGeneric ? 'generic' : 'off'))),
        baseUrl: process.env.EMBED_BASE_URL || null,
        model: process.env.EMBED_MODEL_NAME || null
    };
    return { provider, model, hasZhipu, hasSilicon, hasGeneric, genericEndpoint, genericKey, embed };
}

function printPlan(args, cfg, ds, mem) {
    const ragCount = args.limit ? Math.min(args.limit, ds.questions.length) : ds.questions.length;
    console.log('================ P0 基线评测计划 ================');
    console.log(`模式: ${args.fake ? 'FAKE（本地假模型，仅验证流程，非在线成绩）' : 'ONLINE（真实模型）'}`);
    console.log(`对话提供商: ${cfg.hasGeneric ? '通用OpenAI兼容端点' : cfg.provider}  模型: ${cfg.model || '(提供商默认)'}`);
    if (cfg.hasGeneric) console.log(`端点: ${cfg.genericEndpoint}（不打印密钥）`);
    console.log(`凭据: zhipu=${cfg.hasZhipu} siliconflow=${cfg.hasSilicon} generic=${cfg.hasGeneric}（不打印密钥内容）`);
    console.log(`Embedding: ${cfg.embed.mode}${cfg.embed.model ? ' / ' + cfg.embed.model : ''}`);
    console.log(`套件: ${args.suite}  重复次数: ${args.repeat}`);
    if (args.suite !== 'memory') console.log(`RAG题数: ${ragCount}（检索对照 BM25 vs 混合；答案入口 normal/agent-hybrid/agent-bm25）`);
    if (args.suite !== 'rag') console.log(`记忆脚本: ${mem.scripts.length} 段`);
    console.log('用途: 建立改造前可比较基线，只测开发集，不调正式保留集。');
    console.log('================================================');
}

// ---- SSE 读取（带首字计时） ----
async function streamCall(base, reqPath, { token, body }) {
    const t0 = performance.now();
    let firstChunkAt = null;
    const events = [];
    const res = await fetch(base + reqPath, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body)
    });
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('text/event-stream')) {
        const text = await res.text();
        let json = null; try { json = JSON.parse(text); } catch {}
        return { status: res.status, events, json, firstChunkMs: null, totalMs: performance.now() - t0, answer: null };
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let answer = '';
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                let evt; try { evt = JSON.parse(line.slice(6)); } catch { continue; }
                events.push(evt);
                if (evt.type === 'chunk' && evt.content) {
                    if (firstChunkAt === null) firstChunkAt = performance.now();
                    answer += evt.content;
                }
                if (evt.type === 'end') {
                    if (evt.content) answer = evt.content;
                    if (firstChunkAt === null && evt.content) firstChunkAt = performance.now();
                }
            }
        }
    } finally { try { reader.cancel(); } catch {} }
    return {
        status: res.status, events, json: null,
        firstChunkMs: firstChunkAt === null ? null : firstChunkAt - t0,
        totalMs: performance.now() - t0,
        answer
    };
}

function toolBehavior(events) {
    const calls = events.filter(e => e.type === 'tool_call').map(e => ({ name: e.name, args: e.args }));
    const results = events.filter(e => e.type === 'tool_result').map(e => ({ name: e.name, source: e.result && e.result.source, error: e.result && e.result.error }));
    const fallback = events.find(e => e.type === 'fallback');
    const error = events.find(e => e.type === 'error');
    return { calls, results, fallback: fallback ? fallback.reason : null, error: error ? error.error : null };
}

function retrievalMetrics(hits, goldQuotes) {
    const normHits = hits.map(h => normalize(h.text));
    const matched = goldQuotes.map(q => normHits.some(t => t.includes(normalize(q))));
    const hit = goldQuotes.length === 0 ? null : matched.some(Boolean);
    const recall = goldQuotes.length === 0 ? null : matched.filter(Boolean).length / goldQuotes.length;
    let mrr = 0;
    if (goldQuotes.length) {
        for (let i = 0; i < normHits.length; i++) {
            if (goldQuotes.some(q => normHits[i].includes(normalize(q)))) { mrr = 1 / (i + 1); break; }
        }
    }
    return { hit, recall, mrr, matched };
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    loadEnvFile(args.envFile);
    const cfg = resolveConfig(args);
    const ds = JSON.parse(fs.readFileSync(path.join(BASELINE, 'dev-rag-questions.json'), 'utf-8'));
    const mem = JSON.parse(fs.readFileSync(path.join(BASELINE, 'dev-memory-scripts.json'), 'utf-8'));
    printPlan(args, cfg, ds, mem);

    if (args.dryRun) { console.log('dry-run：未启动服务、未调用模型。'); return; }
    if (!args.fake && !cfg.hasZhipu && !cfg.hasSilicon && !cfg.hasGeneric) {
        console.error('在线模式缺少凭据：请在 --env-file 中配置 ZHIPU_API_KEY / SILICONFLOW_API_KEY，或通用端点 CUSTOM_API_ENDPOINT+CUSTOM_API_KEY+AI_MODEL。未运行任何在线调用。');
        process.exit(2);
    }

    const runId = `${args.fake ? 'fake' : 'online'}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    const outDir = path.join(REPO_ROOT, 'docs', 'baseline-results', runId);
    fs.mkdirSync(outDir, { recursive: true });
    const writeJsonl = (name, obj) => fs.appendFileSync(path.join(outDir, name), JSON.stringify(obj) + '\n', 'utf-8');

    let fake = null;
    if (args.fake) {
        const { startFakeModelServer } = require('../tests/helpers/fake-model-server');
        fake = await startFakeModelServer();
    }
    const srv = await startIsolatedServer({ keepKeys: !args.fake });
    const user = await registerUser(srv.url, 'p0-baseline');

    // 配置提供商
    let providerId = args.provider;
    if (args.fake) {
        const p = await api(srv.url, '/api/providers', {
            method: 'POST', token: user.token,
            body: { id: 'fakeprov', name: 'FakeProv', apiEndpoint: `${fake.url}/v1`, defaultModel: 'fake-model', apiKey: 'sk-p0-baseline-0123456789abcdef' }
        });
        if (p.status !== 200) throw new Error('创建假提供商失败: ' + p.text);
        providerId = 'fakeprov';
    } else if (cfg.hasGeneric) {
        const p = await api(srv.url, '/api/providers', {
            method: 'POST', token: user.token,
            body: { id: 'custom-baseline', name: 'BaselineEndpoint', apiEndpoint: cfg.genericEndpoint, defaultModel: cfg.model || 'default', apiKey: cfg.genericKey }
        });
        if (p.status !== 200) throw new Error('创建通用端点提供商失败（检查端点/密钥/模型）: ' + p.text);
        providerId = 'custom-baseline';
    }
    const model = args.model || (args.fake ? 'fake-model' : (process.env.AI_MODEL || null));

    // 配置 Embedding
    async function setEmbedding(mode) {
        if (args.fake) {
            await api(srv.url, '/api/embedding-settings', {
                method: 'PUT', token: user.token,
                body: mode === 'off' ? { provider: 'off' } : { provider: 'aliyun', aliyunBaseUrl: `${fake.url}/v1`, aliyunModel: 'fake-embed', aliyunApiKey: 'sk-p0-baseline-embed-0123456789' }
            });
        } else if (mode === 'off') {
            await api(srv.url, '/api/embedding-settings', { method: 'PUT', token: user.token, body: { provider: 'off' } });
        } else if (cfg.embed.mode === 'aliyun') {
            await api(srv.url, '/api/embedding-settings', { method: 'PUT', token: user.token, body: { provider: 'aliyun', aliyunBaseUrl: cfg.embed.baseUrl, aliyunModel: cfg.embed.model } });
        } else if (cfg.embed.mode === 'generic' && process.env.EMBED_MODEL_NAME) {
            // 通用端点同时提供 embeddings：复用其 base URL 与 Key，模型名取 EMBED_MODEL_NAME
            await api(srv.url, '/api/embedding-settings', { method: 'PUT', token: user.token, body: { provider: 'aliyun', aliyunBaseUrl: cfg.genericEndpoint, aliyunModel: process.env.EMBED_MODEL_NAME, aliyunApiKey: cfg.genericKey } });
        } else if (cfg.embed.mode === 'generic') {
            console.warn('未提供 EMBED_MODEL_NAME，通用端点无法确定 Embedding 模型，降级为纯 BM25。');
            await api(srv.url, '/api/embedding-settings', { method: 'PUT', token: user.token, body: { provider: 'off' } });
        } else {
            await api(srv.url, '/api/embedding-settings', { method: 'PUT', token: user.token, body: { provider: cfg.embed.mode } });
        }
    }

    // 上传两本书
    const bookIds = {};
    const bookHashes = {};
    for (const [id, rel] of Object.entries(ds.books)) {
        const abs = path.join(REPO_ROOT, rel);
        const content = fs.readFileSync(abs, 'utf-8');
        bookHashes[id] = crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
        const form = new FormData();
        form.append('book', new Blob([content], { type: 'text/plain' }), path.basename(rel));
        const res = await fetch(`${srv.url}/api/books/upload`, { method: 'POST', headers: { Authorization: `Bearer ${user.token}` }, body: form });
        const data = await res.json();
        if (res.status !== 200) throw new Error(`上传失败 ${id}: ${JSON.stringify(data)}`);
        bookIds[id] = data.book.id;
    }

    async function indexAll(mode) {
        await setEmbedding(mode);
        const out = {};
        for (const [id, bookId] of Object.entries(bookIds)) {
            const res = await api(srv.url, `/api/books/${bookId}/index`, { method: 'POST', token: user.token, body: {} });
            out[id] = res.data;
        }
        return out;
    }

    const summary = { runId, mode: args.fake ? 'fake' : 'online', provider: providerId, model, repeat: args.repeat, startedAt: new Date().toISOString(), bookHashes, retrieval: {}, answers: {}, memory: {} };
    // Embedding 可用性：无可用 Embedding 模型时只跑 BM25，避免误导性 hybrid 标签
    const embedAvailable = args.fake || (cfg.embed.mode !== 'off' && (cfg.embed.mode !== 'generic' || !!process.env.EMBED_MODEL_NAME));
    summary.embedAvailable = embedAvailable;
    if (!embedAvailable) console.log('注意: 无可用 Embedding 模型，检索仅跑 BM25；混合向量检索标记为未测。');

    // ---- 直接检索对照（固定 query=question，独立于模型选词） ----
    async function retrievalBaseline() {
        process.env.READER_DATA_ROOT = srv.dataRoot;
        const database = require('../database');
        const rag = require('../rag');
        const embedding = require('../embedding');
        await database.initDB();
        embedding.init({
            getApiKey: (uid, pid) => {
                if (args.fake) return 'sk-p0-baseline-embed-0123456789';
                if (pid === 'aliyun-embed') return process.env.EMBED_API_KEY || (cfg.hasGeneric ? cfg.genericKey : null);
                const map = { zhipu: 'ZHIPU_API_KEY', siliconflow: 'SILICONFLOW_API_KEY' };
                return process.env[map[pid]] || null;
            }
        });
        const questions = args.limit ? ds.questions.slice(0, args.limit) : ds.questions;
        const modes = embedAvailable ? ['embedding+bm25', 'bm25'] : ['bm25'];
        for (const mode of modes) {
            const idx = await indexAll(mode === 'bm25' ? 'off' : 'on');
            const agg = { hit: 0, recallSum: 0, mrrSum: 0, answerable: 0, perQuestion: [] };
            for (const q of questions) {
                const bookId = bookIds[q.book];
                let hits = [];
                let err = null;
                const t0 = performance.now();
                try { hits = await rag.retrieveAsync(user.userId, bookId, q.question, 5); }
                catch (e) { err = e.message; }
                const elapsed = performance.now() - t0;
                const m = retrievalMetrics(hits, q.goldQuotes || []);
                if (q.goldQuotes && q.goldQuotes.length) {
                    agg.answerable++;
                    if (m.hit) agg.hit++;
                    agg.recallSum += m.recall || 0;
                    agg.mrrSum += m.mrr || 0;
                }
                const rec = {
                    id: q.id, book: q.book, group: q.group, mode, query: q.question,
                    latencyMs: Math.round(elapsed), error: err,
                    hit: m.hit, recall: m.recall, mrr: m.mrr,
                    retrieved: hits.map((h, i) => ({ rank: i + 1, chapter: h.chapter, score: h.score, preview: String(h.text).slice(0, 120), matchedGold: (q.goldQuotes || []).some(g => normalize(h.text).includes(normalize(g))) }))
                };
                writeJsonl('rag-retrieval.jsonl', rec);
                agg.perQuestion.push({ id: q.id, hit: m.hit, recall: m.recall, mrr: m.mrr });
            }
            summary.retrieval[mode] = {
                answerable: agg.answerable,
                hitAt5: agg.answerable ? agg.hit / agg.answerable : null,
                evidenceRecallAt5: agg.answerable ? agg.recallSum / agg.answerable : null,
                mrrAt5: agg.answerable ? agg.mrrSum / agg.answerable : null,
                indexModes: idx
            };
            console.log(`[检索 ${mode}] Hit@5=${(summary.retrieval[mode].hitAt5 || 0).toFixed(3)} Recall@5=${(summary.retrieval[mode].evidenceRecallAt5 || 0).toFixed(3)} MRR@5=${(summary.retrieval[mode].mrrAt5 || 0).toFixed(3)} (n=${agg.answerable})`);
        }
        // 关闭评测进程持有的隔离库句柄，避免 Windows 下临时目录删除被文件锁阻塞
        try { database.getDB().close(); } catch {}
    }

    // ---- 答案基线（双入口） ----
    async function answerBaseline() {
        const questions = args.limit ? ds.questions.slice(0, args.limit) : ds.questions;
        const conditions = [
            { name: 'normal', entry: '/api/ask-stream', embed: 'on' },
            ...(embedAvailable ? [{ name: 'agent-hybrid', entry: '/api/agent/stream', embed: 'on' }] : []),
            { name: 'agent-bm25', entry: '/api/agent/stream', embed: 'off' }
        ];
        for (const cond of conditions) {
            await indexAll(cond.embed);
            const agg = { n: 0, errors: 0, firstChunk: [], total: [], toolCalls: 0 };
            for (const q of questions) {
                for (let r = 0; r < args.repeat; r++) {
                    const bookId = bookIds[q.book];
                    const newConv = await api(srv.url, '/api/conversations', { method: 'POST', token: user.token, body: { bookId } });
                    const convId = newConv.data.conversation.id;
                    const turns = q.turns || [q.question];
                    let last = null;
                    const turnRecords = [];
                    for (const turn of turns) {
                        last = await streamCall(srv.url, cond.entry, {
                            token: user.token,
                            body: { question: turn, bookId, bookName: q.book, provider: providerId, model, conversationId: convId }
                        });
                        turnRecords.push({ question: turn, answer: last.answer, firstChunkMs: last.firstChunkMs, totalMs: last.totalMs, status: last.status, tools: toolBehavior(last.events) });
                    }
                    const beh = toolBehavior(last.events);
                    const failed = last.status !== 200 || beh.error || !last.answer;
                    agg.n++;
                    if (failed) agg.errors++;
                    if (last.firstChunkMs != null) agg.firstChunk.push(last.firstChunkMs);
                    agg.total.push(last.totalMs);
                    agg.toolCalls += beh.calls.length;
                    writeJsonl('rag-answers.jsonl', {
                        id: q.id, book: q.book, group: q.group, condition: cond.name, repeat: r,
                        needsEvidence: q.needsEvidence, isLongTask: q.isLongTask,
                        expected: q.expected, turns: turnRecords,
                        finalAnswer: last.answer, error: beh.error, fallback: beh.fallback,
                        toolCallCount: beh.calls.length, firstChunkMs: last.firstChunkMs, totalMs: last.totalMs
                    });
                }
            }
            const pct = (arr, p) => { if (!arr.length) return null; const s = [...arr].sort((a, b) => a - b); return Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))]); };
            summary.answers[cond.name] = {
                runs: agg.n, errors: agg.errors, errorRate: agg.n ? agg.errors / agg.n : null,
                avgToolCalls: agg.n ? agg.toolCalls / agg.n : null,
                firstChunkP50: pct(agg.firstChunk, 0.5), firstChunkP95: pct(agg.firstChunk, 0.95),
                totalP50: pct(agg.total, 0.5), totalP95: pct(agg.total, 0.95)
            };
            console.log(`[答案 ${cond.name}] n=${agg.n} 错误=${agg.errors} 首字P50=${summary.answers[cond.name].firstChunkP50}ms 总耗时P50=${summary.answers[cond.name].totalP50}ms`);
        }
    }

    // ---- 记忆脚本 ----
    async function clearMemories(token) {
        const st = (await api(srv.url, '/api/memory-settings', { token })).data;
        return api(srv.url, '/api/memories', { method: 'DELETE', token, body: { expectedEpoch: st.epoch } });
    }
    async function memoryBaseline() {
        await indexAll('on');
        for (const s of mem.scripts) {
            await clearMemories(user.token);
            const bookId = bookIds[s.book];
            const newConv = await api(srv.url, '/api/conversations', { method: 'POST', token: user.token, body: { bookId } });
            let convId = newConv.data.conversation.id;
            const turnRecords = [];
            const sendTurn = async (t, cid) => {
                const body = typeof t === 'string'
                    ? { question: t, bookId, provider: providerId, model, conversationId: cid }
                    : { question: t.question, text: t.text, bookId, provider: providerId, model, conversationId: cid };
                const r = await streamCall(srv.url, '/api/ask-stream', { token: user.token, body });
                turnRecords.push({ turn: t, answer: r.answer, status: r.status });
                return r;
            };
            for (const t of s.turns) await sendTurn(t, convId);
            if (s.switchBook) {
                const b2 = bookIds[s.switchBook];
                const c2 = await api(srv.url, '/api/conversations', { method: 'POST', token: user.token, body: { bookId: b2 } });
                for (const t of s.turns2 || []) await sendTurn(t, c2.data.conversation.id);
            }
            // 等待异步抽取（新治理后台串行，真实模型可能较久）
            await new Promise(r => setTimeout(r, 8000));
            let memories = (await api(srv.url, '/api/memories', { token: user.token })).data.memories || [];
            if (s.action === 'deleteAllMemories') {
                await clearMemories(user.token);
                memories = (await api(srv.url, '/api/memories', { token: user.token })).data.memories || [];
            }
            // 断言检查
            const checks = (s.assertions || []).map(a => {
                if (a.type === 'memoryCount') return { ...a, pass: memories.length === a.equals, actual: memories.length };
                if (a.type === 'memoryContains') return { ...a, pass: memories.some(m => (!a.kind || m.kind === a.kind) && m.content.includes(a.substring)) };
                if (a.type === 'noUserMemory' || a.type === 'noStablePreference' || a.type === 'noActiveMemory') return { ...a, pass: !memories.some(m => m.content.includes(a.substring)) };
                if (a.type === 'maxPreferenceCount') return { ...a, pass: memories.filter(m => m.content.includes(a.substring)).length <= a.max, actual: memories.filter(m => m.content.includes(a.substring)).length };
                if (a.type === 'noNewMemory') return { ...a, pass: memories.length === 0, actual: memories.length };
                return { ...a, pass: null, note: '需人工标注' };
            });
            // 探针（新会话）：memory-on 与 memory-off 对照
            const probes = [];
            for (const p of s.probes || []) {
                const pc = await api(srv.url, '/api/conversations', { method: 'POST', token: user.token, body: { bookId } });
                const onResp = await streamCall(srv.url, '/api/ask-stream', { token: user.token, body: { question: p.question, bookId, provider: providerId, model, conversationId: pc.data.conversation.id } });
                await clearMemories(user.token);
                const pc2 = await api(srv.url, '/api/conversations', { method: 'POST', token: user.token, body: { bookId } });
                const offResp = await streamCall(srv.url, '/api/ask-stream', { token: user.token, body: { question: p.question, bookId, provider: providerId, model, conversationId: pc2.data.conversation.id } });
                probes.push({ question: p.question, expect: p.expect, memoryOnAnswer: onResp.answer, memoryOffAnswer: offResp.answer });
            }
            writeJsonl('memory.jsonl', { id: s.id, scenario: s.scenario, book: s.book, turns: turnRecords, memoriesAfter: memories.map(m => ({ kind: m.kind, content: m.content })), checks, probes });
            summary.memory[s.id] = { scenario: s.scenario, memoryCount: memories.length, checksPass: checks.filter(c => c.pass === true).length, checksTotal: checks.length, checks };
            console.log(`[记忆 ${s.id} ${s.scenario}] 记忆数=${memories.length} 断言通过=${checks.filter(c => c.pass === true).length}/${checks.length}`);
        }
    }

    try {
        if (args.suite !== 'memory') { await retrievalBaseline(); await answerBaseline(); }
        if (args.suite !== 'rag') { await memoryBaseline(); }
    } catch (e) {
        summary.fatalError = e.message;
        console.error('评测中断:', e);
    } finally {
        summary.finishedAt = new Date().toISOString();
        fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2), 'utf-8');
        writeReport(outDir, summary, args);
        await srv.stop();
        if (fake) await fake.close();
    }
    console.log(`\n结果已写入: ${outDir}`);
    if (summary.fatalError) process.exit(1);
}

function writeReport(outDir, summary, args) {
    const lines = [];
    lines.push(`# P0 基线评测报告（${summary.mode === 'fake' ? 'FAKE 流程验证，非在线成绩' : 'ONLINE 开发集初测'}）`);
    lines.push('');
    lines.push(`- 运行ID: ${summary.runId}`);
    lines.push(`- 提供商/模型: ${summary.provider} / ${summary.model || '默认'}`);
    lines.push(`- 重复次数: ${summary.repeat}`);
    lines.push(`- 开始/结束: ${summary.startedAt} / ${summary.finishedAt || ''}`);
    lines.push(`- 语料hash: ${JSON.stringify(summary.bookHashes)}`);
    if (summary.fatalError) lines.push(`- **致命错误**: ${summary.fatalError}`);
    lines.push('');
    if (Object.keys(summary.retrieval).length) {
        lines.push('## 检索对照（固定query=question，Top5）');
        lines.push('');
        lines.push('| 模式 | 可答题数 | Hit@5 | Evidence Recall@5 | MRR@5 |');
        lines.push('| --- | --- | --- | --- | --- |');
        for (const [mode, r] of Object.entries(summary.retrieval)) {
            lines.push(`| ${mode} | ${r.answerable} | ${fmt(r.hitAt5)} | ${fmt(r.evidenceRecallAt5)} | ${fmt(r.mrrAt5)} |`);
        }
        lines.push('');
    }
    if (Object.keys(summary.answers).length) {
        lines.push('## 答案基线（双入口；正确率待人工标注）');
        lines.push('');
        lines.push('| 条件 | 运行数 | 错误率 | 平均工具调用 | 首字P50(ms) | 首字P95(ms) | 总耗时P50(ms) |');
        lines.push('| --- | --- | --- | --- | --- | --- | --- |');
        for (const [c, r] of Object.entries(summary.answers)) {
            lines.push(`| ${c} | ${r.runs} | ${fmt(r.errorRate)} | ${fmt(r.avgToolCalls)} | ${r.firstChunkP50 ?? '未测'} | ${r.firstChunkP95 ?? '未测'} | ${r.totalP50 ?? '未测'} |`);
        }
        lines.push('');
    }
    if (Object.keys(summary.memory).length) {
        lines.push('## 记忆脚本（确定性断言；precision/遵从率待人工标注）');
        lines.push('');
        lines.push('| 脚本 | 场景 | 记忆数 | 断言通过 |');
        lines.push('| --- | --- | --- | --- |');
        for (const [id, r] of Object.entries(summary.memory)) {
            lines.push(`| ${id} | ${r.scenario} | ${r.memoryCount} | ${r.checksPass}/${r.checksTotal} |`);
        }
        lines.push('');
    }
    lines.push('## 口径与限制');
    lines.push('- 本报告仅开发集初测，非正式保留集成绩；答案正确率/记忆precision/偏好遵从率需人工标注。');
    lines.push('- 检索指标基于本地原文金标准子串匹配；no-answer题不计入Hit分母。');
    lines.push('- 首字时间从请求发起到首个答案内容chunk，不含“开始检索”事件。');
    lines.push('- 召回片段仅存120字预览与命中标记，不整段复制原文。');
    if (summary.mode === 'fake') lines.push('- **FAKE模式使用本地假模型，所有质量数字无效，仅验证评测流程可运行。**');
    fs.writeFileSync(path.join(outDir, 'report.md'), lines.join('\n'), 'utf-8');
}

function fmt(x) { return x == null ? '未测' : (typeof x === 'number' ? x.toFixed(3) : String(x)); }

main().catch(e => { console.error(e); process.exit(1); });