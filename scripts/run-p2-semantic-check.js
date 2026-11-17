/**
 * P3-记忆 语义召回端到端验证：词法漏召回的 fact.role 经语义补充注入；无关问题不注入。
 * 用法：node scripts/run-p2-semantic-check.js --env-file .env.baseline.local
 * 产出：docs/baseline-results/p2-semantic-<ts>.json
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const REPO_ROOT = path.join(__dirname, '..');
const { startIsolatedServer, api, registerUser } = require('../tests/helpers/isolated-server');
const TU = require('../text-utils');

function parseArgs(argv) {
    const a = { envFile: null };
    for (let i = 0; i < argv.length; i++) if (argv[i] === '--env-file') a.envFile = argv[++i];
    return a;
}
async function ask(base, token, body) {
    const res = await fetch(base + '/api/ask-stream', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '', metadata = null, requestId = body.requestId;
    const handle = (evt) => { if (evt.type === 'end' && evt.data.assistantMessage) metadata = evt.data.assistantMessage.metadata || null; };
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n'); buffer = lines.pop() || '';
        for (const line of lines) if (line.startsWith('data:')) { const s = line.slice(5).trim(); if (s) { try { handle(JSON.parse(s)); } catch {} } }
    }
    return { metadata, requestId };
}
async function waitPP(base, token, requestId, timeoutMs = 120000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
        const r = await api(base, `/api/ask-requests/${requestId}`, { token });
        const pp = r.data && r.data.postProcessing;
        if (pp && pp.status !== 'pending') return pp;
        await new Promise(r => setTimeout(r, 500));
    }
    return { status: 'timeout' };
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.envFile) require('dotenv').config({ path: path.resolve(args.envFile), override: true });
    const model = process.env.AI_MODEL || null;
    const srv = await startIsolatedServer({ keepKeys: true });
    const user = await registerUser(srv.url, 'p2-semantic');
    const p = await api(srv.url, '/api/providers', { method: 'POST', token: user.token, body: { id: 'custom-baseline', name: 'Baseline', apiEndpoint: process.env.CUSTOM_API_ENDPOINT, defaultModel: model, apiKey: process.env.CUSTOM_API_KEY || process.env.AI_API_KEY } });
    if (p.status !== 200) throw new Error('provider: ' + p.text);
    await api(srv.url, '/api/embedding-settings', { method: 'PUT', token: user.token, body: { provider: 'custom', customBaseUrl: process.env.EMBED_BASE_URL, customModel: process.env.EMBED_MODEL_NAME, customApiKey: process.env.EMBED_API_KEY } });
    const norm = TU.normalizeText(fs.readFileSync(path.join(REPO_ROOT, 'books/__defaults/忏悔录 作者：卢梭.txt'), 'utf-8'));
    const form = new FormData();
    form.append('book', new Blob([norm], { type: 'text/plain' }), '忏悔录.txt');
    const up = await fetch(`${srv.url}/api/books/upload`, { method: 'POST', headers: { Authorization: `Bearer ${user.token}` }, body: form });
    const bookId = (await up.json()).book.id;
    const conv0 = await api(srv.url, '/api/conversations', { method: 'POST', token: user.token, body: { bookId } });
    const turns = ['请记住：我是中文系学生，正在准备毕业论文。', '我还没理解本书的时间跳跃手法，希望以后接着讨论。'];
    for (const q of turns) {
        const r = await ask(srv.url, user.token, { requestId: crypto.randomUUID(), question: q, bookId, provider: 'custom-baseline', model, conversationId: conv0.data.conversation.id });
        await waitPP(srv.url, user.token, r.requestId);
    }
    await new Promise(r => setTimeout(r, 2000)); // 等待 best-effort 向量写入
    const Database = require('better-sqlite3');
    const raw = new Database(path.join(srv.dataRoot, 'data.db'), { readonly: true });
    const vecCount = raw.prepare('SELECT COUNT(*) c FROM memory_vectors').get().c;
    const mems = raw.prepare("SELECT id, key, kind FROM user_memories WHERE user_id = ? AND status = 'active'").all(user.userId);
    raw.close();
    const probes = [
        { question: '我该如何分析《忏悔录》的自传真实性？', expectKey: 'fact.role', expectPresent: true },
        { question: '时间跳跃手法还是没懂，能再讲讲吗', expectKey: 'fact.role', expectPresent: false }
    ];
    const results = [];
    for (const pr of probes) {
        const pc = await api(srv.url, '/api/conversations', { method: 'POST', token: user.token, body: { bookId } });
        const r = await ask(srv.url, user.token, { requestId: crypto.randomUUID(), question: pr.question, bookId, provider: 'custom-baseline', model, conversationId: pc.data.conversation.id });
        await waitPP(srv.url, user.token, r.requestId);
        const refs = (r.metadata && r.metadata.memoryRefs) || [];
        const keys = refs.map(ref => { const m = mems.find(x => x.id === ref.id); return m ? m.key : `deleted:${ref.id}`; });
        const present = keys.some(k => k === pr.expectKey || (pr.expectKey === 'fact.role' && k.startsWith('fact.')));
        results.push({ question: pr.question, expectKey: pr.expectKey, expectPresent: pr.expectPresent, present, pass: present === pr.expectPresent, refKeys: keys });
    }
    const out = { runId: `p2-semantic-${new Date().toISOString().replace(/[:.]/g, '-')}`, model, vecCount, activeMemories: mems, results, pass: results.every(r => r.pass) && vecCount > 0 };
    const outFile = path.join(REPO_ROOT, 'docs', 'baseline-results', out.runId + '.json');
    fs.writeFileSync(outFile, JSON.stringify(out, null, 2));
    console.log(JSON.stringify(out, null, 2));
    await srv.stop();
    if (!out.pass) process.exit(1);
}
main().catch(e => { console.error(e); process.exit(1); });