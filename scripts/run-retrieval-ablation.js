/**
 * 在线检索消融对照：BM25 vs 混合(自定义向量) vs 混合+重排。
 * 固定 query=question，Top5，金标准为本地原文精确子串。
 * 用法：node scripts/run-retrieval-ablation.js --env-file .env.baseline.local [--limit N]
 * 需要 EMBED_BASE_URL/EMBED_MODEL_NAME/EMBED_API_KEY 与 RERANK_BASE_URL/RERANK_MODEL/RERANK_API_KEY。
 * 产出：docs/baseline-results/ablation-<ts>/ retrieval.jsonl + summary.json + report.md
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const REPO_ROOT = path.join(__dirname, '..');
const BASELINE = path.join(REPO_ROOT, 'docs', 'baseline');
const { startIsolatedServer, api, registerUser } = require('../tests/helpers/isolated-server');
const TU = require('../text-utils');

function parseArgs(argv) {
    const a = { envFile: null, limit: null, dryRun: false };
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--env-file') a.envFile = argv[++i];
        else if (argv[i] === '--limit') a.limit = parseInt(argv[++i], 10);
        else if (argv[i] === '--dry-run') a.dryRun = true;
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

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.envFile) require('dotenv').config({ path: path.resolve(args.envFile), override: true });
    const ds = JSON.parse(fs.readFileSync(path.join(BASELINE, 'dev-rag-questions.json'), 'utf-8'));
    const questions = args.limit ? ds.questions.slice(0, args.limit) : ds.questions;

    const embed = { baseUrl: process.env.EMBED_BASE_URL, model: process.env.EMBED_MODEL_NAME, key: process.env.EMBED_API_KEY };
    const rerank = { baseUrl: process.env.RERANK_BASE_URL, model: process.env.RERANK_MODEL, key: process.env.RERANK_API_KEY };
    console.log('================ 检索消融计划 ================');
    console.log(`向量: ${embed.model || '(未配置)'} @ ${embed.baseUrl || ''}`);
    console.log(`重排: ${rerank.model || '(未配置)'} @ ${rerank.baseUrl || ''}`);
    console.log(`题数: ${questions.length}（不打印密钥）`);
    console.log('==============================================');
    if (args.dryRun) return;
    if (!embed.baseUrl || !embed.model || !embed.key) { console.error('缺少 Embedding 配置'); process.exit(2); }

    const runId = `ablation-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    const outDir = path.join(REPO_ROOT, 'docs', 'baseline-results', runId);
    fs.mkdirSync(outDir, { recursive: true });
    const jsonl = (name, o) => fs.appendFileSync(path.join(outDir, name), JSON.stringify(o) + '\n', 'utf-8');

    const srv = await startIsolatedServer({ keepKeys: true });
    const user = await registerUser(srv.url, 'p0-ablation');

    // 上传两本书
    const bookIds = {}, bookHashes = {}, normHashes = {};
    for (const [id, rel] of Object.entries(ds.books)) {
        const abs = path.join(REPO_ROOT, rel);
        const buf = fs.readFileSync(abs);
        bookHashes[id] = crypto.createHash('sha256').update(buf).digest('hex');
        const norm = TU.normalizeText(buf.toString('utf-8'));
        normHashes[id] = TU.contentHash(norm);
        const form = new FormData();
        form.append('book', new Blob([norm], { type: 'text/plain' }), path.basename(rel));
        const res = await fetch(`${srv.url}/api/books/upload`, { method: 'POST', headers: { Authorization: `Bearer ${user.token}` }, body: form });
        bookIds[id] = (await res.json()).book.id;
    }

    // 配置自定义向量 + 重排（经产品 API）
    const er = await api(srv.url, '/api/embedding-settings', { method: 'PUT', token: user.token, body: { provider: 'custom', customBaseUrl: embed.baseUrl, customModel: embed.model, customApiKey: embed.key } });
    if (er.status !== 200) throw new Error('配置自定义向量失败: ' + er.text);
    let rerankReady = false;
    if (rerank.baseUrl && rerank.model && rerank.key) {
        const rr = await api(srv.url, '/api/rerank-settings', { method: 'PUT', token: user.token, body: { enabled: true, baseUrl: rerank.baseUrl, model: rerank.model, topN: 10, rerankApiKey: rerank.key } });
        rerankReady = rr.status === 200 && !!rr.data.active;
        if (!rerankReady) console.warn('重排配置未生效，将跳过混合+重排条件: ' + rr.text);
    }

    let lastEmbedOn = null;
    async function indexAll(embedOn) {
        if (embedOn === lastEmbedOn) return summary._lastIdx || {};
        await api(srv.url, '/api/embedding-settings', { method: 'PUT', token: user.token, body: { provider: embedOn ? 'custom' : 'off' } });
        const out = {};
        for (const [id, bookId] of Object.entries(bookIds)) {
            const res = await api(srv.url, `/api/books/${bookId}/index`, { method: 'POST', token: user.token, body: {} });
            out[id] = { mode: res.data.active && res.data.active.mode, chunkCount: res.data.active && res.data.active.chunkCount, success: res.data.success };
            console.log(`  索引 ${id}: ${out[id].mode} (${out[id].chunkCount}块)${res.data.embedError ? ' embedError=' + res.data.embedError : ''}`);
        }
        lastEmbedOn = embedOn;
        summary._lastIdx = out;
        return out;
    }

    // runner 进程直接检索（固定 query），需 init embedding/rerank 的 Key 解析
    process.env.READER_DATA_ROOT = srv.dataRoot;
    const database = require('../database');
    const rag = require('../rag');
    const embedding = require('../embedding');
    const rerankMod = require('../rerank');
    await database.initDB();
    const keyFor = (uid, pid) => {
        if (pid === 'custom-embed') return embed.key;
        if (pid === 'rerank') return rerank.key;
        if (pid === 'aliyun-embed') return embed.key;
        return null;
    };
    embedding.init({ getApiKey: keyFor });
    rerankMod.init({ getApiKey: keyFor });

    const conditions = [
        { name: 'bm25', embedOn: false, rerank: false },
        { name: 'hybrid', embedOn: true, rerank: false },
        ...(rerankReady ? [{ name: 'hybrid+rerank', embedOn: true, rerank: true }] : [])
    ];
    const summary = { runId, embedModel: embed.model, rerankModel: rerank.model, bookHashes, conditions: {} };

    try {
        for (const cond of conditions) {
            const idx = await indexAll(cond.embedOn);
            const agg = { answerable: 0, hit: 0, recall: 0, mrr: 0, latencies: [] };
            for (const q of questions) {
                const t0 = performance.now();
                let res = { candidates: [], diagnostics: {} }, err = null;
                try { res = await rag.retrieveDetailed(user.userId, bookIds[q.book], q.question, 5, { rerank: cond.rerank, expectedContentHash: normHashes[q.book] }); }
                catch (e) { err = e.message; }
                const elapsed = performance.now() - t0;
                const m = metrics(res.candidates, q.goldQuotes || []);
                if (q.goldQuotes && q.goldQuotes.length) { agg.answerable++; if (m.hit) agg.hit++; agg.recall += m.recall || 0; agg.mrr += m.mrr || 0; }
                agg.latencies.push(elapsed);
                jsonl('retrieval.jsonl', {
                    id: q.id, book: q.book, group: q.group, condition: cond.name, query: q.question,
                    latencyMs: Math.round(elapsed), error: err, hit: m.hit, recall: m.recall, mrr: m.mrr,
                    status: res.status, paths: res.diagnostics.paths, rerank: res.diagnostics.rerank,
                    retrieved: res.candidates.map((h, i) => ({ rank: i + 1, chapter: h.chapter && h.chapter.title, method: h.method, score: h.score && h.score.value, locator: h.locator, preview: String(h.text).slice(0, 120), matchedGold: (q.goldQuotes || []).some(g => normalize(h.text).includes(normalize(g))) }))
                });
            }
            const pct = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))]); };
            summary.conditions[cond.name] = {
                answerable: agg.answerable,
                hitAt5: agg.answerable ? agg.hit / agg.answerable : null,
                evidenceRecallAt5: agg.answerable ? agg.recall / agg.answerable : null,
                mrrAt5: agg.answerable ? agg.mrr / agg.answerable : null,
                latencyP50: pct(agg.latencies, 0.5), latencyP95: pct(agg.latencies, 0.95),
                indexModes: idx
            };
            const c = summary.conditions[cond.name];
            console.log(`[${cond.name}] Hit@5=${(c.hitAt5 || 0).toFixed(3)} Recall@5=${(c.evidenceRecallAt5 || 0).toFixed(3)} MRR@5=${(c.mrrAt5 || 0).toFixed(3)} P50=${c.latencyP50}ms (n=${c.answerable})`);
        }
    } catch (e) {
        summary.fatalError = e.message;
        console.error('消融中断:', e);
    } finally {
        try { database.getDB().close(); } catch {}
        delete summary._lastIdx;
        summary.finishedAt = new Date().toISOString();
        fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2), 'utf-8');
        writeReport(outDir, summary);
        await srv.stop();
    }
    console.log(`\n结果: ${outDir}`);
    if (summary.fatalError) process.exit(1);
}

function writeReport(outDir, s) {
    const f = x => x == null ? '未测' : x.toFixed(3);
    const lines = ['# 检索消融对照报告', '',
        `- 运行: ${s.runId}`, `- 向量模型: ${s.embedModel}`, `- 重排模型: ${s.rerankModel || '无'}`,
        `- 语料hash: ${JSON.stringify(s.bookHashes)}`, ''];
    if (s.fatalError) lines.push(`**致命错误**: ${s.fatalError}`, '');
    lines.push('| 条件 | 可答题数 | Hit@5 | Recall@5 | MRR@5 | 延迟P50(ms) | 延迟P95(ms) |',
        '| --- | --- | --- | --- | --- | --- | --- |');
    for (const [name, c] of Object.entries(s.conditions)) {
        lines.push(`| ${name} | ${c.answerable} | ${f(c.hitAt5)} | ${f(c.evidenceRecallAt5)} | ${f(c.mrrAt5)} | ${c.latencyP50} | ${c.latencyP95} |`);
    }
    lines.push('', '## 口径', '- 固定 query=question，Top5；金标准为本地原文精确子串（去空白归一）。',
        '- no-answer 题不计入 Hit 分母。延迟含查询向量化与重排调用。',
        '- 混合+重排条件在融合候选上调用重排模型；重排失败保留原序（见 retrieval.jsonl 的 rerank 字段）。',
        '- 本报告为开发集初测，非正式保留集成绩。');
    fs.writeFileSync(path.join(outDir, 'report.md'), lines.join('\n'), 'utf-8');
}

main().catch(e => { console.error(e); process.exit(1); });