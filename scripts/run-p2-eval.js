/**
 * P2/P3-记忆 真实模型评测（开发集）。
 * 用法：node scripts/run-p2-eval.js --env-file .env.baseline.local [--limit N] [--suite all|extract|threshold|layers]
 * 产出：docs/baseline-results/p2-<ts>/ scripts.jsonl probes.jsonl summary.json report.md
 * 口径：开发集初测，非保留集（holdout 冻结供 P4）；偏好遵从为结构启发式+原始答案待人工复核；
 *       模型自动评分仅作辅助。抽取 Precision/Recall 按 gold 条目（key/scope/status/value）机器检查。
 * 对照：无记忆=暂停；旧记忆=P0 已记录基线（docs/baseline-results 在线记忆基线）；新治理=本跑。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const REPO_ROOT = path.join(__dirname, '..');
const BASELINE = path.join(REPO_ROOT, 'docs', 'baseline');
const { startIsolatedServer, api, registerUser } = require('../tests/helpers/isolated-server');
const TU = require('../text-utils');
const conv = require('../conversation');

function parseArgs(argv) {
    const a = { envFile: null, limit: null, suite: 'all', dataset: null, prefix: 'p2', only: null };
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--env-file') a.envFile = argv[++i];
        else if (argv[i] === '--limit') a.limit = parseInt(argv[++i], 10);
        else if (argv[i] === '--suite') a.suite = argv[++i];
        else if (argv[i] === '--dataset') a.dataset = argv[++i];
        else if (argv[i] === '--prefix') a.prefix = argv[++i];
        else if (argv[i] === '--only') a.only = argv[++i];
    }
    return a;
}

async function unifiedAsk(base, token, body) {
    const t0 = performance.now();
    let firstAnswerAt = null;
    const res = await fetch(base + '/api/ask-stream', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body)
    });
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('text/event-stream')) {
        const data = await res.json().catch(() => ({}));
        return { status: res.status, answer: null, metadata: null, requestId: body.requestId, firstAnswerMs: null, totalMs: performance.now() - t0, endStatus: null, error: data.error || null };
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '', answer = '', endStatus = null, metadata = null, postProcessing = null;
    const handle = (evt) => {
        const d = evt.data || {};
        if (evt.type === 'chunk') { if (firstAnswerAt === null) firstAnswerAt = performance.now(); answer += d.content || ''; }
        else if (evt.type === 'end') { endStatus = d.status; postProcessing = d.postProcessing || null; if (d.assistantMessage) { metadata = d.assistantMessage.metadata || null; if (d.assistantMessage.content != null && !answer) answer = d.assistantMessage.content; } }
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
    return { status: res.status, answer, metadata, postProcessing, requestId: body.requestId, firstAnswerMs: firstAnswerAt ? firstAnswerAt - t0 : null, totalMs: performance.now() - t0, endStatus };
}

async function waitPostProcessing(base, token, requestId, timeoutMs = 120000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
        const r = await api(base, `/api/ask-requests/${requestId}`, { token });
        const pp = r.data && r.data.postProcessing;
        if (pp && pp.status !== 'pending') return { pp, latencyMs: Date.now() - t0 };
        await new Promise(r => setTimeout(r, 500));
    }
    return { pp: { status: 'timeout' }, latencyMs: Date.now() - t0 };
}

const keyMatch = (pattern, key) => pattern == null ? true : (pattern.endsWith('*') ? key.startsWith(pattern.slice(0, -1)) : pattern === key);
const enumMatch = (pattern, val) => pattern == null ? true : (String(pattern).includes('|') ? String(pattern).split('|').includes(val) : pattern === val);
function goldMatch(g, m, bookIds) {
    if (!keyMatch(g.key, m.key)) return false;
    if (!enumMatch(g.scope, m.scope)) return false;
    if (!enumMatch(g.status, m.status)) return false;
    if (g.value && m.normalized_value !== g.value) return false;
    if (g.book && m.book_id !== bookIds[g.book]) return false;
    return true;
}
function complianceCheck(type, answer) {
    const a = String(answer || '');
    if (!type) return null;
    if (type === 'bullets') return /(^|\n)\s*([-*•]|\d+[.、)）])/.test(a) && (a.match(/(^|\n)\s*([-*•]|\d+[.、)）])/g) || []).length >= 2;
    if (type === 'concise') return a.length <= 250;
    if (type === 'detailed') return a.length >= 400;
    if (type === 'not_french') return !/[àâçéèêëîïôùûüœ]/i.test(a) && !/\b(bonjour|voici|c'est|les|des|une)\b/i.test(a);
    if (type === 'english') return (a.match(/[a-zA-Z]/g) || []).length > a.length * 0.5;
    return null;
}

async function setupUser(srv, ds, username, generic) {
    const user = await registerUser(srv.url, username);
    let providerId = 'zhipu';
    if (generic) {
        const p = await api(srv.url, '/api/providers', { method: 'POST', token: user.token, body: { id: 'custom-baseline', name: 'Baseline', apiEndpoint: generic.endpoint, defaultModel: generic.model || 'default', apiKey: generic.key } });
        if (p.status !== 200) throw new Error('创建提供商失败: ' + p.text);
        providerId = 'custom-baseline';
    }
    const bookIds = {};
    for (const [id, rel] of Object.entries(ds.books)) {
        const norm = TU.normalizeText(fs.readFileSync(path.join(REPO_ROOT, rel), 'utf-8'));
        const form = new FormData();
        form.append('book', new Blob([norm], { type: 'text/plain' }), path.basename(rel));
        const res = await fetch(`${srv.url}/api/books/upload`, { method: 'POST', headers: { Authorization: `Bearer ${user.token}` }, body: form });
        bookIds[id] = (await res.json()).book.id;
    }
    return { user, bookIds, providerId };
}

async function runActions(srv, user, bookIds, actions) {
    for (const a of actions || []) {
        const list = (await api(srv.url, '/api/memories', { token: user.token })).data.memories || [];
        const settings = (await api(srv.url, '/api/memory-settings', { token: user.token })).data;
        if (a.type === 'clearMemories') await api(srv.url, '/api/memories', { method: 'DELETE', token: user.token, body: { expectedEpoch: settings.epoch } });
        else if (a.type === 'pause') await api(srv.url, '/api/memory-settings', { method: 'PUT', token: user.token, body: { enabled: false, expectedEpoch: settings.epoch } });
        else if (a.type === 'resume') await api(srv.url, '/api/memory-settings', { method: 'PUT', token: user.token, body: { enabled: true, expectedEpoch: settings.epoch } });
        else if (a.type === 'confirmFirstCandidate') {
            const c = list.find(m => m.status === 'candidate');
            if (c) await api(srv.url, `/api/memories/${c.id}/confirm`, { method: 'POST', token: user.token, body: { expectedRevision: c.revision, expectedEpoch: settings.epoch } });
        } else if (a.type === 'keepCurrent') {
            const c = list.find(m => m.status === 'candidate');
            if (c) await api(srv.url, `/api/memories/${c.id}`, { method: 'DELETE', token: user.token, body: { expectedRevision: c.revision } });
        } else if (a.type === 'confirmConflict') {
            const c = list.find(m => m.status === 'candidate' && list.some(x => x.status === 'active' && x.key === m.key));
            if (c) await api(srv.url, `/api/memories/${c.id}/confirm`, { method: 'POST', token: user.token, body: { expectedRevision: c.revision, expectedEpoch: settings.epoch } });
        } else if (a.type === 'editFirst') {
            const m = list.find(x => x.status === 'active');
            if (m) await api(srv.url, `/api/memories/${m.id}`, { method: 'PUT', token: user.token, body: { expectedRevision: m.revision, content: a.content } });
        } else if (a.type === 'completeGoal' || a.type === 'completeQuestion') {
            const kind = a.type === 'completeGoal' ? 'reading_goal' : 'open_question';
            const m = list.find(x => x.status === 'active' && x.kind === kind);
            if (m) await api(srv.url, `/api/memories/${m.id}/complete`, { method: 'POST', token: user.token, body: { expectedRevision: m.revision } });
        } else if (a.type === 'deleteFirst') {
            const m = list.find(x => x.status === 'active');
            if (m) await api(srv.url, `/api/memories/${m.id}`, { method: 'DELETE', token: user.token, body: { expectedRevision: m.revision } });
        } else if (a.type === 'deleteBook') {
            await api(srv.url, `/api/books/${bookIds[a.book]}`, { method: 'DELETE', token: user.token });
        }
    }
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.envFile) require('dotenv').config({ path: path.resolve(args.envFile), override: true });
    const ds = JSON.parse(fs.readFileSync(path.resolve(args.dataset || path.join(BASELINE, 'dev-memory-scripts-p2.json')), 'utf-8'));
    const scripts = (args.only ? ds.scripts.filter(s => s.id === args.only) : (args.limit ? ds.scripts.slice(0, args.limit) : ds.scripts));
    const model = process.env.AI_MODEL || null;
    const hasGeneric = !!(process.env.CUSTOM_API_ENDPOINT && (process.env.CUSTOM_API_KEY || process.env.AI_API_KEY));
    const holdout = !!ds.frozen;
    console.log(`P2记忆评测: 模型=${model} 脚本=${scripts.length} suite=${args.suite} 数据集=${ds.version}${holdout ? '(保留集)' : '(开发集)'}（不打印密钥）`);
    if (!hasGeneric && !process.env.ZHIPU_API_KEY) { console.error('缺少凭据'); process.exit(2); }

    const runId = `${args.prefix}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    const outDir = path.join(REPO_ROOT, 'docs', 'baseline-results', runId);
    fs.mkdirSync(outDir, { recursive: true });
    const jsonl = (name, o) => fs.appendFileSync(path.join(outDir, name), JSON.stringify(o) + '\n', 'utf-8');

    const srv = await startIsolatedServer({ keepKeys: true, extraEnv: { MEM_DEBUG: '1', ...(process.env.MEM_SEMANTIC ? { MEM_SEMANTIC: process.env.MEM_SEMANTIC } : {}) } });
    const Database = require('better-sqlite3');
    const rawDb = new Database(path.join(srv.dataRoot, 'data.db'));
    const generic = hasGeneric ? { endpoint: process.env.CUSTOM_API_ENDPOINT, key: process.env.CUSTOM_API_KEY || process.env.AI_API_KEY, model } : null;
    const boot = await setupUser(srv, ds, 'p2-eval-boot', generic);
    const providerId = boot.providerId;

    const S = {
        runId, model, suite: args.suite, scripts: 0, turns: 0, errors: 0,
        savedTotal: 0, savedMatched: 0, goldTotal: 0, goldMatched: 0,
        probeTotal: 0, misinject: 0, misinjectProbes: 0, compliancePass: 0, complianceTotal: 0,
        scheduledTurns: 0, extractDone: 0, extractFailed: 0, extractLatency: [],
        checks: []
    };
    const thresholdPairs = [];

    try {
        if (args.suite === 'all' || args.suite === 'extract') {
            for (const sc of scripts) {
                const logStart = srv.logs.length;
                const { user, bookIds } = await setupUser(srv, ds, `p2-${sc.id}`, generic);
                let book = sc.book;
                const convRes = await api(srv.url, '/api/conversations', { method: 'POST', token: user.token, body: { bookId: bookIds[book] } });
                let convId = convRes.data.conversation.id;
                const turnRecords = [];
                const runTurns = async (turns) => {
                    for (const t of turns || []) {
                        const question = typeof t === 'string' ? t : t.question;
                        const selection = typeof t === 'object' && t.selection ? { text: t.selection, locator: null } : null;
                        const r = await unifiedAsk(srv.url, user.token, { requestId: crypto.randomUUID(), question, selection, bookId: bookIds[book], provider: providerId, model, conversationId: convId });
                        S.turns++;
                        if (r.endStatus !== 'completed') S.errors++;
                        const { pp, latencyMs } = await waitPostProcessing(srv.url, user.token, r.requestId);
                        if (pp.status !== 'skipped') S.scheduledTurns++;
                        if (pp.status === 'completed') { S.extractDone++; S.extractLatency.push(latencyMs); }
                        if (pp.status === 'failed') S.extractFailed++;
                        turnRecords.push({ question, endStatus: r.endStatus, pp: pp.status, ppError: pp.error || null, ppChanges: pp.memoryChanges || [], extractLatencyMs: latencyMs, totalMs: Math.round(r.totalMs) });
                    }
                };
                await runTurns(sc.turns);
                const memsPre = rawDb.prepare('SELECT * FROM user_memories WHERE user_id = ?').all(user.userId);
                await runActions(srv, user, bookIds, sc.actions);
                if (sc.afterClearCount !== undefined) {
                    const n = ((await api(srv.url, '/api/memories', { token: user.token })).data.memories || []).length;
                    S.checks.push({ id: sc.id, check: 'afterClearCount', pass: n === sc.afterClearCount, actual: n });
                }
                if (sc.switchBook) {
                    book = sc.switchBook;
                    const c2 = await api(srv.url, '/api/conversations', { method: 'POST', token: user.token, body: { bookId: bookIds[book] } });
                    convId = c2.data.conversation.id;
                }
                await runTurns(sc.turns2);
                await runActions(srv, user, bookIds, sc.actions2);

                const memsView = ((await api(srv.url, '/api/memories', { token: user.token })).data.memories || []);
                const mems = rawDb.prepare('SELECT * FROM user_memories WHERE user_id = ?').all(user.userId);
                const saved = mems.filter(m => m.status === 'active' || m.status === 'candidate');
                const gold = (sc.gold || []).map(g => ({ ...g, key: (sc.goldKeyPattern || {})[g.key] || g.key }));
                const goldAfter = (sc.goldAfter || []).map(g => ({ ...g, key: (sc.goldKeyPattern || {})[g.key] || g.key }));
                const goldAny = (sc.goldAny || []).map(g => ({ ...g, key: (sc.goldKeyPattern || {})[g.key] || g.key }));
                // goldAfter 语义：gold=动作前期望（全状态），goldAfter=动作后期望（含 completed/expired，对全状态匹配）；goldAny=宽松期望（scope/status 可枚举）
                const evalGold = goldAfter.length ? goldAfter : (gold.length ? gold : goldAny);
                if (goldAfter.length) {
                    const preOk = gold.every(g => memsPre.some(m => goldMatch(g, m, bookIds)));
                    S.checks.push({ id: sc.id, check: 'preActionGold', pass: preOk });
                }
                const recallPool = goldAfter.length ? mems : saved;
                let matchedSaved = 0;
                for (const m of saved) if (evalGold.some(g => goldMatch(g, m, bookIds))) matchedSaved++;
                let matchedGold = 0;
                for (const g of evalGold) if (recallPool.some(m => goldMatch(g, m, bookIds))) matchedGold++;
                S.savedTotal += saved.length; S.savedMatched += matchedSaved;
                S.goldTotal += evalGold.length; S.goldMatched += matchedGold;
                const extractionCalls = (srv.logs.slice(logStart).join('').match(/\[mem-extract\] raw:/g) || []).length;
                if (sc.maxExtractionCalls !== undefined) S.checks.push({ id: sc.id, check: `maxExtractionCalls<=${sc.maxExtractionCalls}`, pass: extractionCalls <= sc.maxExtractionCalls, actual: extractionCalls });
                if (sc.maxEntriesForKey) for (const [k, max] of Object.entries(sc.maxEntriesForKey)) {
                    const n = saved.filter(m => keyMatch(k, m.key)).length;
                    S.checks.push({ id: sc.id, check: `maxEntries:${k}`, pass: n <= max, actual: n });
                }
                if (sc.forbidActive) for (const f of sc.forbidActive) {
                    const bad = mems.some(m => m.status === 'active' && keyMatch(f.key, m.key) && (!f.value || m.normalized_value === f.value));
                    S.checks.push({ id: sc.id, check: `forbidActive:${f.key}=${f.value || '*'}`, pass: !bad });
                }
                // 探针（新会话）
                const probeRecords = [];
                for (const p of sc.probes || []) {
                    const pBook = p.book || book;
                    const pc = await api(srv.url, '/api/conversations', { method: 'POST', token: user.token, body: { bookId: bookIds[pBook] } });
                    const r = await unifiedAsk(srv.url, user.token, { requestId: crypto.randomUUID(), question: p.question, bookId: bookIds[pBook], provider: providerId, model, conversationId: pc.data.conversation.id });
                    await waitPostProcessing(srv.url, user.token, r.requestId);
                    const refs = (r.metadata && r.metadata.memoryRefs) || [];
                    const refKeys = refs.map(ref => { const m = memsView.find(x => x.id === ref.id); return m ? { key: m.key, scope: m.scope, bookId: m.bookId, reason: ref.reason } : { key: `deleted:${ref.id}`, scope: ref.scope, bookId: ref.bookId, reason: ref.reason }; });
                    const expectOk = (p.expectRefs || []).every(k => refKeys.some(rk => keyMatch(k, rk.key)));
                    const forbidBad = (p.forbidRefs || []).filter(k => refKeys.some(rk => keyMatch(k, rk.key)));
                    let bookOk = true;
                    if (p.expectRefsBook) bookOk = bookOk && refKeys.some(rk => rk.scope === 'book' && rk.bookId === bookIds[p.expectRefsBook]);
                    if (p.forbidRefsBook) bookOk = bookOk && !refKeys.some(rk => rk.scope === 'book' && rk.bookId === bookIds[p.forbidRefsBook]);
                    const comp = complianceCheck(p.compliance && p.compliance.type, r.answer);
                    S.probeTotal++;
                    if (p.forbidRefs && p.forbidRefs.length) { S.misinjectProbes++; if (forbidBad.length) S.misinject++; }
                    if (comp !== null) { S.complianceTotal++; if (comp) S.compliancePass++; }
                    // 阈值实验素材：相关/无关 (问题, 记忆正文) 对——无关对取同用户其余非偏好 active 记忆（不论是否注入）
                    for (const m of mems) {
                        if (m.status !== 'active' || m.kind === 'preference') continue;
                        if (m.scope === 'book' && m.book_id !== bookIds[pBook]) continue;
                        const relevant = (p.expectRefs || []).some(k => keyMatch(k, m.key));
                        thresholdPairs.push({ question: p.question, content: m.content, relevant, script: sc.id });
                    }
                    probeRecords.push({ question: p.question, expectOk, forbidBad, bookOk, compliance: comp, answerKind: r.metadata && r.metadata.answerKind, refKeys, answer: r.answer });
                    jsonl('probes.jsonl', { script: sc.id, ...probeRecords[probeRecords.length - 1] });
                }
                S.scripts++;
                const rec = { id: sc.id, scenario: sc.scenario, turns: turnRecords, saved: saved.map(m => ({ id: m.id, kind: m.kind, key: m.key, scope: m.scope, bookId: m.book_id, status: m.status, value: m.normalized_value, content: m.content, sourceType: m.source_type, sourceMessageId: m.source_message_id })), savedCount: saved.length, matchedSaved, goldCount: evalGold.length, matchedGold, extractionCalls, precision: saved.length ? matchedSaved / saved.length : 1, recall: evalGold.length ? matchedGold / evalGold.length : 1, probes: probeRecords };
                jsonl('scripts.jsonl', rec);
                console.log(`[${sc.id} ${sc.scenario}] saved=${saved.length} P=${rec.precision.toFixed(2)} R=${rec.recall.toFixed(2)} probes=${probeRecords.length}`);
            }
        }

        // ---- M5 词法阈值选择（开发集，离线） ----
        let thresholdResult = null;
        if ((args.suite === 'all' || args.suite === 'threshold') && thresholdPairs.length) {
            thresholdResult = [];
            for (const th of [0.15, 0.25, 0.35]) {
                let relHit = 0, relTotal = 0, irrHit = 0, irrTotal = 0;
                for (const p of thresholdPairs) {
                    const score = conv.jaccard(conv.tokenSet(p.question), conv.tokenSet(p.content));
                    const inj = score >= th;
                    if (p.relevant) { relTotal++; if (inj) relHit++; }
                    else { irrTotal++; if (inj) irrHit++; }
                }
                thresholdResult.push({ threshold: th, relevantRecall: relTotal ? relHit / relTotal : null, irrelevantInject: irrTotal ? irrHit / irrTotal : null, relTotal, irrTotal });
            }
            console.log('阈值实验:', JSON.stringify(thresholdResult));
        }

        // ---- M5 注入分层对照（偏好 / +目标 / +问题 / 无记忆） ----
        let layers = null;
        if (args.suite === 'all' || args.suite === 'layers') {
            const seed = await setupUser(srv, ds, 'p2-layer-seed', generic);
            // 分层对照只比注入集合：种子记忆确定性直插（不经抽取，避免模型变异干扰对照）
            const seedDefs = [
                { kind: 'preference', scope: 'user', book: null, key: 'preference.answer_format', content: '用户偏好分点回答', nv: 'bullets' },
                { kind: 'preference', scope: 'user', book: null, key: 'preference.answer_length', content: '用户偏好简洁回答', nv: 'concise' },
                { kind: 'fact', scope: 'user', book: null, key: 'fact.role', content: '用户是中文系学生，正在准备毕业论文', nv: '中文系学生' },
                { kind: 'reading_goal', scope: 'book', book: 'confessions', key: 'reading_goal.primary', content: '用户读本书为了搞清楚卢梭的自我辩护逻辑', nv: '自我辩护逻辑' },
                { kind: 'open_question', scope: 'book', book: 'confessions', key: 'open_question:time-jump', content: '用户尚未理解本书时间跳跃手法，希望继续讨论', nv: '时间跳跃' }
            ];
            const insSeed = rawDb.prepare(`INSERT INTO user_memories (user_id, kind, scope, book_id, key, content, normalized_value, status, revision, source_type, created_at, updated_at, last_seen_at, expires_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, 'active', 1, 'user_confirmation', datetime('now'), datetime('now'), datetime('now'), ?)`);
            for (const s of seedDefs) insSeed.run(seed.user.userId, s.kind, s.scope, s.book ? seed.bookIds[s.book] : null, s.key, s.content, s.nv, s.kind === 'open_question' ? new Date(Date.now() + 90 * 86400000).toISOString() : null);
            const raw = rawDb;
            const seedRows = raw.prepare("SELECT * FROM user_memories WHERE user_id = ? AND status = 'active'").all(seed.user.userId);
            const seedKeyFor = (bookId) => Object.keys(seed.bookIds).find(k => seed.bookIds[k] === bookId);
            const probeQuestions = ['我该如何分析《忏悔录》的自传真实性？', '时间跳跃手法还是没懂，能再讲讲吗', '请解释什么是叙事视角'];
            layers = [];
            const layerDefs = [
                { name: 'prefs-only', filter: m => m.scope === 'user' && m.kind === 'preference' },
                { name: 'prefs+goals', filter: m => (m.scope === 'user' && m.kind === 'preference') || m.kind === 'reading_goal' },
                { name: 'prefs+goals+questions', filter: m => true },
                { name: 'no-memory', filter: m => true, disabled: true }
            ];
            for (const ld of layerDefs) {
                const lu = await registerUser(srv.url, `p2-layer-${ld.name}`);
                if (generic) {
                    await api(srv.url, '/api/providers', { method: 'POST', token: lu.token, body: { id: 'custom-baseline', name: 'Baseline', apiEndpoint: generic.endpoint, defaultModel: generic.model || 'default', apiKey: generic.key } });
                }
                // 该用户需有同书（confessions），先上传再复制种子记忆
                const norm = TU.normalizeText(fs.readFileSync(path.join(REPO_ROOT, ds.books.confessions), 'utf-8'));
                const form = new FormData();
                form.append('book', new Blob([norm], { type: 'text/plain' }), '忏悔录.txt');
                const up = await fetch(`${srv.url}/api/books/upload`, { method: 'POST', headers: { Authorization: `Bearer ${lu.token}` }, body: form });
                const luBook = (await up.json()).book.id;
                const ins = raw.prepare(`INSERT INTO user_memories (user_id, kind, scope, book_id, key, content, normalized_value, status, revision, source_type, source_conv, source_message_id, source_start, source_end, order_message_id, salience, created_at, updated_at, last_seen_at, expires_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, 'active', 1, 'user_confirmation', ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'), datetime('now'), ?)`);
                let injected = 0;
                for (const m of seedRows.filter(ld.filter)) {
                    const mappedBook = m.scope === 'book' ? (seedKeyFor(m.book_id) === 'confessions' ? luBook : null) : null;
                    if (m.scope === 'book' && !mappedBook) continue;
                    ins.run(lu.userId, m.kind, m.scope, mappedBook, m.key, m.content, m.normalized_value, m.source_conv, m.source_message_id, m.source_start, m.source_end, m.order_message_id, m.salience, m.expires_at);
                    injected++;
                }
                if (ld.disabled) {
                    const st = (await api(srv.url, '/api/memory-settings', { token: lu.token })).data;
                    await api(srv.url, '/api/memory-settings', { method: 'PUT', token: lu.token, body: { enabled: false, expectedEpoch: st.epoch } });
                }
                const answers = [];
                for (const q of probeQuestions) {
                    const pc = await api(srv.url, '/api/conversations', { method: 'POST', token: lu.token, body: { bookId: luBook } });
                    const r = await unifiedAsk(srv.url, lu.token, { requestId: crypto.randomUUID(), question: q, bookId: luBook, provider: providerId, model, conversationId: pc.data.conversation.id });
                    await waitPostProcessing(srv.url, lu.token, r.requestId);
                    answers.push({ question: q, answer: r.answer, refs: (r.metadata && r.metadata.memoryRefs || []).length, answerKind: r.metadata && r.metadata.answerKind, totalMs: Math.round(r.totalMs) });
                }
                layers.push({ layer: ld.name, injected, answers });
                console.log(`[分层 ${ld.name}] 注入=${injected} 探针=${answers.length}`);
            }
        }

        const p50 = arr => { if (!arr.length) return null; const s = [...arr].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
        const summary = {
            ...S,
            extractLatency: undefined,
            precision: S.savedTotal ? S.savedMatched / S.savedTotal : null,
            recall: S.goldTotal ? S.goldMatched / S.goldTotal : null,
            misinjectRate: S.misinjectProbes ? S.misinject / S.misinjectProbes : null,
            complianceRate: S.complianceTotal ? S.compliancePass / S.complianceTotal : null,
            extractLatencyP50: p50(S.extractLatency),
            scheduledRatio: S.turns ? S.scheduledTurns / S.turns : null,
            thresholdExperiment: thresholdResult,
            layers,
            checksPass: S.checks.filter(c => c.pass).length, checksTotal: S.checks.length,
            finishedAt: new Date().toISOString()
        };
        fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
        const lines = [`# P2/P3-记忆 ${holdout ? '保留集' : '开发集'}评测 ${runId}`, '', `模型：${model}；脚本 ${S.scripts}；轮次 ${S.turns}；错误 ${S.errors}`, '',
            `- 抽取 Precision=${fmt(summary.precision)}（${S.savedMatched}/${S.savedTotal}），Recall=${fmt(summary.recall)}（${S.goldMatched}/${S.goldTotal}）`,
            `- 无关误注入率=${fmt(summary.misinjectRate)}（${S.misinject}/${S.misinjectProbes}）`,
            `- 偏好遵从（结构启发式，待人工复核）=${fmt(summary.complianceRate)}（${S.compliancePass}/${S.complianceTotal}）`,
            `- 触发调度比例=${fmt(summary.scheduledRatio)}（旧基线每轮1次抽取）；抽取完成 P50=${summary.extractLatencyP50}ms；失败 ${S.extractFailed}`,
            `- 确定性检查 ${summary.checksPass}/${summary.checksTotal}`, '',
            '## 阈值实验（开发集）', ...(thresholdResult || []).map(t => `- th=${t.threshold}: 相关召回=${fmt(t.relevantRecall)} 无关注入=${fmt(t.irrelevantInject)} (rel=${t.relTotal}, irr=${t.irrTotal})`), '',
            '## 注入分层对照', ...(layers || []).map(l => `- ${l.layer}: 注入${l.injected}条；探针答案见 summary.json`), '',
            '口径：' + (holdout ? '正式保留集（冻结）；' : '开发集初测；保留集冻结于 holdout-memory-scripts-p2.json（P4）；') + '旧记忆对照引用 P0 在线基线记录。'];
        fs.writeFileSync(path.join(outDir, 'report.md'), lines.join('\n'));
        console.log('SUMMARY:', JSON.stringify({ precision: summary.precision, recall: summary.recall, misinjectRate: summary.misinjectRate, complianceRate: summary.complianceRate, checks: `${summary.checksPass}/${summary.checksTotal}` }));
        console.log('OUT:', outDir);
    } finally {
        try { fs.writeFileSync(path.join(outDir, 'server.log'), srv.logText()); } catch {}
        try { rawDb.close(); } catch {}
        await srv.stop();
    }
}
function fmt(v) { return v == null ? 'n/a' : (v * 100).toFixed(1) + '%'; }
main().catch(e => { console.error(e); process.exit(1); });