/**
 * 请求记录与幂等（P1a A1，SC-1.1 §10）
 * - 对 (userId, requestId) 唯一；指纹基于客户端语义字段（含省略字段固定默认），不含会变的提示文本
 * - 同 requestId+同指纹已终结→重放；running→冲突；异指纹→冲突
 * - 重启遗留 running 转 interrupted，不自动重放付费调用
 */
const crypto = require('crypto');
const { getDB } = require('./database');

const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'interrupted']);

function nowISO() { return new Date().toISOString(); }

/** 规范化语义字段并计算稳定指纹 */
function computeFingerprint(input) {
    const norm = {
        entry: input.entry || 'ask',
        question: String(input.question || ''),
        selectionText: input.selection && input.selection.text ? String(input.selection.text) : '',
        action: input.action || 'ask',
        bookId: input.bookId || null,
        conversationId: input.conversationId || null,
        provider: input.provider || null,
        model: input.model || null,
        taskType: input.taskType || null
    };
    return crypto.createHash('sha256').update(JSON.stringify(norm)).digest('hex');
}

function getRequest(userId, requestId) {
    return getDB().prepare('SELECT * FROM requests WHERE user_id = ? AND request_id = ?').get(userId, requestId) || null;
}

function createRequest({ userId, requestId, fingerprint, conversationId, userMessageId, assistantMessageId }) {
    const ts = nowISO();
    getDB().prepare(`
        INSERT INTO requests (user_id, request_id, fingerprint, conversation_id, user_message_id, assistant_message_id, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?)
    `).run(userId, requestId, fingerprint, conversationId || null, userMessageId || null, assistantMessageId || null, ts, ts);
    return getRequest(userId, requestId);
}

function updateRequest(userId, requestId, fields) {
    const cur = getRequest(userId, requestId);
    if (!cur) return null;
    const next = {
        status: fields.status !== undefined ? fields.status : cur.status,
        error: fields.error !== undefined ? fields.error : cur.error,
        post_processing: fields.postProcessing !== undefined ? fields.postProcessing : cur.post_processing,
        assistant_message_id: fields.assistantMessageId !== undefined ? fields.assistantMessageId : cur.assistant_message_id,
        conversation_id: fields.conversationId !== undefined ? fields.conversationId : cur.conversation_id
    };
    getDB().prepare(`
        UPDATE requests SET status = ?, error = ?, post_processing = ?, assistant_message_id = ?, conversation_id = ?, updated_at = ?
        WHERE user_id = ? AND request_id = ?
    `).run(next.status, next.error, next.post_processing, next.assistant_message_id, next.conversation_id, nowISO(), userId, requestId);
    return getRequest(userId, requestId);
}

function isTerminal(status) { return TERMINAL.has(status); }

/** 进程启动时把遗留 running 标 interrupted（不自动重放） */
function interruptStaleRunning() {
    const info = getDB().prepare("UPDATE requests SET status = 'interrupted', updated_at = ? WHERE status = 'running'").run(nowISO());
    return info.changes;
}

module.exports = { computeFingerprint, getRequest, createRequest, updateRequest, isTerminal, interruptStaleRunning, TERMINAL };