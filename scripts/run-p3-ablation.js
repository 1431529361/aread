/**
 * P3-RAG 增量消融：每次只改变一个因素，开发集上测质量与延迟，决定去留。
 * 条件：hybrid默认(500) / 分块800 / 分块1200 / +邻接扩展 / +重排 / 多轮改写(coref) / 缓存冷热。
 * 用法：node scripts/run-p3-ablation.js --env-file .env.baseline.local [--limit N]
 * 产出：docs/baseline-results/p3-<ts>/ ablation.jsonl + summary.json + report.md
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const REPO_ROOT = path.join(__dirname, '..');
const BASELINE = path.join(REPO_ROOT, 'docs', 'baseline');
const { startIsolatedServer, api, registerUser } = require('../tests/helpers/isolated-server');
const TU = require('../text-utils');

function parseArgs(argv) {
    const a = { envFile: null, limit: null };
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--env-file') a.envFile = argv[++i];
        else if (argv[i] === '--limit') a.limit = parseInt(argv[++i], 10);
    }
    return a;
}
const normalize = s => String(s).replace(/\s+/g, '');
function metrics(hits, gold) {
    const nh = hits.map(h => normalize(h.text));
    const matched = gold.map(q => nh.some(t => t.includes(normalize(q))));
    const hit = gold.length ? matched.some(Boolean) : null;
    const recall = gold.length ? matched.filter(Boolean).length / gold.length : null;
    let mrr = 0;
    if (gold.length) for (let i = 0; i < nh.length; i++) if (gold.some(q => nh[i].includes(normalize(q)))) { mrr = 1 / (i + 1); break; }
    return { hit, recall, mrr };
}
const pct = (arr, p) => { if (!arr.length) return null; const s = [...arr].sort((a, b) => a - b); return Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))]); };

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.envFile) require('dotenv').config({ path: path.resolve(args.envFile), override: true });
    const ds = JSON.parse(fs.readFileSync(path.join(BASELINE, 'dev-rag-questions.json'), 'utf-8'));
    const questions = args.limit ? ds.questions.slice(0, args.limit) : ds.questions;
    const embed = { baseUrl: process.env.EMBED_BASE_URL, model: process.env.EMBED_MODEL_NAME, key: process.env.EMBED_API_KEY };
    const rerank = { baseUrl: process.env.RERANK_BASE_URL, model: process.env.RERANK_MODEL, key: process.env.RERANK_API_KEY };
    const chat = { endpoint: process.env.CUSTOM_API_ENDPOINT, key: process.env.CUSTOM_API_KEY || process.env.AI_API_KEY, model: process.env.AI_MODEL };
    console.log(`P3消融: 题数=${questions.length} embed=${embed.model}（不打印密钥）`);
    if (!embed.baseUrl || !embed.key) { console.error('缺少 Embedding 配置'); process.exit(2); }

    const runId = `p3-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    const outDir = path.join(REPO_ROOT, 'docs', 'baseline-results', runId);
    fs.mkdirSync(outDir, { recursive: true });
    const jsonl = (o) => fs.appendFileSync(path.join(outDir, 'ablation.jsonl'), JSON.stringify(o) + '\n', 'utf-8');

    const srv = await startIsolatedServer({ keepKeys: true });
    const user = await registerUser(srv.url, 'p3-ablation');
    await api(srv.url, '/api/embedding-settings', { method: 'PUT', token: user.token, body: { provider: 'custom', customBaseUrl: embed.baseUrl, customModel: embed.model, customApiKey: embed.key } });
    let rerankReady = false;
    if (rerank.baseUrl && rerank.model && rerank.key) {
        const rr = await api(srv.url, '/api/rerank-settings', { method: 'PUT', token: user.token, body: { enabled: true, baseUrl: rerank.baseUrl, model: rerank.model, topN: 10, rerankApiKey: rerank.key } });
        rerankReady = rr.status === 200 && !!rr.data.active;
    }
    const bookIds = {}, contents = {}, normHashes = {};
    for (const [id, rel] of Object.entries(ds.books)) {
        const norm = TU.normalizeText(fs.readFileSync(path.join(REPO_ROOT, rel), 'utf-8'));
        contents[id] = norm; normHashes[id] = TU.contentHash(norm);
        const form = new FormData();
        form.append('book', new Blob([norm], { type: 'text/plain' }), path.basename(rel));
        const res = await fetch(`${srv.url}/api/books/upload`, { method: 'POST', headers: { Authorization: `Bearer ${user.token}` }, body: form });
        bookIds[id] = (await res.json()).book.id;
    }

    process.env.READER_DATA_ROOT = srv.dataRoot;
    const database = require('../database');
    const rag = require('../rag');
    const embedding = require('../embedding');
    const rerankMod = require('../rerank');
    const llmClient = require('../llm-client');
    await database.initDB();
    const keyFor = (uid, pid) => (pid === 'custom-embed' || pid === 'aliyun-embed') ? embed.key : (pid === 'rerank' ? rerank.key : null);
    embedding.init({ getApiKey: keyFor });
    rerankMod.init({ getApiKey: keyFor });

    async function buildAll(chunker) {
        const out = {};
        for (const [id, bookId] of Object.entries(bookIds)) {
            const res = await api(srv.url, `/api/books/${bookId}/index`, { method: 'POST', token: user.token, body: chunker ? { chunker } : {} });
            out[id] = { mode: res.data.active && res.data.active.mode, chunks: res.data.active && res.data.active.chunkCount };
        }
        return out;
    }
    async function runCondition(name, { chunker = null, expand = false, rerankOn = false, queryFor = null }) {
        const idx = await buildAll(chunker);
        const agg = { answerable: 0, hit: 0, recall: 0, mrr: 0, lat: [] };
        for (const q of questions) {
            const query = queryFor ? await queryFor(q) : q.question;
            const t0 = performance.now();
            let res = { candidates: [], diagnostics: {} }, err = null;
            try {
                res = await rag.retrieveDetailed(user.userId, bookIds[q.book], query, 5, {
                    expectedContentHash: normHashes[q.book], rerank: rerankOn,
                    expandAdjacent: expand, content: expand ? contents[q.book] : undefined
                });
            } catch (e) { err = e.message; }
            const el = performance.now() - t0;
            const m = metrics(res.candidates, q.goldQuotes || []);
            if (q.goldQuotes && q.goldQuotes.length) { agg.answerable++; if (m.hit) agg.hit++; agg.recall += m.recall || 0; agg.mrr += m.mrr || 0; }
            agg.lat.push(el);
            jsonl({ condition: name, id: q.id, book: q.book, query, latencyMs: Math.round(el), error: err, hit: m.hit, recall: m.recall, mrr: m.mrr, status: res.status, expansion: res.diagnostics.expansion || null, rerank: res.diagnostics.rerank || null });
        }
        return { name, answerable: agg.answerable, hitAt5: agg.answerable ? agg.hit / agg.answerable : null, recallAt5: agg.answerable ? agg.recall / agg.answerable : null, mrrAt5: agg.answerable ? agg.mrr / agg.answerable : null, p50: pct(agg.lat, 0.5), p95: pct(agg.lat, 0.95), index: idx };
    }

    const summary = { runId, embedModel: embed.model, conditions: {} };
    const push = (c) => { summary.conditions[c.name] = c; console.log(`[${c.name}] Hit=${(c.hitAt5 || 0).toFixed(3)} Recall=${(c.recallAt5 || 0).toFixed(3)} MRR=${(c.mrrAt5 || 0).toFixed(3)} P50=${c.p50}ms`); };

    try {
        const C500 = { targetSize: 500, longThreshold: 750, overlap: 100 };
        const C1200 = { targetSize: 1200, longThreshold: 1800, overlap: 240 };
        push(await runCondition('hybrid-500', { chunker: C500 }));
        push(await runCondition('hybrid-800', { chunker: { targetSize: 800, longThreshold: 1200, overlap: 160 } }));
        push(await runCondition('hybrid-1200', { chunker: C1200 }));
        push(await runCondition('hybrid-1200+expand', { chunker: C1200, expand: true }));
        push(await runCondition('hybrid-500+expand', { chunker: C500, expand: true }));
        if (rerankReady) push(await runCondition('hybrid-500+rerank', { chunker: C500, rerankOn: true }));

        // 多轮改写消融：仅 coref 多轮题，比较 原问题 vs 改写后问题 的检索
        const coref = questions.filter(q => q.turns && q.turns.length > 1);
        if (coref.length && chat.endpoint && chat.key) {
            const ep = /\/chat\/completions$/i.test(chat.endpoint) ? chat.endpoint : chat.endpoint.replace(/\/+$/, '') + '/chat/completions';
            const ctx = { apiKey: chat.key, providerConfig: { apiEndpoint: ep }, model: chat.model };
            const rewrite = async (q) => {
                const prior = q.turns.slice(0, -1).map(t => `用户：${t}`).join('\n');
                const cur = q.turns[q.turns.length - 1];
                try {
                    const out = await llmClient.complete(ctx, `把含指代的当前问题改写为可独立检索的完整问题（保留原意，≤60字，只输出问题）。\n最近对话：\n${prior}\n当前问题：${cur}`, { maxTokens: 400, temperature: 0.1, timeoutMs: 20000 });
                    return String(out || '').trim().split('\n')[0].substring(0, 80) || cur;
                } catch { return cur; }
            };
            // 默认分块下：原问题（最后一轮） vs 改写
            await buildAll(null);
            const aggOrig = { a: 0, h: 0, r: 0, m: 0 }, aggRw = { a: 0, h: 0, r: 0, m: 0 };
            for (const q of coref) {
                const cur = q.turns[q.turns.length - 1];
                const rw = await rewrite(q);
                for (const [query, agg] of [[cur, aggOrig], [rw, aggRw]]) {
                    const res = await rag.retrieveDetailed(user.userId, bookIds[q.book], query, 5, { expectedContentHash: normHashes[q.book] });
                    const m = metrics(res.candidates, q.goldQuotes || []);
                    if (q.goldQuotes && q.goldQuotes.length) { agg.a++; if (m.hit) agg.h++; agg.r += m.recall || 0; agg.m += m.mrr || 0; }
                    jsonl({ condition: 'coref-rewrite', id: q.id, variant: query === cur ? 'original' : 'rewritten', query, hit: m.hit, recall: m.recall, mrr: m.mrr });
                }
            }
            summary.corefRewrite = {
                n: coref.length,
                original: { hitAt5: aggOrig.a ? aggOrig.h / aggOrig.a : null, recallAt5: aggOrig.a ? aggOrig.r / aggOrig.a : null, mrrAt5: aggOrig.a ? aggOrig.m / aggOrig.a : null },
                rewritten: { hitAt5: aggRw.a ? aggRw.h / aggRw.a : null, recallAt5: aggRw.a ? aggRw.r / aggRw.a : null, mrrAt5: aggRw.a ? aggRw.m / aggRw.a : null }
            };
            console.log('[coref-rewrite]', JSON.stringify(summary.corefRewrite));
        }

        // 缓存冷热：5 本书 BM25 首查(冷) vs 复查(热)
        const cacheBooks = [];
        for (let i = 0; i < 5; i++) {
            const content = `第${i + 1}章 缓存测试\n` + `缓存书${i}的独特内容段落。`.repeat(40);
            const form = new FormData();
            form.append('book', new Blob([content], { type: 'text/plain' }), `cache${i}.txt`);
            const up = await fetch(`${srv.url}/api/books/upload`, { method: 'POST', headers: { Authorization: `Bearer ${user.token}` }, body: form });
            const b = (await up.json()).book;
            await api(srv.url, `/api/books/${b.id}/index`, { method: 'POST', token: user.token, body: {} });
            cacheBooks.push(b.id);
        }
        const cold = [], hot = [];
        for (const b of cacheBooks) {
            let t = performance.now(); await rag.retrieveDetailed(user.userId, b, '独特内容', 5, {}); cold.push(performance.now() - t);
            t = performance.now(); await rag.retrieveDetailed(user.userId, b, '独特内容', 5, {}); hot.push(performance.now() - t);
        }
        summary.cache = { books: 5, coldP50: pct(cold, 0.5), hotP50: pct(hot, 0.5), coldMs: cold.map(Math.round), hotMs: hot.map(Math.round) };
        console.log('[cache]', JSON.stringify(summary.cache));
    } catch (e) { summary.fatalError = e.message; console.error('中断:', e); }
    finally {
        try { database.getDB().close(); } catch {}
        summary.finishedAt = new Date().toISOString();
        fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2), 'utf-8');
        const f = x => x == null ? '未测' : x.toFixed(3);
        const lines = ['# P3-RAG 增量消融报告（开发集）', '', `- 运行: ${summary.runId}  向量: ${summary.embedModel}`, '',
            '| 条件 | 可答 | Hit@5 | Recall@5 | MRR@5 | P50(ms) | P95(ms) |', '| --- | --- | --- | --- | --- | --- | --- |'];
        for (const c of Object.values(summary.conditions)) lines.push(`| ${c.name} | ${c.answerable} | ${f(c.hitAt5)} | ${f(c.recallAt5)} | ${f(c.mrrAt5)} | ${c.p50} | ${c.p95} |`);
        if (summary.corefRewrite) {
            lines.push('', '## 多轮改写（coref 子集）', '| 变体 | Hit@5 | Recall@5 | MRR@5 |', '| --- | --- | --- | --- |',
                `| 原问题 | ${f(summary.corefRewrite.original.hitAt5)} | ${f(summary.corefRewrite.original.recallAt5)} | ${f(summary.corefRewrite.original.mrrAt5)} |`,
                `| 改写后 | ${f(summary.corefRewrite.rewritten.hitAt5)} | ${f(summary.corefRewrite.rewritten.recallAt5)} | ${f(summary.corefRewrite.rewritten.mrrAt5)} |`);
        }
        if (summary.cache) lines.push('', `## 缓存（5本）冷P50=${summary.cache.coldP50}ms 热P50=${summary.cache.hotP50}ms`);
        lines.push('', '## 口径', '- 每次只改变一个因素；固定 query/Top5/模型/向量；金标准为本地原文子串。',
            '- 邻接扩展上限1500码元/证据；重排失败保留原序。改写仅 coref 多轮题。',
            '- 开发集选择阈值，保留集不调参；本报告为开发集初测。');
        fs.writeFileSync(path.join(outDir, 'report.md'), lines.join('\n'), 'utf-8');
        await srv.stop();
    }
    console.log(`\n结果: ${outDir}`);
    if (summary.fatalError) process.exit(1);
}
main().catch(e => { console.error(e); process.exit(1); });