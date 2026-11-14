/**
 * 统一工具结果契约（P1a A2，SC-1.1 §6.3）
 * ToolResult = { status, candidates, data, diagnostics, truncated, error }
 * 原文放 candidates；data 仅承载工具专有元信息。P1a 候选 locator 可为 null（P1b 补定位）。
 */

function candidate({ bookId, chapter, text, method, rank = null, score = null, locator = null, contentHash = null, chunkId = null }) {
    return { bookId, contentHash, chunkId, chapter: chapter ?? null, text, locator, method, rank, score };
}

function ok(candidates, data = null, diagnostics = {}) {
    return { status: candidates.length ? 'ok' : 'empty', candidates, data, diagnostics, truncated: false, error: null };
}

function empty(data = null, diagnostics = {}) {
    return { status: 'empty', candidates: [], data, diagnostics, truncated: false, error: null };
}

function unavailable(code, message, data = null) {
    return { status: 'unavailable', candidates: [], data, diagnostics: {}, truncated: false, error: { code, message, retryable: false } };
}

function error(code, message) {
    return { status: 'error', candidates: [], data: null, diagnostics: {}, truncated: false, error: { code, message, retryable: false } };
}

/** 按文本预算裁剪候选正文，截断后仍合法；返回 { candidates, truncated } */
function truncateCandidates(candidates, maxCharsPerItem = 600, maxItems = 10) {
    let truncated = false;
    const items = candidates.slice(0, maxItems);
    if (candidates.length > maxItems) truncated = true;
    const out = items.map(c => {
        if (typeof c.text === 'string' && c.text.length > maxCharsPerItem) {
            truncated = true;
            return { ...c, text: c.text.slice(0, maxCharsPerItem) };
        }
        return c;
    });
    return { candidates: out, truncated };
}

module.exports = { candidate, ok, empty, unavailable, error, truncateCandidates };