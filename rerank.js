/**
 * 可选重排序（Rerank）模块
 * - 用户配置 OpenAI 兼容 /rerank 端点（如 SiliconFlow bge-reranker-v2-m3），默认关闭
 * - 对 RAG 融合候选做有限重排；失败由调用方保留原排序并记 warning（不阻断检索）
 * - Key 加密存储复用 server.js 注入的 getApiKey；不打印密钥
 * - 维度/分数：relevance_score 为相关性排序分，不是概率，不与 BM25/RRF 分数跨类型比较
 */
const { getDB } = require('./database');

const RERANK_KEY_PROVIDER = 'rerank';
const DEFAULT_RERANK_TOPN = 10;
const MAX_RERANK_TOPN = 20;

let deps = { getApiKey: null };

function init({ getApiKey }) {
    deps.getApiKey = getApiKey;
}

function getSetting(userId, key) {
    const row = getDB().prepare('SELECT value FROM user_settings WHERE user_id = ? AND key = ?').get(userId, key);
    return row ? row.value : null;
}

function setSetting(userId, key, value) {
    getDB().prepare(`
        INSERT INTO user_settings (user_id, key, value, updated_at)
        VALUES (?, ?, ?, datetime('now'))
        ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
    `).run(userId, key, value);
}

function normalizeRerankEndpoint(baseUrl) {
    let e = String(baseUrl || '').trim().replace(/\/+$/, '');
    if (!e) return '';
    return /\/rerank$/i.test(e) ? e : e + '/rerank';
}

function getRerankSettings(userId) {
    let cfg = { enabled: false, baseUrl: '', model: '', topN: DEFAULT_RERANK_TOPN };
    try {
        const raw = getSetting(userId, 'rerank');
        if (raw) cfg = { ...cfg, ...JSON.parse(raw) };
    } catch {}
    if (!cfg.baseUrl && process.env.RERANK_BASE_URL) {
        cfg.baseUrl = process.env.RERANK_BASE_URL;
        cfg.model = cfg.model || process.env.RERANK_MODEL || '';
    }
    cfg.enabled = !!cfg.enabled;
    cfg.topN = Math.max(1, Math.min(MAX_RERANK_TOPN, parseInt(cfg.topN, 10) || DEFAULT_RERANK_TOPN));
    return cfg;
}

function saveRerankSettings(userId, { enabled, baseUrl, model, topN }) {
    const cur = getRerankSettings(userId);
    const next = {
        enabled: enabled !== undefined ? !!enabled : cur.enabled,
        baseUrl: baseUrl !== undefined ? String(baseUrl || '').trim().replace(/\/+$/, '') : cur.baseUrl,
        model: model !== undefined ? String(model || '').trim() : cur.model,
        topN: topN !== undefined ? Math.max(1, Math.min(MAX_RERANK_TOPN, parseInt(topN, 10) || DEFAULT_RERANK_TOPN)) : cur.topN
    };
    setSetting(userId, 'rerank', JSON.stringify(next));
    return next;
}

function getRerankKey(userId) {
    const key = deps.getApiKey && deps.getApiKey(userId, RERANK_KEY_PROVIDER);
    return key || process.env.RERANK_API_KEY || null;
}

/** 解析当前用户可用重排器；关闭或缺配置返回 null */
function resolveReranker(userId) {
    const cfg = getRerankSettings(userId);
    if (!cfg.enabled) return null;
    const endpoint = normalizeRerankEndpoint(cfg.baseUrl);
    const apiKey = getRerankKey(userId);
    if (!endpoint || !cfg.model || !apiKey) return null;
    return { endpoint, model: cfg.model, apiKey, topN: cfg.topN };
}

/**
 * 调用重排接口，返回按相关性降序的 [{ index, score }]
 * @param {Object} reranker resolveReranker 返回值
 * @param {string} query
 * @param {string[]} documents
 * @returns {Promise<Array<{index:number, score:number}>>}
 */
async function rerankDocuments(reranker, query, documents, { topN, timeoutMs = 20000, signal } = {}) {
    if (!documents.length) return [];
    const n = Math.max(1, Math.min(topN || reranker.topN || documents.length, documents.length));
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = () => controller.abort();
    if (signal) {
        if (signal.aborted) controller.abort();
        else signal.addEventListener('abort', onAbort, { once: true });
    }
    try {
        const resp = await fetch(reranker.endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${reranker.apiKey}` },
            body: JSON.stringify({ model: reranker.model, query, documents, top_n: n }),
            signal: controller.signal
        });
        if (!resp.ok) {
            const errBody = await resp.json().catch(() => ({}));
            const detail = errBody?.error?.message || errBody?.message || '';
            const err = new Error(`Rerank API 失败: ${resp.status}${detail ? ` - ${detail}` : ''}`);
            err.status = resp.status;
            throw err;
        }
        const data = await resp.json();
        const results = Array.isArray(data.results) ? data.results : [];
        const out = [];
        for (const r of results) {
            const idx = r.index;
            if (!Number.isInteger(idx) || idx < 0 || idx >= documents.length) continue;
            const score = typeof r.relevance_score === 'number' ? r.relevance_score : 0;
            out.push({ index: idx, score });
        }
        out.sort((a, b) => b.score - a.score);
        return out.slice(0, n);
    } finally {
        clearTimeout(timeout);
        if (signal) signal.removeEventListener('abort', onAbort);
    }
}

async function validateReranker(reranker) {
    await rerankDocuments(reranker, '测试查询', ['测试文档一', '测试文档二'], { topN: 2, timeoutMs: 15000 });
    return true;
}

module.exports = {
    RERANK_KEY_PROVIDER,
    DEFAULT_RERANK_TOPN,
    MAX_RERANK_TOPN,
    init,
    getRerankSettings,
    saveRerankSettings,
    resolveReranker,
    rerankDocuments,
    validateReranker,
    normalizeRerankEndpoint
};