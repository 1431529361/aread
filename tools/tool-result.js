/**
 * 统一工具结果契约（P1a A2 / P1b R2b，SC-1.1 §6.3）
 * ToolResult = { status, candidates, data, diagnostics, truncated, error }
 * 原文放 candidates；data 仅承载工具专有元信息。截短正文必须同步改 locator.end。
 */
const TU = require('../text-utils');

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

/** 按文本预算裁剪候选正文，截断后仍合法；locator.end 同步收缩且不切代理对 */
function truncateCandidates(candidates, maxCharsPerItem = 600, maxItems = 10) {
    let truncated = false;
    const items = candidates.slice(0, maxItems);
    if (candidates.length > maxItems) truncated = true;
    const out = items.map(c => {
        if (typeof c.text === 'string' && c.text.length > maxCharsPerItem) {
            truncated = true;
            const safe = TU.sliceAtSafeBoundary(c.text, 0, maxCharsPerItem);
            const next = { ...c, text: safe.text };
            if (c.locator) next.locator = { ...c.locator, end: c.locator.start + safe.end };
            return next;
        }
        return c;
    });
    return { candidates: out, truncated };
}

module.exports = { candidate, ok, empty, unavailable, error, truncateCandidates };