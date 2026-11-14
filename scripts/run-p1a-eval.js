/**
 * P1a 真实模型对照评测：统一入口跑 P0 开发集，测无据回答率/工具调用/首字时延，对比 P0 基线。
 * 用法：node scripts/run-p1a-eval.js --env-file .env.baseline.local [--limit N] [--rerank]
 * 产出：docs/baseline-results/p1a-<ts>/ answers.jsonl + summary.json + report.md
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const REPO_ROOT = path.join(__dirname, '..');
const BASELINE = path.join(REPO_ROOT, 'docs', 'baseline');
const { startIsolatedServer, api, registerUser } = require('../tests/helpers/isolated-server');

function parseArgs(argv) {
    const a = { envFile: null, limit: null, rerank: false };
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--env-file') a.envFile = argv[++i];
        else if (argv[i] === '--limit') a.limit = parseInt(argv[++i], 10);
        else if (argv[i] === '--rerank') a.rerank = true;
    }
    return a;
}

async function unifiedAsk(base, token, body) {
    const t0 = performance.now();
    let firstAnswerAt = null;
    const events = [];
    const res = await fetch(base + '/api/ask-stream', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body)
    });
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('text/event-stream')) {
        const text = await res.text();
        return { status: res.status, events, answer: null, firstAnswerMs: null, totalMs: performance.now() - t0, json: text };
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '', answer = '', answerKind = null, toolCalls = 0, evidenceCount = 0, endStatus = null, fallback = false;
    const handle = (evt) => {
        events.push(evt);
        const d = evt.data || {};
        if (evt.type === 'tool_call') toolCalls++;
        else if (evt.type === 'evidence') evidenceCount = (d.items || []).length;
        else if (evt.type === 'warning') fallback = true;
        else if (evt.type === 'answer_start') answerKind = d.answerKind;
        else if (evt.type === 'chunk') { if (firstAnswerAt === null) firstAnswerAt = performance.now(); answer += d.content || ''; }
        else if (evt.type === 'end') { endStatus = d.status; if (d.assistantMessage && d.assistantMessage.content != null && !answer) answer = d.assistantMessage.content; }
    };
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n'); buffer = lines.pop() || '';
        for (const line of lines) { if (line.startsWith('data:')) { const s = line.slice(5).trim(); if (s) { try { handle(JSON.parse(s)); } catch {} } } }
    }
    buffer += decoder.decode();
    for (const line of buffer.split('\n')) { if (line.startsWith('data:')) { const s = line.slice(5).trim(); if (s) { try { handle(JSON.parse(s)); } catch {} } } }
    return { status: res.status, events, answer, answerKind, toolCalls, evidenceCount, endStatus, fallback, firstAnswerMs: firstAnswerAt ? firstAnswerAt - t0 : null, totalMs: performance.now() - t0 };
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.envFile) require('dotenv').config({ path: path.resolve(args.envFile), override: true });
    const ds = JSON.parse(fs.readFileSync(path.join(BASELINE, 'dev-rag-questions.json'), 'utf-8'));
    const questions = args.limit ? ds.questions.slice(0, args.limit) : ds.questions;
    const hasGeneric = !!(process.env.CUSTOM_API_ENDPOINT && (process.env.CUSTOM_API_KEY || process.env.AI_API_KEY));
    const model = process.env.AI_MODEL || null;
    console.log(`P1a评测: 模型=${model} 题数=${questions.length} rerank=${args.rerank}（不打印密钥）`);
    if (!hasGeneric && !process.env.ZHIPU_API_KEY && !process.env.SILICONFLOW_API_KEY) { console.error('缺少凭据'); process.exit(2); }

    const runId = `p1a-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    const outDir = path.join(REPO_ROOT, 'docs', 'baseline-results', runId);
    fs.mkdirSync(outDir, { recursive: true });
    const jsonl = (o) => fs.appendFileSync(path.join(outDir, 'answers.jsonl'), JSON.stringify(o) + '\n', 'utf-8');

    const srv = await startIsolatedServer({ keepKeys: true });
    const user = await registerUser(srv.url, 'p1a-eval');
    let providerId = args.provider || 'zhipu';
    if (hasGeneric) {
        const p = await api(srv.url, '/api/providers', { method: 'POST', token: user.token, body: { id: 'custom-baseline', name: 'Baseline', apiEndpoint: process.env.CUSTOM_API_ENDPOINT, defaultModel: model || 'default', apiKey: process.env.CUSTOM_API_KEY || process.env.AI_API_KEY } });
        if (p.status !== 200) throw new Error('创建提供商失败: ' + p.text);
        providerId = 'custom-baseline';
    }
    // 自定义向量
    if (process.env.EMBED_BASE_URL && process.env.EMBED_API_KEY) {
        await api(srv.url, '/api/embedding-settings', { method: 'PUT', token: user.token, body: { provider: 'custom', customBaseUrl: process.env.EMBED_BASE_URL, customModel: process.env.EMBED_MODEL_NAME, customApiKey: process.env.EMBED_API_KEY } });
    }
    if (args.rerank && process.env.RERANK_BASE_URL) {
        await api(srv.url, '/api/rerank-settings', { method: 'PUT', token: user.token, body: { enabled: true, baseUrl: process.env.RERANK_BASE_URL, model: process.env.RERANK_MODEL, topN: 10, rerankApiKey: process.env.RERANK_API_KEY } });
    }
    const bookIds = {};
    for (const [id, rel] of Object.entries(ds.books)) {
        const content = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf-8');
        const form = new FormData();
        form.append('book', new Blob([content], { type: 'text/plain' }), path.basename(rel));
        const res = await fetch(`${srv.url}/api/books/upload`, { method: 'POST', headers: { Authorization: `Bearer ${user.token}` }, body: form });
        bookIds[id] = (await res.json()).book.id;
        await api(srv.url, `/api/books/${bookIds[id]}/index`, { method: 'POST', token: user.token, body: {} });
    }

    const summary = { runId, model, rerank: args.rerank, total: 0, noEvidenceAnswer: 0, insufficient: 0, errors: 0, toolCallsSum: 0, firstAnswer: [], totalMs: [], needsEvidenceTotal: 0, needsEvidenceNoTool: 0 };
    try {
        for (const q of questions) {
            const conv = await api(srv.url, '/api/conversations', { method: 'POST', token: user.token, body: { bookId: bookIds[q.book] } });
            const turns = q.turns || [q.question];
            let last = null;
            for (const turn of turns) {
                last = await unifiedAsk(srv.url, user.token, { requestId: crypto.randomUUID(), question: turn, bookId: bookIds[q.book], provider: providerId, model, conversationId: conv.data.conversation.id });
            }
            const noEvidenceAnswer = last.answerKind === 'answer' && last.evidenceCount === 0;
            summary.total++;
            if (noEvidenceAnswer) summary.noEvidenceAnswer++;
            if (last.answerKind === 'insufficient_evidence') summary.insufficient++;
            if (last.endStatus !== 'completed') summary.errors++;
            summary.toolCallsSum += last.toolCalls || 0;
            if (last.firstAnswerMs != null) summary.firstAnswer.push(last.firstAnswerMs);
            summary.totalMs.push(last.totalMs);
            if (q.needsEvidence) { summary.needsEvidenceTotal++; if ((last.toolCalls || 0) === 0 && last.evidenceCount === 0) summary.needsEvidenceNoTool++; }
            jsonl({ id: q.id, book: q.book, group: q.group, needsEvidence: q.needsEvidence, question: q.question, answerKind: last.answerKind, toolCalls: last.toolCalls, evidenceCount: last.evidenceCount, endStatus: last.endStatus, fallback: last.fallback, firstAnswerMs: last.firstAnswerMs, totalMs: last.totalMs, expected: q.expected, answer: last.answer });
            console.log(`  ${q.id}: kind=${last.answerKind} tools=${last.toolCalls} evidence=${last.evidenceCount} first=${last.firstAnswerMs ? Math.round(last.firstAnswerMs) : '-'}ms status=${last.endStatus}`);
        }
    } catch (e) { summary.fatalError = e.message; console.error('中断:', e); }
    finally {
        const pct = (arr, p) => { if (!arr.length) return null; const s = [...arr].sort((a, b) => a - b); return Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))]); };
        summary.noEvidenceAnswerRate = summary.total ? summary.noEvidenceAnswer / summary.total : null;
        summary.missedRetrievalRate = summary.needsEvidenceTotal ? summary.needsEvidenceNoTool / summary.needsEvidenceTotal : null;
        summary.avgToolCalls = summary.total ? summary.toolCallsSum / summary.total : null;
        summary.firstAnswerP50 = pct(summary.firstAnswer, 0.5);
        summary.firstAnswerP95 = pct(summary.firstAnswer, 0.95);
        summary.totalP50 = pct(summary.totalMs, 0.5);
        summary.finishedAt = new Date().toISOString();
        fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2), 'utf-8');
        const f = x => x == null ? '未测' : (typeof x === 'number' ? x.toFixed(3) : x);
        const report = ['# P1a 真实模型对照报告', '', `- 模型: ${summary.model}  重排: ${summary.rerank}`, `- 题数: ${summary.total}`, '',
            '| 指标 | P1a |', '| --- | --- |',
            `| 无据回答率（answer且无证据） | ${f(summary.noEvidenceAnswerRate)} |`,
            `| 缺证说明数 | ${summary.insufficient} |`,
            `| 需取证漏查率（无工具且无证据） | ${f(summary.missedRetrievalRate)} |`,
            `| 平均工具调用 | ${f(summary.avgToolCalls)} |`,
            `| 错误率 | ${f(summary.total ? summary.errors / summary.total : null)} |`,
            `| 首字P50(ms) | ${summary.firstAnswerP50 ?? '未测'} |`,
            `| 首字P95(ms) | ${summary.firstAnswerP95 ?? '未测'} |`,
            `| 总耗时P50(ms) | ${summary.totalP50 ?? '未测'} |`, '',
            '## 对比 P0 基线', '- P0 agent-bm25：漏查率 11.7%，平均工具 2.30，首字P50 17747ms。', '- P1a 统一入口 + 证据门控：需取证无证据时服务端补查或明确缺证，无据回答率应显著下降。', '', '## 口径', '- 开发集初测，非保留集；答案正确率待人工标注。首字从请求到首个答案chunk。', '- 无据回答率=answerKind为answer且本轮证据为0的比例（书内问题应取证）。'];
        fs.writeFileSync(path.join(outDir, 'report.md'), report.join('\n'), 'utf-8');
        await srv.stop();
    }
    console.log(`\n结果: ${outDir}`);
    console.log(`无据回答率=${f(summary.noEvidenceAnswerRate)} 漏查率=${f(summary.missedRetrievalRate)} 平均工具=${f(summary.avgToolCalls)} 首字P50=${summary.firstAnswerP50}ms`);
    if (summary.fatalError) process.exit(1);
}
function f(x) { return x == null ? '未测' : (typeof x === 'number' ? x.toFixed(3) : x); }
main().catch(e => { console.error(e); process.exit(1); });