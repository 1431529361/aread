/**
 * P3-记忆 词法门槛离线选择：从开发集脚本与某次评测的 scripts.jsonl 重算 (问题, 记忆) 对，
 * 相关对=探针 expectRefs 命中的非偏好记忆；无关对=同用户其余非偏好 active 记忆（不论是否被注入）。
 * 用法：node scripts/analyze-p2-threshold.js <runDir>
 * 口径：开发集选择门槛；保留集不参与。Jaccard 基于 rag.tokenize 去停用词。
 */
const fs = require('fs');
const path = require('path');
const REPO_ROOT = path.join(__dirname, '..');
const conv = require('../conversation');

const runDir = process.argv[2];
if (!runDir) { console.error('用法: node scripts/analyze-p2-threshold.js <runDir>'); process.exit(2); }
const ds = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'docs', 'baseline', 'dev-memory-scripts-p2.json'), 'utf-8'));
const scripts = fs.readFileSync(path.join(runDir, 'scripts.jsonl'), 'utf-8').trim().split('\n').map(JSON.parse);
const keyMatch = (pattern, key) => pattern.endsWith('*') ? key.startsWith(pattern.slice(0, -1)) : pattern === key;

const pairs = [];
for (const sc of ds.scripts) {
    const rec = scripts.find(s => s.id === sc.id);
    if (!rec) continue;
    const mems = (rec.saved || []).filter(m => m.status === 'active' && m.kind !== 'preference');
    for (const p of sc.probes || []) {
        for (const m of mems) {
            const relevant = (p.expectRefs || []).some(k => keyMatch(k, m.key));
            pairs.push({ script: sc.id, question: p.question, content: m.content, key: m.key, relevant });
        }
    }
}
const results = [];
for (const th of [0.15, 0.25, 0.35]) {
    let relHit = 0, relTotal = 0, irrHit = 0, irrTotal = 0;
    const detail = [];
    for (const p of pairs) {
        const score = conv.jaccard(conv.tokenSet(p.question), conv.tokenSet(p.content));
        const inj = score >= th;
        if (p.relevant) { relTotal++; if (inj) relHit++; }
        else { irrTotal++; if (inj) irrHit++; }
        detail.push({ ...p, score: Number(score.toFixed(3)), injectedAtTh: inj });
    }
    results.push({ threshold: th, relevantRecall: relTotal ? relHit / relTotal : null, irrelevantInject: irrTotal ? irrHit / irrTotal : null, relTotal, irrTotal });
}
console.log(JSON.stringify({ pairs: pairs.length, results }, null, 2));
fs.writeFileSync(path.join(runDir, 'threshold-analysis.json'), JSON.stringify({ pairs, results }, null, 2));