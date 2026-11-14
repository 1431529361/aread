/**
 * 开发集金标准校验（只读）：逐条验证 goldQuote 是本地原文精确子串，
 * 记录字符偏移与所在章节，输出可追溯报告。任何 MISS 都以非零退出码结束。
 * 用法：node scripts/verify-devset.js
 */
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..');
const BASELINE = path.join(REPO_ROOT, 'docs', 'baseline');

function normalize(s) {
    return String(s).replace(/\s+/g, '');
}

function chapterAt(text, index) {
    const before = text.slice(0, index);
    const matches = [...before.matchAll(/第[一二三四五六七八九十百]+章/g)];
    return matches.length ? matches[matches.length - 1][0] : '前言/简介';
}

function main() {
    const ds = JSON.parse(fs.readFileSync(path.join(BASELINE, 'dev-rag-questions.json'), 'utf-8'));
    const bookTexts = {};
    for (const [id, rel] of Object.entries(ds.books)) {
        bookTexts[id] = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf-8');
    }

    const results = [];
    let miss = 0;
    let totalQuotes = 0;
    for (const q of ds.questions) {
        const text = bookTexts[q.book];
        const normText = normalize(text);
        const quoteChecks = [];
        for (const quote of q.goldQuotes || []) {
            totalQuotes++;
            const rawIndex = text.indexOf(quote);
            const normIndex = normText.indexOf(normalize(quote));
            const ok = rawIndex >= 0 || normIndex >= 0;
            if (!ok) miss++;
            quoteChecks.push({
                quote,
                exactMatch: rawIndex >= 0,
                normalizedMatch: normIndex >= 0,
                charOffset: rawIndex >= 0 ? rawIndex : null,
                chapter: rawIndex >= 0 ? chapterAt(text, rawIndex) : null,
                ok
            });
        }
        results.push({
            id: q.id, book: q.book, group: q.group,
            needsEvidence: q.needsEvidence, isLongTask: q.isLongTask,
            noAnswer: (q.goldQuotes || []).length === 0,
            quoteChecks
        });
    }

    const byGroup = {};
    const byBook = {};
    for (const q of ds.questions) {
        byGroup[q.group] = (byGroup[q.group] || 0) + 1;
        byBook[q.book] = (byBook[q.book] || 0) + 1;
    }

    const report = {
        generatedAt: new Date().toISOString(),
        datasetVersion: ds.version,
        totalQuestions: ds.questions.length,
        byGroup, byBook,
        totalGoldQuotes: totalQuotes,
        missedQuotes: miss,
        allQuotesVerified: miss === 0,
        results
    };
    fs.writeFileSync(path.join(BASELINE, 'devset-verification.json'), JSON.stringify(report, null, 2), 'utf-8');
    console.log(`题目数: ${ds.questions.length}（按组: ${JSON.stringify(byGroup)}）`);
    console.log(`金标准引文: ${totalQuotes} 条，未命中: ${miss}`);
    console.log(`校验结果: ${miss === 0 ? '全部通过' : '存在未命中，需修正'}`);
    if (miss > 0) {
        for (const r of results) {
            for (const c of r.quoteChecks) {
                if (!c.ok) console.log(`  MISS ${r.id}: ${c.quote}`);
            }
        }
        process.exit(1);
    }
}

main();