/**
 * P1b/P4 真实模型评测：统一入口跑 RAG 数据集，测引用合法率/坐标正确率/端到端证据命中/缺证/时延。
 * 用法：node scripts/run-p1b-eval.js --env-file .env.baseline.local [--limit N] [--rerank]
 *       P4 保留集：--dataset docs/baseline/holdout-rag-questions.json --prefix p4 --retrieval-compare
 * 产出：docs/baseline-results/<prefix>-<ts>/ answers.jsonl (+rag-retrieval.jsonl) + summary.json + report.md
 * 口径：开发集初测非正式成绩；保留集（frozen）为 P4 正式记录；答案正确率/引用支撑率待人工标注。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const REPO_ROOT = path.join(__dirname, '..');
const BASELINE = path.join(REPO_ROOT, 'docs', 'baseline');
const { startIsolatedServer, api, registerUser } = require('../tests/helpers/isolated-server');
const TU = require('../text-utils');

function parseArgs(argv) {
    const a = { envFile: null, limit: null, rerank: false, dataset: null, prefix: 'p1b', retrievalCompare: false };
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--env-file') a.envFile = argv[++i];
        else if (argv[i] === '--limit') a.limit = parseInt(argv[++i], 10);
        else if (argv[i] === '--rerank') a.rerank = true;
        else if (argv[i] === '--dataset') a.dataset = argv[++i];
        else if (argv[i] === '--prefix') a.prefix = argv[++i];
        else if (argv[i] === '--retrieval-compare') a.retrievalCompare = true;
    }
    return a;
}
const normalize = s => String(s).replace(/\s+/g, '');

async function unifiedAsk(base, token, body) {
    const t0 = performance.now();
    let firstAnswerAt = null;
    const res = await fetch(base + '/api/ask-stream', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body)
    });
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('text/event-stream')) {
        return { status: res.status, answer: null, metadata: null, answerKind: null, toolCalls: 0, firstAnswerMs: null, totalMs: performance.now() - t0, endStatus: null };
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '', answer = '', answerKind = null, toolCalls = 0, endStatus = null, metadata = null;
    const handle = (evt) => {
        const d = evt.data || {};
        if (evt.type === 'tool_call') toolCalls++;
        else if (evt.type === 'answer_start') answerKind = d.answerKind;
        else if (evt.type === 'chunk') { if (firstAnswerAt === null) firstAnswerAt = performance.now(); answer += d.content || ''; }
        else if (evt.type === 'end') { endStatus = d.status; if (d.assistantMessage) { metadata = d.assistantMessage.metadata || null; if (d.assistantMessage.content != null && !answer) answer = d.assistantMessage.content; } }
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
    return { status: res.status, answer, metadata, answerKind, toolCalls, firstAnswerMs: firstAnswerAt ? firstAnswerAt - t0 : null, totalMs: performance.now() - t0, endStatus };
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.envFile) require('dotenv').config({ path: path.resolve(args.envFile), override: true });
    const ds = JSON.parse(fs.readFileSync(path.resolve(args.dataset || path.join(BASELINE, 'dev-rag-questions.json')), 'utf-8'));
    const holdout = !!ds.frozen;
    const questions = args.limit ? ds.questions.slice(0, args.limit) : ds.questions;
    const model = process.env.AI_MODEL || null;
    const hasGeneric = !!(process.env.CUSTOM_API_ENDPOINT && (process.env.CUSTOM_API_KEY || process.env.AI_API_KEY));
    console.log(`P1b/P4评测: 模型=${model} 题数=${questions.length} rerank=${args.rerank} 数据集=${ds.version}${holdout ? '(保留集)' : '(开发集)'}（不打印密钥）`);
    if (!hasGeneric && !process.env.ZHIPU_API_KEY) { console.error('缺少凭据'); process.exit(2); }

    const runId = `${args.prefix}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    const outDir = path.join(REPO_ROOT, 'docs', 'baseline-results', runId);
    fs.mkdirSync(outDir, { recursive: true });
    const jsonl = (o) => fs.appendFileSync(path.join(outDir, 'answers.jsonl'), JSON.stringify(o) + '\n', 'utf-8');

    const srv = await startIsolatedServer({ keepKeys: true });
    const user = await registerUser(srv.url, 'p1b-eval');
    let providerId = 'zhipu';
    if (hasGeneric) {
        const p = await api(srv.url, '/api/providers', { method: 'POST', token: user.token, body: { id: 'custom-baseline', name: 'Baseline', apiEndpoint: process.env.CUSTOM_API_ENDPOINT, defaultModel: model || 'default', apiKey: process.env.CUSTOM_API_KEY || process.env.AI_API_KEY } });
        if (p.status !== 200) throw new Error('创建提供商失败: ' + p.text);
        providerId = 'custom-baseline';
    }
    if (process.env.EMBED_BASE_URL && process.env.EMBED_API_KEY) {
        await api(srv.url, '/api/embedding-settings', { method: 'PUT', token: user.token, body: { provider: 'custom', customBaseUrl: process.env.EMBED_BASE_URL, customModel: process.env.EMBED_MODEL_NAME, customApiKey: process.env.EMBED_API_KEY } });
    }
    if (args.rerank && process.env.RERANK_BASE_URL) {
        await api(srv.url, '/api/rerank-settings', { method: 'PUT', token: user.token, body: { enabled: true, baseUrl: process.env.RERANK_BASE_URL, model: process.env.RERANK_MODEL, topN: 10, rerankApiKey: process.env.RERANK_API_KEY } });
    }
    const bookIds = {}, contents = {}, normHashes = {};
    for (const [id, rel] of Object.entries(ds.books)) {
        const norm = TU.normalizeText(fs.readFileSync(path.join(REPO_ROOT, rel), 'utf-8'));
        contents[id] = norm; normHashes[id] = TU.contentHash(norm);
        const form = new FormData();
        form.append('book', new Blob([norm], { type: 'text/plain' }), path.basename(rel));
        const res = await fetch(`${srv.url}/api/books/upload`, { method: 'POST', headers: { Authorization: `Bearer ${user.token}` }, body: form });
        bookIds[id] = (await res.json()).book.id;
        const idx = await api(srv.url, `/api/books/${bookIds[id]}/index`, { method: 'POST', token: user.token, body: {} });
        console.log(`  索引 ${id}: ${idx.data.active && idx.data.active.mode} (${idx.data.active && idx.data.active.chunkCount}块)`);
    }

    const S = { runId, model, rerank: args.rerank, dataset: ds.version, holdout, total: 0, errors: 0, insufficient: 0, noEvidenceAnswer: 0,
        evWithLocator: 0, coordValid: 0, citedTotal: 0, citedLegal: 0, invalidCitWarn: 0,
        hit: 0, recall: 0, mrr: 0, answerable: 0, toolCallsSum: 0, firstAnswer: [], totalMs: [],
        needsEvidenceTotal: 0, needsEvidenceNoTool: 0, noAnswerTotal: 0, noAnswerHandled: 0, emptyAnswers: 0 };
    let retrievalCompare = null;
    let evalDatabase = null;
    if (args.retrievalCompare) {
        process.env.READER_DATA_ROOT = srv.dataRoot;
        evalDatabase = require('../database');
        const rag = require('../rag');
        const embedding = require('../embedding');
        await evalDatabase.initDB();
        embedding.init({
            getApiKey: (uid, pid) => {
                if (pid === 'zhipu') return process.env.ZHIPU_API_KEY || null;
                if (pid === 'siliconflow') return process.env.SILICONFLOW_API_KEY || null;
                return process.env.EMBED_API_KEY || process.env.CUSTOM_API_KEY || process.env.AI_API_KEY || null;
            }
        });
        const setEmbed = async (on) => {
            if (on && process.env.EMBED_BASE_URL && process.env.EMBED_API_KEY) {
                await api(srv.url, '/api/embedding-settings', { method: 'PUT', token: user.token, body: { provider: 'custom', customBaseUrl: process.env.EMBED_BASE_URL, customModel: process.env.EMBED_MODEL_NAME, customApiKey: process.env.EMBED_API_KEY } });
            } else if (on && hasGeneric && process.env.EMBED_MODEL_NAME) {
                await api(srv.url, '/api/embedding-settings', { method: 'PUT', token: user.token, body: { provider: 'custom', customBaseUrl: process.env.CUSTOM_API_ENDPOINT, customModel: process.env.EMBED_MODEL_NAME, customApiKey: process.env.CUSTOM_API_KEY || process.env.AI_API_KEY } });
            } else {
                await api(srv.url, '/api/embedding-settings', { method: 'PUT', token: user.token, body: { provider: 'off' } });
            }
        };
        const reindex = async () => { for (const bookId of Object.values(bookIds)) await api(srv.url, `/api/books/${bookId}/index`, { method: 'POST', token: user.token, body: {} }); };
        retrievalCompare = {};
        for (const [mode, on] of [['embedding+bm25', true], ['bm25', false]]) {
            await setEmbed(on); await reindex();
            const agg = { hit: 0, recallSum: 0, mrrSum: 0, answerable: 0 };
            for (const q of questions) {
                const t0 = performance.now();
                let hits = [], err = null;
                try { hits = await rag.retrieveAsync(user.userId, bookIds[q.book], q.question, 5); } catch (e) { err = e.message; }
                const ms = Math.round(performance.now() - t0);
                const texts = hits.map(h => normalize(h.text));
                const gold = q.goldQuotes || [];
                const matched = gold.map(g => texts.some(t => t.includes(normalize(g))));
                const hit = gold.length ? matched.some(Boolean) : null;
                const recall = gold.length ? matched.filter(Boolean).length / gold.length : null;
                let mrr = 0;
                if (gold.length) for (let i = 0; i < texts.length; i++) if (gold.some(g => texts[i].includes(normalize(g)))) { mrr = 1 / (i + 1); break; }
                if (gold.length) { agg.answerable++; if (hit) agg.hit++; agg.recallSum += recall; agg.mrrSum += mrr; }
                fs.appendFileSync(path.join(outDir, 'rag-retrieval.jsonl'), JSON.stringify({ id: q.id, book: q.book, group: q.group, mode, latencyMs: ms, error: err, hit, recall, mrr, retrieved: hits.map((h, i) => ({ rank: i + 1, chapter: h.chapter, score: h.score, preview: String(h.text).slice(0, 120), matchedGold: gold.some(g => normalize(h.text).includes(normalize(g))) })) }) + '\n', 'utf-8');
            }
            retrievalCompare[mode] = { answerable: agg.answerable, hitAt5: agg.answerable ? agg.hit / agg.answerable : null, evidenceRecallAt5: agg.answerable ? agg.recallSum / agg.answerable : null, mrrAt5: agg.answerable ? agg.mrrSum / agg.answerable : null };
            console.log(`[检索 ${mode}] Hit@5=${(retrievalCompare[mode].hitAt5 || 0).toFixed(3)} Recall@5=${(retrievalCompare[mode].evidenceRecallAt5 || 0).toFixed(3)} MRR@5=${(retrievalCompare[mode].mrrAt5 || 0).toFixed(3)} (n=${agg.answerable})`);
        }
        await setEmbed(true); await reindex();
    }
    try {
        for (const q of questions) {
            const conv = await api(srv.url, '/api/conversations', { method: 'POST', token: user.token, body: { bookId: bookIds[q.book] } });
            const turns = q.turns || [q.question];
            let last = null;
            for (const turn of turns) {
                last = await unifiedAsk(srv.url, user.token, { requestId: crypto.randomUUID(), question: turn, bookId: bookIds[q.book], provider: providerId, model, conversationId: conv.data.conversation.id });
            }
            const meta = last.metadata || {};
            const evidence = meta.evidence || [];
            const cited = meta.citedEvidenceIds || [];
            const content = contents[q.book];
            // 坐标正确率：带 locator 的证据 text 必须等于当前规范原文 slice 且 hash 一致
            let evLoc = 0, coordOk = 0;
            for (const e of evidence) {
                if (e.locator) {
                    evLoc++;
                    if (e.locator.contentHash === normHashes[q.book] && e.text === content.slice(e.locator.start, e.locator.end)) coordOk++;
                }
            }
            const evIds = new Set(evidence.map(e => e.evidenceId));
            const citedLegal = cited.every(id => evIds.has(id));
            // 端到端证据命中（模型实际见到的证据 vs 金标准）
            const gold = q.goldQuotes || [];
            let hit = null, recall = null, mrr = 0;
            if (gold.length) {
                const texts = evidence.map(e => normalize(e.text || ''));
                const matched = gold.map(g => texts.some(t => t.includes(normalize(g))));
                hit = matched.some(Boolean); recall = matched.filter(Boolean).length / gold.length;
                for (let i = 0; i < texts.length; i++) if (gold.some(g => texts[i].includes(normalize(g)))) { mrr = 1 / (i + 1); break; }
                S.answerable++; if (hit) S.hit++; S.recall += recall; S.mrr += mrr;
            }
            S.total++;
            if (last.endStatus !== 'completed') S.errors++;
            if (!(last.answer || '').trim()) S.emptyAnswers++;
            if (last.answerKind === 'insufficient_evidence') S.insufficient++;
            if (last.answerKind === 'answer' && evidence.length === 0) S.noEvidenceAnswer++;
            const noAnswer = gold.length === 0;
            let noAnswerHandled = null;
            if (noAnswer) {
                S.noAnswerTotal++;
                noAnswerHandled = last.answerKind === 'insufficient_evidence' || /证据不足|书中(并)?(未|没有)|未(给出|记载|提供|找到)|无法(从|在)书中|没有(给出|记载|找到)/.test(last.answer || '');
                if (noAnswerHandled) S.noAnswerHandled++;
            }
            S.evWithLocator += evLoc; S.coordValid += coordOk;
            S.citedTotal += cited.length; if (citedLegal) S.citedLegal += cited.length;
            if ((meta.warnings || []).some(w => w.code === 'INVALID_CITATION')) S.invalidCitWarn++;
            S.toolCallsSum += last.toolCalls || 0;
            if (last.firstAnswerMs != null) S.firstAnswer.push(last.firstAnswerMs);
            S.totalMs.push(last.totalMs);
            if (q.needsEvidence) { S.needsEvidenceTotal++; if ((last.toolCalls || 0) === 0 && evidence.length === 0) S.needsEvidenceNoTool++; }
            jsonl({ id: q.id, book: q.book, group: q.group, needsEvidence: q.needsEvidence, question: q.question,
                answerKind: last.answerKind, endStatus: last.endStatus, toolCalls: last.toolCalls,
                evidenceCount: evidence.length, evWithLocator: evLoc, coordValid: coordOk,
                citedEvidenceIds: cited, citedLegal, hit, recall, mrr, noAnswer, noAnswerHandled,
                firstAnswerMs: last.firstAnswerMs, totalMs: last.totalMs, expected: q.expected, answer: last.answer });
            console.log(`  ${q.id}: kind=${last.answerKind} ev=${evidence.length} loc=${evLoc}/${coordOk} cited=${cited.length}(${citedLegal ? 'legal' : 'ILLEGAL'}) hit=${hit} noAns=${noAnswerHandled} first=${last.firstAnswerMs ? Math.round(last.firstAnswerMs) : '-'}ms`);
        }
    } catch (e) { S.fatalError = e.message; console.error('中断:', e); }
    finally {
        const pct = (arr, p) => { if (!arr.length) return null; const s = [...arr].sort((a, b) => a - b); return Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))]); };
        S.coordAccuracy = S.evWithLocator ? S.coordValid / S.evWithLocator : null;
        S.citationLegality = S.citedTotal ? S.citedLegal / S.citedTotal : null;
        S.hitAt5 = S.answerable ? S.hit / S.answerable : null;
        S.evidenceRecallAt5 = S.answerable ? S.recall / S.answerable : null;
        S.mrrAt5 = S.answerable ? S.mrr / S.answerable : null;
        S.noEvidenceAnswerRate = S.total ? S.noEvidenceAnswer / S.total : null;
        S.missedRetrievalRate = S.needsEvidenceTotal ? S.needsEvidenceNoTool / S.needsEvidenceTotal : null;
        S.noAnswerHandlingRate = S.noAnswerTotal ? S.noAnswerHandled / S.noAnswerTotal : null;
        S.retrievalCompare = retrievalCompare;
        S.avgToolCalls = S.total ? S.toolCallsSum / S.total : null;
        S.firstAnswerP50 = pct(S.firstAnswer, 0.5); S.firstAnswerP95 = pct(S.firstAnswer, 0.95);
        S.totalP50 = pct(S.totalMs, 0.5);
        S.finishedAt = new Date().toISOString();
        fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(S, null, 2), 'utf-8');
        const f = x => x == null ? '未测' : (typeof x === 'number' ? x.toFixed(3) : x);
        const report = [`# ${holdout ? 'P4 保留集' : 'P1b 开发集'}真实模型评测报告`, '',
            `- 运行: ${S.runId}  模型: ${S.model}  重排: ${S.rerank}  数据集: ${ds.version}`, `- 题数: ${S.total}`, '',
            ...(retrievalCompare ? ['## 直接检索对照（固定query=question，Top5）', '', '| 模式 | 可答题数 | Hit@5 | Recall@5 | MRR@5 |', '| --- | --- | --- | --- | --- |',
                ...Object.entries(retrievalCompare).map(([m, r]) => `| ${m} | ${r.answerable} | ${f(r.hitAt5)} | ${f(r.evidenceRecallAt5)} | ${f(r.mrrAt5)} |`), ''] : []),
            '| 指标 | 值 |', '| --- | --- |',
            `| 引用坐标正确率（locator text==原文slice） | ${f(S.coordAccuracy)} |`,
            `| 引用合法率（cited⊆本轮白名单） | ${f(S.citationLegality)} |`,
            `| 端到端证据 Hit@5 | ${f(S.hitAt5)} |`,
            `| 端到端 Evidence Recall@5 | ${f(S.evidenceRecallAt5)} |`,
            `| 端到端 MRR@5 | ${f(S.mrrAt5)} |`,
            `| 无据回答率 | ${f(S.noEvidenceAnswerRate)} |`,
            `| 需取证漏查率 | ${f(S.missedRetrievalRate)} |`,
            `| 缺证说明数 | ${S.insufficient} |`,
            `| 无答案题缺证处理率（启发式，待人工复核） | ${f(S.noAnswerHandlingRate)}（${S.noAnswerHandled}/${S.noAnswerTotal}） |`,
            `| 无效引用规范化次数 | ${S.invalidCitWarn} |`,
            `| 平均工具调用 | ${f(S.avgToolCalls)} |`,
            `| 错误率 | ${f(S.total ? S.errors / S.total : null)} |`,
            `| 空答案数（思考模型预算缺陷指标） | ${S.emptyAnswers} |`,
            `| 首字P50(ms) | ${S.firstAnswerP50 ?? '未测'} |`,
            `| 首字P95(ms) | ${S.firstAnswerP95 ?? '未测'} |`, '',
            '## 对比基线（同模型开发集参考，非保留集成绩）',
            '- P0/增强 检索消融（旧分块）：BM25 Hit@5=0.750；混合 Hit@5=0.875；混合+重排 MRR@5=0.688。',
            '- P1a 统一入口：漏查率 0%、无据回答率 0%、首字P50≈34.6s。',
            '- P1b 坐标化分块可能改变边界，检索指标如实报告，不承诺提升；引用合法/坐标目标 100%。', '',
            '## 口径', holdout ? '- 正式保留集（冻结于 holdout-rag-questions.json）；单次运行，原始记录与失败样本见 answers.jsonl。' : '- 开发集初测，非保留集。',
            '- 答案正确率/引用支撑率待人工标注；无答案题处理率为结构启发式，须人工复核。',
            '- 坐标正确率=带locator证据中 text==规范原文slice 且 contentHash 一致的比例。',
            '- 引用合法率=最终 citedEvidenceIds 中属于本轮证据白名单的比例。',
            '- 端到端命中以模型实际见到的证据（evidence 事件）对金标准子串匹配。'];
        fs.writeFileSync(path.join(outDir, 'report.md'), report.join('\n'), 'utf-8');
        if (evalDatabase) { try { evalDatabase.getDB().close(); } catch {} }
        await srv.stop();
    }
    console.log(`\n结果: ${outDir}`);
    console.log(`坐标正确率=${f(S.coordAccuracy)} 引用合法率=${f(S.citationLegality)} Hit@5=${f(S.hitAt5)} 首字P50=${S.firstAnswerP50}ms`);
    if (S.fatalError) process.exit(1);
}
function f(x) { return x == null ? '未测' : (typeof x === 'number' ? x.toFixed(3) : x); }
main().catch(e => { console.error(e); process.exit(1); });