/**
 * 会话管理 / 上下文压缩 / 长期记忆 编排模块
 *
 * 职责：
 * - 会话隔离：按 (userId, bookId) 维护 active 会话，切书自动切换、可新建对话
 * - 消息持久化：会话内消息落盘（messages 表），维护工作窗口（in_window）
 * - 上下文压缩：滚动摘要（recursive summarization），支持自动 / 手动触发
 * - 长期记忆：从对话中抽取用户偏好/事实并跨会话注入
 *
 * 设计要点：本模块只做"状态编排 + Prompt 组装"，实际 LLM 调用走 OpenAI 兼容 HTTP API。
 */

const { v4: uuidv4 } = require('uuid');
const { getDB } = require('./database');
const { encode } = require('gpt-tokenizer');
const rag = require('./rag');
const llmClient = require('./llm-client');

// ==================== 常量配置 ====================

// 各模型上下文窗口（token）。未知模型给保守默认值。
const MODEL_CONTEXT_LIMITS = {
    'glm-4-long': 1000000,
    'glm-4.5-air': 128000,
    'glm-4-flash': 128000,
    'glm-4-plus': 128000,
    'deepseek-ai/DeepSeek-V4-Flash': 64000,
    'Qwen/Qwen3.6-35B-A3B': 32000
};
const DEFAULT_CONTEXT_LIMIT = 32000;

const COMPRESS_RATIO = 0.7;      // 工作窗口达到上下文窗口的该比例时触发自动压缩
const RESERVED_TOKENS = 2500;    // 为本轮回答 + system 开销预留
const KEEP_RECENT_MESSAGES = 6;  // 压缩时保留最近的原始消息条数（约 3 轮）
const MAX_MEMORIES_PER_USER = 200;
const MAX_MEMORY_PER_EXTRACT = 5;

// ==================== token 估算 ====================

function estimateTokens(text) {
    if (!text) return 0;
    try {
        return encode(String(text)).length;
    } catch {
        // 兜底：粗略按字符估算（中文 1 字≈1.5 token 上界）
        return Math.ceil(String(text).length * 0.6);
    }
}

function getModelContextLimit(model) {
    if (!model) return DEFAULT_CONTEXT_LIMIT;
    if (MODEL_CONTEXT_LIMITS[model]) return MODEL_CONTEXT_LIMITS[model];
    if (/long/i.test(model)) return 1000000;
    return DEFAULT_CONTEXT_LIMIT;
}

// ==================== 通用非流式 LLM 调用（压缩/记忆抽取用） ====================

// 统一走 llm-client，保留本模块既有的 40s 超时
function llmComplete(ctx, prompt, { maxTokens = 800, temperature = 0.3 } = {}) {
    return llmClient.complete(ctx, prompt, { maxTokens, temperature, timeoutMs: 40000 });
}

// ==================== 会话 CRUD ====================

function nowISO() { return new Date().toISOString(); }

function touchConversation(convId) {
    getDB().prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(nowISO(), convId);
}

function getConversation(userId, convId) {
    return getDB().prepare('SELECT * FROM conversations WHERE id = ? AND user_id = ?').get(convId, userId);
}

function listConversations(userId, bookId) {
    const db = getDB();
    if (bookId) {
        return db.prepare(
            'SELECT * FROM conversations WHERE user_id = ? AND book_id = ? ORDER BY updated_at DESC'
        ).all(userId, bookId);
    }
    return db.prepare('SELECT * FROM conversations WHERE user_id = ? ORDER BY updated_at DESC').all(userId);
}

/**
 * 新建对话：将该书当前 active 会话归档，创建一个新的 active 会话
 */
function createConversation(userId, bookId, provider, model) {
    const db = getDB();
    const id = uuidv4();
    const ts = nowISO();
    const tx = db.transaction(() => {
        if (bookId) {
            db.prepare("UPDATE conversations SET status = 'archived', updated_at = ? WHERE user_id = ? AND book_id = ? AND status = 'active'")
                .run(ts, userId, bookId);
        }
        db.prepare(`INSERT INTO conversations (id, user_id, book_id, title, status, provider, model, created_at, updated_at)
                    VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?)`)
            .run(id, userId, bookId || null, '新对话', provider || null, model || null, ts, ts);
    });
    tx();
    return getConversation(userId, id);
}

/**
 * 获取或创建某本书的 active 会话（会话隔离核心）
 */
function getOrCreateActiveConversation(userId, bookId, provider, model) {
    const db = getDB();
    let conv;
    if (bookId) {
        conv = db.prepare("SELECT * FROM conversations WHERE user_id = ? AND book_id = ? AND status = 'active' ORDER BY updated_at DESC LIMIT 1")
            .get(userId, bookId);
    } else {
        conv = db.prepare("SELECT * FROM conversations WHERE user_id = ? AND book_id IS NULL AND status = 'active' ORDER BY updated_at DESC LIMIT 1")
            .get(userId);
    }
    if (conv) return conv;
    return createConversation(userId, bookId, provider, model);
}

function archiveConversation(userId, convId) {
    getDB().prepare("UPDATE conversations SET status = 'archived', updated_at = ? WHERE id = ? AND user_id = ?")
        .run(nowISO(), convId, userId);
}

function deleteConversation(userId, convId) {
    // messages 通过外键 ON DELETE CASCADE 一并删除
    getDB().prepare('DELETE FROM conversations WHERE id = ? AND user_id = ?').run(convId, userId);
}

// ==================== 消息读写 ====================

function getConversationMessages(convId, { windowOnly = false } = {}) {
    const db = getDB();
    const sql = windowOnly
        ? 'SELECT * FROM messages WHERE conversation_id = ? AND in_window = 1 ORDER BY seq ASC'
        : 'SELECT * FROM messages WHERE conversation_id = ? ORDER BY seq ASC';
    return db.prepare(sql).all(convId);
}

/**
 * 追加一条消息，自动分配 seq，累加会话 token_estimate
 * @param {Object} msg { role, content, tool_calls?, tool_call_id? }
 */
function appendMessage(convId, msg) {
    const db = getDB();
    const seqRow = db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM messages WHERE conversation_id = ?').get(convId);
    const seq = seqRow.next;
    const toolCalls = msg.tool_calls ? JSON.stringify(msg.tool_calls) : null;
    const tokens = estimateTokens(msg.content) + (toolCalls ? estimateTokens(toolCalls) : 0);
    const ts = nowISO();

    const tx = db.transaction(() => {
        db.prepare(`INSERT INTO messages (conversation_id, seq, role, content, tool_calls, tool_call_id, token_estimate, in_window, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`)
            .run(convId, seq, msg.role, msg.content ?? null, toolCalls, msg.tool_call_id ?? null, tokens, ts);
        db.prepare('UPDATE conversations SET token_estimate = token_estimate + ?, updated_at = ? WHERE id = ?')
            .run(tokens, ts, convId);
    });
    tx();
    return { seq, tokens };
}

/**
 * 若会话仍是默认标题，用首条用户问题生成标题
 */
function maybeSetTitle(convId, question) {
    const db = getDB();
    const conv = db.prepare('SELECT title FROM conversations WHERE id = ?').get(convId);
    if (conv && (conv.title === '新对话' || !conv.title)) {
        const title = String(question).replace(/\s+/g, ' ').trim().substring(0, 30);
        if (title) db.prepare('UPDATE conversations SET title = ? WHERE id = ?').run(title, convId);
    }
}

// ==================== 模型消息组装 ====================

/**
 * 组装发送给模型的 messages 数组
 * 顺序：[system(+记忆+摘要)] + [工作窗口内消息]
 * @param {Object} conv 会话行
 * @param {string} baseSystemPrompt 基础 system prompt
 * @param {Object} opts { memoriesText }
 */
function buildModelMessages(conv, baseSystemPrompt, opts = {}) {
    const db = getDB();
    let sys = baseSystemPrompt;
    if (opts.memoriesText) {
        sys += `\n\n【关于该用户的已知信息（长期记忆）】\n${opts.memoriesText}\n（如与当前问题相关可参考，不相关请忽略）`;
    }
    if (conv.summary) {
        sys += `\n\n【当前会话的历史摘要】\n${conv.summary}`;
    }

    const msgs = [{ role: 'system', content: sys }];
    const rows = db.prepare('SELECT role, content, tool_calls, tool_call_id FROM messages WHERE conversation_id = ? AND in_window = 1 ORDER BY seq ASC').all(conv.id);
    for (const r of rows) {
        const m = { role: r.role };
        m.content = r.content ?? null;
        if (r.tool_calls) m.tool_calls = JSON.parse(r.tool_calls);
        if (r.tool_call_id) m.tool_call_id = r.tool_call_id;
        msgs.push(m);
    }
    return msgs;
}

// ==================== 上下文压缩（滚动摘要） ====================

/**
 * 执行压缩：将较旧的窗口消息汇总进 summary，仅保留最近 KEEP_RECENT_MESSAGES 条原始消息
 * @param {Object} ctx { apiKey, providerConfig, model }
 * @param {Object} conv 会话行
 * @returns {Object} { compressed, before, after, summary }
 */
async function compressConversation(ctx, conv) {
    const db = getDB();
    const windowMsgs = getConversationMessages(conv.id, { windowOnly: true });
    if (windowMsgs.length <= KEEP_RECENT_MESSAGES) {
        return { compressed: false, reason: 'not_enough_messages', before: conv.token_estimate, after: conv.token_estimate };
    }

    const older = windowMsgs.slice(0, windowMsgs.length - KEEP_RECENT_MESSAGES);
    const recent = windowMsgs.slice(windowMsgs.length - KEEP_RECENT_MESSAGES);

    const olderText = older.map(m => {
        const roleLabel = m.role === 'user' ? '用户' : (m.role === 'assistant' ? '助手' : m.role);
        return `${roleLabel}：${(m.content || '').substring(0, 1500)}`;
    }).join('\n');

    const prompt = `请将以下对话历史压缩为简洁的要点摘要，用于后续对话的上下文记忆。
${conv.summary ? `已有摘要（请在其基础上归并更新）：\n${conv.summary}\n\n` : ''}待压缩的对话历史：
${olderText}

要求：
1. 保留关键结论、用户的核心诉求、已确认的事实与偏好
2. 去除寒暄、重复与冗余细节
3. 用第三人称客观陈述，分点罗列，控制在 300 字以内
4. 只输出摘要正文，不要额外说明`;

    let newSummary;
    try {
        newSummary = await llmComplete(ctx, prompt, { maxTokens: 600, temperature: 0.3 });
    } catch (e) {
        return { compressed: false, reason: `摘要生成失败: ${e.message}`, before: conv.token_estimate, after: conv.token_estimate };
    }

    const maxOlderSeq = older[older.length - 1].seq;
    const summaryTokens = estimateTokens(newSummary);
    const recentTokens = recent.reduce((sum, m) => sum + (m.token_estimate || 0), 0);
    const newTokenEstimate = summaryTokens + recentTokens;
    const ts = nowISO();

    const tx = db.transaction(() => {
        // 旧消息移出工作窗口（仍保留在库中供回溯）
        db.prepare('UPDATE messages SET in_window = 0 WHERE conversation_id = ? AND seq <= ?').run(conv.id, maxOlderSeq);
        db.prepare('UPDATE conversations SET summary = ?, summary_upto = ?, token_estimate = ?, updated_at = ? WHERE id = ?')
            .run(newSummary, maxOlderSeq, newTokenEstimate, ts, conv.id);
    });
    tx();

    return { compressed: true, before: conv.token_estimate, after: newTokenEstimate, summary: newSummary };
}

/**
 * 自动压缩判断：工作窗口 token 逼近上下文窗口时触发
 */
async function maybeAutoCompress(ctx, conv) {
    const limit = getModelContextLimit(conv.model || ctx.model);
    const fresh = getDB().prepare('SELECT * FROM conversations WHERE id = ?').get(conv.id);
    if (!fresh) return { compressed: false };
    if (fresh.token_estimate + RESERVED_TOKENS >= limit * COMPRESS_RATIO) {
        return compressConversation(ctx, fresh);
    }
    return { compressed: false, reason: 'under_threshold' };
}

// ==================== 长期记忆 ====================

function listMemories(userId) {
    return getDB().prepare('SELECT id, kind, content, salience, created_at, updated_at FROM user_memories WHERE user_id = ? ORDER BY salience DESC, updated_at DESC').all(userId);
}

function deleteMemory(userId, id) {
    return getDB().prepare('DELETE FROM user_memories WHERE id = ? AND user_id = ?').run(id, userId);
}

function deleteAllMemories(userId) {
    return getDB().prepare('DELETE FROM user_memories WHERE user_id = ?').run(userId);
}

function upsertMemory(userId, { kind, content, salience, sourceConv }) {
    const db = getDB();
    const ts = nowISO();
    db.prepare(`INSERT INTO user_memories (user_id, kind, content, salience, source_conv, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(user_id, content) DO UPDATE SET
                    salience = MAX(user_memories.salience, excluded.salience),
                    kind = excluded.kind,
                    updated_at = excluded.updated_at`)
        .run(userId, kind || 'fact', content, salience ?? 1.0, sourceConv || null, ts, ts);

    // 容量上限：超出则按 salience + updated_at 淘汰最旧
    const count = db.prepare('SELECT COUNT(*) c FROM user_memories WHERE user_id = ?').get(userId).c;
    if (count > MAX_MEMORIES_PER_USER) {
        const overflow = count - MAX_MEMORIES_PER_USER;
        db.prepare(`DELETE FROM user_memories WHERE id IN (
                        SELECT id FROM user_memories WHERE user_id = ?
                        ORDER BY salience ASC, updated_at ASC LIMIT ?
                    )`).run(userId, overflow);
    }
}

/**
 * 从最近对话中抽取长期记忆并入库（对话结束后异步调用，不阻塞响应）
 * @param {Object} ctx { apiKey, providerConfig, model }
 */
async function extractAndStoreMemories(ctx, userId, convId, recentMessages) {
    const convoText = recentMessages
        .filter(m => m.role === 'user' || m.role === 'assistant')
        .map(m => `${m.role === 'user' ? '用户' : '助手'}：${(m.content || '').substring(0, 1200)}`)
        .join('\n');
    if (!convoText.trim()) return { extracted: 0 };

    const prompt = `你是一个记忆抽取器。请从以下对话中，抽取"值得长期记住"的关于【用户】的稳定信息（如：阅读偏好、语言/风格偏好、身份背景、长期关注的主题或作者）。

对话：
${convoText}

要求：
1. 只抽取关于用户本人的、跨会话仍然成立的稳定信息；不要抽取一次性的问题内容或书籍剧情
2. 每条信息独立、简洁（一句话），用第三人称陈述，如"用户偏好简洁的分点回答"
3. 最多 ${MAX_MEMORY_PER_EXTRACT} 条；若无值得记忆的信息，返回空数组
4. 严格输出 JSON 数组，每个元素为 {"kind":"preference|fact|interest","content":"...","salience":0.1~1.0}，不要输出其他文字`;

    let result;
    try {
        result = await llmComplete(ctx, prompt, { maxTokens: 500, temperature: 0.2 });
    } catch (e) {
        return { extracted: 0, error: e.message };
    }

    let items = [];
    try {
        const match = result.match(/\[[\s\S]*\]/);
        items = JSON.parse(match ? match[0] : result);
    } catch {
        return { extracted: 0, error: 'parse_failed' };
    }
    if (!Array.isArray(items)) return { extracted: 0 };

    let n = 0;
    for (const it of items.slice(0, MAX_MEMORY_PER_EXTRACT)) {
        if (!it || !it.content || typeof it.content !== 'string') continue;
        const content = it.content.trim().substring(0, 200);
        if (!content) continue;
        try {
            upsertMemory(userId, {
                kind: it.kind, content,
                salience: typeof it.salience === 'number' ? Math.max(0.1, Math.min(1, it.salience)) : 0.8,
                sourceConv: convId
            });
            n++;
        } catch {}
    }
    return { extracted: n };
}

/**
 * 检索与当前问题相关的记忆：salience + 关键词重叠打分，偏好类恒定加权
 */
function retrieveMemories(userId, query, k = 6) {
    const rows = getDB().prepare('SELECT * FROM user_memories WHERE user_id = ?').all(userId);
    if (!rows.length) return [];

    const qTokens = new Set(rag.tokenize(query || ''));
    const scored = rows.map(r => {
        const rTokens = rag.tokenize(r.content);
        let overlap = 0;
        for (const t of rTokens) if (qTokens.has(t)) overlap++;
        const rel = rTokens.length ? overlap / Math.sqrt(rTokens.length) : 0;
        const kindBoost = r.kind === 'preference' ? 0.5 : 0;
        return { ...r, _score: (r.salience || 0) * 0.4 + rel + kindBoost };
    });
    return scored.sort((a, b) => b._score - a._score).slice(0, k);
}

function formatMemoriesBlock(memories) {
    if (!memories || !memories.length) return '';
    return memories.map(m => `- ${m.content}`).join('\n');
}

module.exports = {
    // 配置/工具
    estimateTokens,
    getModelContextLimit,
    // 会话
    getOrCreateActiveConversation,
    createConversation,
    listConversations,
    getConversation,
    archiveConversation,
    deleteConversation,
    touchConversation,
    // 消息
    appendMessage,
    getConversationMessages,
    maybeSetTitle,
    buildModelMessages,
    // 压缩
    compressConversation,
    maybeAutoCompress,
    // 记忆
    listMemories,
    deleteMemory,
    deleteAllMemories,
    extractAndStoreMemories,
    retrieveMemories,
    formatMemoriesBlock
};
