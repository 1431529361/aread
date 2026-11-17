/**
 * P2 M2/M4 记忆治理确定性测试（进程内隔离临时库，不联网、不写业务原件）。
 * 覆盖 M-T02~05/07/09~20/22/23/26 与 C12/C13：来源约束、去重/冲突/顺序/人工优先、
 * 删除屏障防回写、暂停/恢复、版本冲突、作用域隔离、召回门槛与过期、原子提交聚合。
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

let root, database, conv, rs, db;
const U1 = 'u-mem-1', U2 = 'u-mem-2';
let B1, B2, C1, C2, C3;

function makeBook(userId, title) {
    const bookId = 'book-' + crypto.randomUUID().slice(0, 8);
    db.prepare(`INSERT INTO books_meta (id, user_id, title, filename, original_name, format, size, size_formatted)
                VALUES (?, ?, ?, ?, ?, 'TXT', 10, '1 KB')`).run(bookId, userId, title, bookId + '.txt', title + '.txt');
    return bookId;
}
function makeConv(userId, bookId) {
    const c = conv.createConversation(userId, bookId, null, null);
    return c.id;
}
function addRequestWithUserMessage(userId, convId, question, { origin = 'user_text' } = {}) {
    const requestId = crypto.randomUUID();
    const um = conv.appendMessage(convId, { role: 'user', content: question, requestId, status: 'completed', metadata: { origin } });
    const am = conv.appendMessage(convId, { role: 'assistant', content: '回答', requestId, status: 'completed' });
    rs.createRequest({ userId, requestId, fingerprint: 'fp-' + requestId, conversationId: convId, userMessageId: um.id, assistantMessageId: am.id });
    rs.updateRequest(userId, requestId, { status: 'completed', postProcessing: JSON.stringify({ status: 'pending', memoryChanges: [], error: null }) });
    return { requestId, messageId: um.id };
}
function processingSource(userId, messageId, requestId, convId) {
    const epoch = conv.getMemorySettings(userId).epoch;
    db.prepare("INSERT INTO memory_sources (user_id, message_id, request_id, conversation_id, expected_epoch, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'processing', datetime('now'), datetime('now'))")
        .run(userId, messageId, requestId, convId, epoch);
}
function pendingSource(userId, messageId, requestId, convId) {
    const epoch = conv.getMemorySettings(userId).epoch;
    db.prepare("INSERT INTO memory_sources (user_id, message_id, request_id, conversation_id, expected_epoch, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'pending', datetime('now'), datetime('now'))")
        .run(userId, messageId, requestId, convId, epoch);
}
function cand(messageId, question, overrides = {}) {
    return Object.assign({
        kind: 'preference', key: 'preference.answer_length', normalizedValue: 'concise',
        content: '用户偏好简洁回答', scope: 'user', sourceMessageId: messageId,
        sourceRange: { start: 0, end: question.length }, statementType: 'explicit', stability: 'stable', relation: 'independent'
    }, overrides);
}
function insMem(userId, fields) {
    const f = Object.assign({ kind: 'preference', scope: 'user', bookId: null, key: 'preference.answer_length', content: 'x', normalizedValue: 'concise', status: 'active', sourceType: 'user_message', salience: 1.0 }, fields);
    const info = db.prepare(`INSERT INTO user_memories (user_id, kind, scope, book_id, key, content, normalized_value, status, revision, source_type, salience, created_at, updated_at, last_seen_at, expires_at, order_message_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, datetime('now'), datetime('now'), datetime('now'), ?, ?)`)
        .run(userId, f.kind, f.scope, f.bookId, f.key, f.content, f.normalizedValue, f.status, f.sourceType, f.salience, f.expiresAt || null, f.orderMessageId || null);
    return Number(info.lastInsertRowid);
}
function activeRows(userId, key) {
    return db.prepare("SELECT * FROM user_memories WHERE user_id = ? AND key = ? AND status = 'active'").all(userId, key);
}
function ppOf(requestId) {
    const r = db.prepare('SELECT post_processing FROM requests WHERE request_id = ?').get(requestId);
    return r && r.post_processing ? JSON.parse(r.post_processing) : null;
}
function srcState(messageId) {
    const s = db.prepare('SELECT state, error_code FROM memory_sources WHERE message_id = ?').get(messageId);
    return s ? s.state : null;
}

before(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-mem-'));
    process.env.READER_DATA_ROOT = root;
    database = require('../database');
    conv = require('../conversation');
    rs = require('../request-store');
    db = await database.initDB();
    for (const u of [U1, U2]) db.prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)').run(u, u, 'x');
    B1 = makeBook(U1, '书A'); B2 = makeBook(U1, '书B');
    C1 = makeConv(U1, B1); C2 = makeConv(U1, B2); C3 = makeConv(U1, null);
});
after(() => {
    try { db.close(); } catch {}
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

test('M-T03/M-T09 明确稳定陈述active+原话范围；同值重述归并同ID；新明确值更新同ID', () => {
    const q1 = '我一直喜欢简洁的回答';
    const s1 = addRequestWithUserMessage(U1, C1, q1);
    processingSource(U1, s1.messageId, s1.requestId, C1);
    const r1 = conv.applyExtractionBatch(U1, { sourceMessageIds: [s1.messageId], candidates: [cand(s1.messageId, q1)] });
    assert.strictEqual(r1.memoryChanges.length, 1);
    assert.strictEqual(r1.memoryChanges[0].change, 'created');
    const id = r1.memoryChanges[0].id;
    const row = db.prepare('SELECT * FROM user_memories WHERE id = ?').get(id);
    assert.strictEqual(row.status, 'active');
    assert.strictEqual(row.source_message_id, s1.messageId);
    assert.deepStrictEqual([row.source_start, row.source_end], [0, q1.length]);
    assert.strictEqual(srcState(s1.messageId), 'done');
    assert.strictEqual(ppOf(s1.requestId).status, 'completed');

    // 同义重述（同规范值）→ 同ID，不新增
    const q2 = '我偏好简短回答';
    const s2 = addRequestWithUserMessage(U1, C1, q2);
    processingSource(U1, s2.messageId, s2.requestId, C1);
    const r2 = conv.applyExtractionBatch(U1, { sourceMessageIds: [s2.messageId], candidates: [cand(s2.messageId, q2, { content: '用户喜欢简短的回答' })] });
    assert.strictEqual(r2.memoryChanges.length, 0);
    assert.strictEqual(activeRows(U1, 'preference.answer_length').length, 1);
    assert.strictEqual(db.prepare('SELECT order_message_id FROM user_memories WHERE id = ?').get(id).order_message_id, s2.messageId);

    // 新明确值 → 更新同ID revision+1
    const q3 = '我以后都喜欢详细的回答';
    const s3 = addRequestWithUserMessage(U1, C1, q3);
    processingSource(U1, s3.messageId, s3.requestId, C1);
    const r3 = conv.applyExtractionBatch(U1, { sourceMessageIds: [s3.messageId], candidates: [cand(s3.messageId, q3, { normalizedValue: 'detailed', content: '用户偏好详细回答' })] });
    assert.strictEqual(r3.memoryChanges[0].id, id);
    assert.strictEqual(r3.memoryChanges[0].change, 'updated');
    assert.strictEqual(db.prepare('SELECT revision FROM user_memories WHERE id = ?').get(id).revision, 2);
});

test('M-T10 旧来源较晚返回被order拒绝；旧epoch批次被拒绝', () => {
    const key = 'preference.answer_format';
    // 先创建较旧消息，再创建较新消息；新消息先完成抽取
    const qOld = '我喜欢段落回答';
    const sOld = addRequestWithUserMessage(U1, C1, qOld);
    const qNew = '我一直喜欢分点回答';
    const sNew = addRequestWithUserMessage(U1, C1, qNew);
    processingSource(U1, sNew.messageId, sNew.requestId, C1);
    conv.applyExtractionBatch(U1, { sourceMessageIds: [sNew.messageId], candidates: [cand(sNew.messageId, qNew, { key, normalizedValue: 'bullets', content: '用户偏好分点回答' })] });
    const id = activeRows(U1, key)[0].id;

    // 更旧的消息较晚完成抽取 → 拒绝
    processingSource(U1, sOld.messageId, sOld.requestId, C1);
    const r = conv.applyExtractionBatch(U1, { sourceMessageIds: [sOld.messageId], candidates: [cand(sOld.messageId, qOld, { key, normalizedValue: 'paragraphs', content: '用户偏好段落回答' })] });
    assert.strictEqual(r.memoryChanges.length, 0);
    assert.strictEqual(db.prepare('SELECT normalized_value FROM user_memories WHERE id = ?').get(id).normalized_value, 'bullets');

    // 旧 epoch：手动编辑后 epoch 递增，旧批次 skipped
    const q3 = '这次讨论用段落';
    const s3 = addRequestWithUserMessage(U1, C1, q3);
    processingSource(U1, s3.messageId, s3.requestId, C1);
    conv.editMemory(U1, id, { expectedRevision: 1, content: '用户偏好分点回答（人工）' });
    const r2 = conv.applyExtractionBatch(U1, { sourceMessageIds: [s3.messageId], candidates: [cand(s3.messageId, q3, { key, normalizedValue: 'steps', content: '用户偏好步骤回答' })] });
    assert.strictEqual(r2.memoryChanges.length, 0);
    assert.strictEqual(srcState(s3.messageId), 'skipped');
    assert.strictEqual(db.prepare('SELECT normalized_value FROM user_memories WHERE id = ?').get(id).normalized_value, 'bullets');
});

test('M-T11/M-T15 人工编辑保护：自动推断只能候选；旧revision编辑409', () => {
    const key = 'preference.language';
    const id = insMem(U1, { key, content: '用户偏好中文回答', normalizedValue: 'zh', sourceType: 'user_edit' });
    const q = '我可能更喜欢英文回答';
    const s = addRequestWithUserMessage(U1, C1, q);
    processingSource(U1, s.messageId, s.requestId, C1);
    const r = conv.applyExtractionBatch(U1, { sourceMessageIds: [s.messageId], candidates: [cand(s.messageId, q, { key, normalizedValue: 'en', content: '用户可能偏好英文回答', statementType: 'inferred', stability: 'unknown' })] });
    assert.strictEqual(r.memoryChanges[0].change, 'candidate');
    assert.strictEqual(db.prepare('SELECT normalized_value FROM user_memories WHERE id = ?').get(id).normalized_value, 'zh');
    // 明确新值也不能覆盖人工值 → 候选
    const q2 = '我以后都用英文回答';
    const s2 = addRequestWithUserMessage(U1, C1, q2);
    processingSource(U1, s2.messageId, s2.requestId, C1);
    const r2 = conv.applyExtractionBatch(U1, { sourceMessageIds: [s2.messageId], candidates: [cand(s2.messageId, q2, { key, normalizedValue: 'en', content: '用户偏好英文回答' })] });
    assert.strictEqual(r2.memoryChanges.length, 0, '同值候选去重刷新，不新增');
    assert.strictEqual(db.prepare("SELECT COUNT(*) c FROM user_memories WHERE user_id = ? AND key = ? AND status = 'candidate'").get(U1, key).c, 1);
    assert.strictEqual(db.prepare('SELECT normalized_value FROM user_memories WHERE id = ?').get(id).normalized_value, 'zh');
    // 旧 revision 编辑 → 409
    assert.throws(() => conv.editMemory(U1, id, { expectedRevision: 99, content: '用户偏好中文回答' }), (e) => e.status === 409 && e.code === 'MEMORY_CONFLICT');
    // 人工编辑使同键旧候选失效
    conv.editMemory(U1, id, { expectedRevision: 1, content: '用户偏好中文回答（人工）' });
    const candRow = db.prepare("SELECT id, revision, status FROM user_memories WHERE user_id = ? AND key = ? AND status = 'superseded'").get(U1, key);
    assert.ok(candRow, '同键候选应被作废旧候选');
});

test('M-T05 推断候选不覆盖active；确认候选替换active并作废旧候选', () => {
    const key = 'preference.example_style';
    const id = insMem(U1, { key, content: '用户喜欢简短例子', normalizedValue: '简短例子' });
    const q = '我可能偏爱图示';
    const s = addRequestWithUserMessage(U1, C1, q);
    processingSource(U1, s.messageId, s.requestId, C1);
    const r = conv.applyExtractionBatch(U1, { sourceMessageIds: [s.messageId], candidates: [cand(s.messageId, q, { key, normalizedValue: '图示', content: '用户可能偏爱图示例子', statementType: 'inferred', stability: 'unknown' })] });
    const candId = r.memoryChanges[0].id;
    assert.strictEqual(db.prepare('SELECT status FROM user_memories WHERE id = ?').get(candId).status, 'candidate');
    assert.strictEqual(db.prepare('SELECT content FROM user_memories WHERE id = ?').get(id).content, '用户喜欢简短例子');
    const epoch = conv.getMemorySettings(U1).epoch;
    const cr = db.prepare('SELECT revision FROM user_memories WHERE id = ?').get(candId).revision;
    const res = conv.confirmMemory(U1, candId, { expectedRevision: cr, expectedEpoch: epoch });
    assert.strictEqual(res.memory.status, 'active');
    assert.strictEqual(res.memory.source.type, 'user_confirmation');
    assert.strictEqual(db.prepare('SELECT status FROM user_memories WHERE id = ?').get(id).status, 'superseded');
    assert.ok(res.memoryChanges.some(c => c.id === id && c.change === 'updated'));
    // 旧候选重复确认 → 409
    assert.throws(() => conv.confirmMemory(U1, candId, { expectedRevision: cr, expectedEpoch: conv.getMemorySettings(U1).epoch }), (e) => e.status === 409);
});

test('M-T04/M-T06/M-T07 一次性要求不持久化；纯提问无能力标签；路由分流', () => {
    assert.strictEqual(conv.classifyQuestion('这次请只用法语回答我这个问题：你好吗？'), 'skip');
    assert.strictEqual(conv.classifyQuestion('不要记住这个要求'), 'skip');
    assert.strictEqual(conv.classifyQuestion('什么是隐喻？'), 'skip');
    assert.strictEqual(conv.classifyQuestion('今天天气怎么样？'), 'skip');
    assert.strictEqual(conv.classifyQuestion('请记住我喜欢分点'), 'explicit');
    assert.strictEqual(conv.classifyQuestion('更正一下：我喜欢简短回答'), 'explicit');
    assert.strictEqual(conv.classifyQuestion('忘记我的偏好'), 'explicit');
    assert.strictEqual(conv.classifyQuestion('我一直喜欢分点回答'), 'strong');
    assert.strictEqual(conv.classifyQuestion('我在读这本书，想写报告'), 'weak');
    // one_turn 候选被跳过
    const q = '这次详细点';
    const s = addRequestWithUserMessage(U1, C1, q);
    processingSource(U1, s.messageId, s.requestId, C1);
    const v = conv.validateCandidate(cand(s.messageId, q, { stability: 'one_turn' }), new Map([[s.messageId, { question: q, bookId: B1 }]]));
    assert.strictEqual(v.skip, 'one_turn');
    // 本轮覆盖检测
    const ov = conv.detectTurnOverride('这次请详细讲，用法语回答');
    assert.ok(ov.some(o => o.key === 'preference.answer_length' && o.value === 'detailed'));
    assert.ok(ov.some(o => o.key === 'preference.language' && o.value === 'fr'));
});

test('M-T02/M-T20 来源结构约束：助手/选文消息不可作来源；非法kind/键/越权范围/敏感被拒', () => {
    const q = '解释';
    const s = addRequestWithUserMessage(U1, C1, q, { origin: 'user_text' });
    // 助手消息ID
    const asst = db.prepare("SELECT id FROM messages WHERE conversation_id = ? AND role = 'assistant' ORDER BY id DESC LIMIT 1").get(C1);
    const sm = new Map([[s.messageId, { question: q, bookId: B1 }]]);
    assert.strictEqual(conv.validateCandidate(cand(asst.id, q), sm).invalid, 'source_id');
    // origin=selection 的消息即使ID在批次内也被事务拒绝
    const sSel = addRequestWithUserMessage(U1, C1, '翻译这段', { origin: 'selection' });
    processingSource(U1, sSel.messageId, sSel.requestId, C1);
    const r = conv.applyExtractionBatch(U1, { sourceMessageIds: [sSel.messageId], candidates: [cand(sSel.messageId, '翻译这段')] });
    assert.strictEqual(r.memoryChanges.length, 0);
    assert.strictEqual(srcState(sSel.messageId), 'skipped');
    // 非法 kind / 键 / 范围
    assert.strictEqual(conv.validateCandidate(cand(s.messageId, q, { kind: 'admin' }), sm).invalid, 'kind');
    assert.strictEqual(conv.validateCandidate(cand(s.messageId, q, { key: 'preference.answer_length; DROP TABLE' }), sm).invalid, 'key');
    assert.strictEqual(conv.validateCandidate(cand(s.messageId, q, { sourceRange: { start: 0, end: 999 } }), sm).invalid, 'source_range');
    assert.strictEqual(conv.validateCandidate(cand(s.messageId, q, { normalizedValue: '超长的枚举' }), sm).invalid, 'enum_value');
    assert.strictEqual(conv.validateCandidate(cand(s.messageId, q, { content: '用户的 API key 是 sk-abcdefgh12345678' }), sm).skip, 'sensitive');
    // 书级目标不能 user 范围
    assert.strictEqual(conv.validateCandidate(cand(s.messageId, q, { kind: 'reading_goal', key: 'reading_goal.primary', scope: 'user' }), sm).invalid, 'goal_scope');
});

test('M-T07/M-T22 书级作用域隔离：同正文两书各自保存；切书不串目标', async () => {
    db.prepare('DELETE FROM user_memories WHERE user_id = ?').run(U1);
    const qA = '我读这本书为了写报告';
    const sA = addRequestWithUserMessage(U1, C1, qA);
    processingSource(U1, sA.messageId, sA.requestId, C1);
    const rA = conv.applyExtractionBatch(U1, { sourceMessageIds: [sA.messageId], candidates: [cand(sA.messageId, qA, { kind: 'reading_goal', key: 'reading_goal.primary', scope: 'book', normalizedValue: '写报告', content: '用户读本书为了写报告' })] });
    assert.strictEqual(rA.memoryChanges[0].change, 'created');
    const qB = '我读这本书为了写报告';
    const sB = addRequestWithUserMessage(U1, C2, qB);
    processingSource(U1, sB.messageId, sB.requestId, C2);
    const rB = conv.applyExtractionBatch(U1, { sourceMessageIds: [sB.messageId], candidates: [cand(sB.messageId, qB, { kind: 'reading_goal', key: 'reading_goal.primary', scope: 'book', normalizedValue: '写报告', content: '用户读本书为了写报告' })] });
    assert.strictEqual(rB.memoryChanges[0].change, 'created');
    assert.notStrictEqual(rA.memoryChanges[0].id, rB.memoryChanges[0].id);
    // 召回：B书不注入A书目标；用户级偏好共享
    insMem(U1, { key: 'preference.answer_format', content: '用户偏好分点回答', normalizedValue: 'bullets' });
    const bundleB = await conv.retrieveMemoryBundle({ userId: U1, bookId: B2, question: '这本书讲了什么' });
    assert.ok(bundleB.items.some(i => i.reason === 'current_book' && i.memory.bookId === B2));
    assert.ok(!bundleB.items.some(i => i.memory.bookId === B1));
    assert.ok(bundleB.items.some(i => i.reason === 'global_preference'));
    const bundleA = await conv.retrieveMemoryBundle({ userId: U1, bookId: B1, question: '这本书讲了什么' });
    assert.ok(bundleA.items.some(i => i.memory.bookId === B1 && i.reason === 'current_book'));
    // 跨用户隔离
    const bundleU2 = await conv.retrieveMemoryBundle({ userId: U2, bookId: B1, question: '这本书讲了什么' });
    assert.strictEqual(bundleU2.items.length, 0);
});

test('M-T08/M-T26 open_question建立不因回答自动完成；普通提及不重开；明确重开同ID续期', () => {
    const q = '我还没理解时间跳跃，希望以后接着讨论';
    const s = addRequestWithUserMessage(U1, C1, q);
    processingSource(U1, s.messageId, s.requestId, C1);
    const r = conv.applyExtractionBatch(U1, { sourceMessageIds: [s.messageId], candidates: [cand(s.messageId, q, { kind: 'open_question', key: 'open_question:time-jump', scope: 'book', normalizedValue: '时间跳跃', content: '用户尚未理解本书时间跳跃手法，希望继续讨论' })] });
    const id = r.memoryChanges[0].id;
    let row = db.prepare('SELECT * FROM user_memories WHERE id = ?').get(id);
    assert.strictEqual(row.status, 'active');
    assert.ok(row.expires_at, 'open_question 应有90天有效期');
    // 完成
    conv.completeMemory(U1, id, { expectedRevision: row.revision });
    assert.strictEqual(db.prepare('SELECT status FROM user_memories WHERE id = ?').get(id).status, 'completed');
    // 普通提及不重开
    const q2 = '时间跳跃是什么意思';
    const s2 = addRequestWithUserMessage(U1, C1, q2);
    processingSource(U1, s2.messageId, s2.requestId, C1);
    const r2 = conv.applyExtractionBatch(U1, { sourceMessageIds: [s2.messageId], candidates: [cand(s2.messageId, q2, { kind: 'open_question', key: 'open_question:time-jump', scope: 'book', normalizedValue: '时间跳跃', content: '用户尚未理解时间跳跃', reopen: false })] });
    assert.strictEqual(r2.memoryChanges.length, 0);
    assert.strictEqual(db.prepare('SELECT status FROM user_memories WHERE id = ?').get(id).status, 'completed');
    // 明确重开 → 同ID active revision+1 新有效期
    const q3 = '时间跳跃我还是没懂，继续讨论';
    const s3 = addRequestWithUserMessage(U1, C1, q3);
    processingSource(U1, s3.messageId, s3.requestId, C1);
    const oldExpires = db.prepare('SELECT expires_at FROM user_memories WHERE id = ?').get(id).expires_at;
    const r3 = conv.applyExtractionBatch(U1, { sourceMessageIds: [s3.messageId], candidates: [cand(s3.messageId, q3, { kind: 'open_question', key: 'open_question:time-jump', scope: 'book', normalizedValue: '时间跳跃', content: '用户仍未理解时间跳跃', reopen: true })] });
    assert.strictEqual(r3.memoryChanges[0].id, id);
    row = db.prepare('SELECT * FROM user_memories WHERE id = ?').get(id);
    assert.strictEqual(row.status, 'active');
    assert.ok(row.expires_at >= oldExpires);
    // 非 goal/question 不可完成
    const prefId = activeRows(U1, 'preference.answer_format')[0].id;
    assert.throws(() => conv.completeMemory(U1, prefId, { expectedRevision: 1 }), (e) => e.status === 400);
});

test('M-T12/M-T13/M-T17 删除屏障：在途/未调度旧来源全部防回写；清空后候选确认404；新表达可再存', () => {
    db.prepare('DELETE FROM user_memories WHERE user_id = ?').run(U1);
    const key = 'preference.example_style';
    const id = insMem(U1, { key, content: '用户喜欢表格对比', normalizedValue: '表格对比' });
    // 在途 processing + 跨会话未调度 pending
    const q1 = '我喜欢表格';
    const s1 = addRequestWithUserMessage(U1, C1, q1);
    processingSource(U1, s1.messageId, s1.requestId, C1);
    const q2 = '我也喜欢表格';
    const s2 = addRequestWithUserMessage(U1, C2, q2);
    pendingSource(U1, s2.messageId, s2.requestId, C2);
    const del = conv.deleteMemory(U1, id, { expectedRevision: 1 });
    assert.strictEqual(del.deleted, true);
    assert.strictEqual(srcState(s1.messageId), 'skipped');
    assert.strictEqual(srcState(s2.messageId), 'skipped');
    assert.strictEqual(ppOf(s1.requestId).status, 'skipped');
    assert.deepStrictEqual(ppOf(s1.requestId).memoryChanges, []);
    // 在途模型响应回来 → 不能回写
    const r = conv.applyExtractionBatch(U1, { sourceMessageIds: [s1.messageId], candidates: [cand(s1.messageId, q1, { key, normalizedValue: '表格对比', content: '用户喜欢表格对比' })] });
    assert.strictEqual(r.memoryChanges.length, 0);
    assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM user_memories WHERE user_id = ? AND key = ?').get(U1, key).c, 0);
    // 新消息越过屏障可再存
    const q3 = '请记住我喜欢表格对比人物';
    const s3 = addRequestWithUserMessage(U1, C1, q3);
    processingSource(U1, s3.messageId, s3.requestId, C1);
    const r3 = conv.applyExtractionBatch(U1, { sourceMessageIds: [s3.messageId], candidates: [cand(s3.messageId, q3, { key, normalizedValue: '表格对比', content: '用户喜欢表格对比人物' })] });
    assert.strictEqual(r3.memoryChanges[0].change, 'created');
    assert.ok(r3.memoryChanges[0].id > id);
    // 清空后旧候选确认 → 404
    const candId = insMem(U1, { key: 'fact.role', content: '候选', normalizedValue: '候选', status: 'candidate' });
    const epoch = conv.getMemorySettings(U1).epoch;
    conv.clearMemories(U1, { expectedEpoch: epoch });
    assert.throws(() => conv.confirmMemory(U1, candId, { expectedRevision: 1, expectedEpoch: conv.getMemorySettings(U1).epoch }), (e) => e.status === 404);
    assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM user_memories WHERE user_id = ?').get(U1).c, 0);
});

test('M-T14 暂停不写不召回；恢复不回扫；之后新表达可处理', async () => {
    const epoch0 = conv.getMemorySettings(U1).epoch;
    conv.setMemoryEnabled(U1, { enabled: false, expectedEpoch: epoch0 });
    const q = '我喜欢诗歌';
    const s = addRequestWithUserMessage(U1, C1, q);
    const scheduled = conv.scheduleMemoryProcessing({ userId: U1, requestId: s.requestId, conversationId: C1, bookId: B1, userMessageId: s.messageId, question: q, ctxLLM: {} });
    assert.strictEqual(scheduled, false, '暂停期弱信号不调度');
    const bundle = await conv.retrieveMemoryBundle({ userId: U1, bookId: B1, question: '我喜欢什么' });
    assert.strictEqual(bundle.enabled, false);
    assert.strictEqual(bundle.items.length, 0);
    // 恢复：屏障推进，暂停期消息不补抽
    const epoch1 = conv.getMemorySettings(U1).epoch;
    conv.setMemoryEnabled(U1, { enabled: true, expectedEpoch: epoch1 });
    const st = db.prepare('SELECT blocked_through_message_id b FROM memory_user_state WHERE user_id = ?').get(U1);
    assert.ok(st.b >= s.messageId);
    processingSource(U1, s.messageId, s.requestId, C1); // 模拟暂停期遗留来源
    const r = conv.applyExtractionBatch(U1, { sourceMessageIds: [s.messageId], candidates: [cand(s.messageId, q, { kind: 'interest', key: 'interest.topic:poetry', normalizedValue: '诗歌', content: '用户喜欢诗歌' })] });
    assert.strictEqual(r.memoryChanges.length, 0);
    // 恢复后新表达可处理
    const q2 = '请记住我喜欢诗歌';
    const s2 = addRequestWithUserMessage(U1, C1, q2);
    processingSource(U1, s2.messageId, s2.requestId, C1);
    const r2 = conv.applyExtractionBatch(U1, { sourceMessageIds: [s2.messageId], candidates: [cand(s2.messageId, q2, { kind: 'interest', key: 'interest.topic:poetry', normalizedValue: '诗歌', content: '用户喜欢诗歌' })] });
    assert.strictEqual(r2.memoryChanges[0].change, 'created');
});

test('M-T14b 暂停期显式记住走候选确认路径：不自动active，确认后生效且仍暂停', async () => {
    const epoch0 = conv.getMemorySettings(U1).epoch;
    conv.setMemoryEnabled(U1, { enabled: false, expectedEpoch: epoch0 });
    // mA：仅断言调度路由（dummy ctx 使异步抽取失败，不产生写入）
    const qA = '请记住我喜欢戏剧';
    const sA = addRequestWithUserMessage(U1, C1, qA);
    const scheduled = conv.scheduleMemoryProcessing({ userId: U1, requestId: sA.requestId, conversationId: C1, bookId: B1, userMessageId: sA.messageId, question: qA, ctxLLM: {} });
    assert.strictEqual(scheduled, true, '暂停期显式命令应给确认路径');
    await new Promise(r => setTimeout(r, 600));
    assert.strictEqual(db.prepare("SELECT COUNT(*) c FROM user_memories WHERE user_id = ? AND key = 'interest.topic:drama' AND status = 'active'").get(U1).c, 0);
    // mB：手动模拟提交（不经异步队列）：forceCandidate → 候选
    const qB = '请记住我喜欢戏剧';
    const sB = addRequestWithUserMessage(U1, C1, qB);
    pendingSource(U1, sB.messageId, sB.requestId, C1);
    db.prepare("UPDATE memory_sources SET state = 'processing' WHERE user_id = ? AND message_id = ?").run(U1, sB.messageId);
    const r = conv.applyExtractionBatch(U1, { sourceMessageIds: [sB.messageId], candidates: [cand(sB.messageId, qB, { kind: 'interest', key: 'interest.topic:drama', normalizedValue: '戏剧', content: '用户喜欢戏剧' })], forceCandidateIds: [sB.messageId] });
    assert.strictEqual(r.memoryChanges[0].change, 'candidate');
    const candId = r.memoryChanges[0].id;
    assert.strictEqual(db.prepare('SELECT status FROM user_memories WHERE id = ?').get(candId).status, 'candidate');
    // 暂停期间管理确认仍可执行
    const epoch1 = conv.getMemorySettings(U1).epoch;
    const cr = db.prepare('SELECT revision FROM user_memories WHERE id = ?').get(candId).revision;
    const res = conv.confirmMemory(U1, candId, { expectedRevision: cr, expectedEpoch: epoch1 });
    assert.strictEqual(res.memory.status, 'active');
    assert.strictEqual(conv.getMemorySettings(U1).enabled, false, '确认不重新开启自动记忆');
    conv.setMemoryEnabled(U1, { enabled: true, expectedEpoch: conv.getMemorySettings(U1).epoch });
});

test('M-T16 删除来源会话：先屏障；已有记忆保留但来源不可用', () => {
    const q = '请记住我是中文系学生';
    const s = addRequestWithUserMessage(U1, C3, q);
    processingSource(U1, s.messageId, s.requestId, C3);
    const r = conv.applyExtractionBatch(U1, { sourceMessageIds: [s.messageId], candidates: [cand(s.messageId, q, { kind: 'fact', key: 'fact.role', normalizedValue: '中文系学生', content: '用户是中文系学生' })] });
    const id = r.memoryChanges[0].id;
    const epochBefore = conv.getMemorySettings(U1).epoch;
    conv.onConversationDeleted(U1, C3);
    assert.ok(conv.getMemorySettings(U1).epoch > epochBefore);
    conv.deleteConversation(U1, C3);
    const row = db.prepare('SELECT * FROM user_memories WHERE id = ?').get(id);
    assert.ok(row, '已保存记忆不因删会话消失');
    assert.strictEqual(conv.getMessageById(s.messageId), null, '源消息已删');
    assert.strictEqual(db.prepare('SELECT state FROM memory_sources WHERE message_id = ?').get(s.messageId).state, 'done', '来源处理记录不级联删除');
});

test('M-T18/M-T19 召回门槛与生命周期：无关高salience不注入；过期/完成/删书不召回', async () => {
    insMem(U1, { kind: 'interest', key: 'interest.topic:cooking', content: '用户长期关注川菜烹饪技巧', normalizedValue: '川菜烹饪', salience: 1.0 });
    insMem(U1, { key: 'preference.answer_length', content: '用户偏好简洁回答', normalizedValue: 'concise' });
    const bundle = await conv.retrieveMemoryBundle({ userId: U1, bookId: B1, question: '马孔多在哪里' });
    assert.ok(!bundle.items.some(i => i.memory.key === 'interest.topic:cooking'), '无关兴趣不应注入');
    assert.ok(bundle.items.some(i => i.reason === 'global_preference'), '风格偏好按适用性注入');
    // 相关主题可注入（词法重叠）
    const bundle2 = await conv.retrieveMemoryBundle({ userId: U1, bookId: B1, question: '川菜烹饪技巧有哪些' });
    assert.ok(bundle2.items.some(i => i.memory.key === 'interest.topic:cooking' && i.reason === 'relevant_topic'));
    // 过期候选/完成目标/删书expired不召回
    const expiredCand = insMem(U1, { kind: 'interest', key: 'interest.topic:old', content: '用户关注旧主题', normalizedValue: '旧主题', status: 'candidate', expiresAt: '2000-01-01T00:00:00.000Z' });
    conv.maintainExpiry(U1);
    assert.strictEqual(db.prepare('SELECT status FROM user_memories WHERE id = ?').get(expiredCand).status, 'expired');
    const goalId = insMem(U1, { kind: 'reading_goal', key: 'reading_goal.primary', scope: 'book', bookId: B1, content: '用户读本书为了考试', normalizedValue: '考试', status: 'completed' });
    const bundle3 = await conv.retrieveMemoryBundle({ userId: U1, bookId: B1, question: '考试重点' });
    assert.ok(!bundle3.items.some(i => i.memory.id === goalId));
    // 删书 → expired，管理页可见，召回不用
    const delBookId = makeBook(U1, '将删书');
    const delGoal = insMem(U1, { kind: 'reading_goal', key: 'reading_goal.primary', scope: 'book', bookId: delBookId, content: '用户读将删书为了休闲', normalizedValue: '休闲' });
    conv.onBookDeleted(U1, delBookId);
    assert.strictEqual(db.prepare('SELECT status FROM user_memories WHERE id = ?').get(delGoal).status, 'expired');
    const list = conv.listMemoriesView(U1, { bookId: delBookId });
    assert.ok(list.some(m => m.id === delGoal && m.status === 'expired'));
    const bundle4 = await conv.retrieveMemoryBundle({ userId: U1, bookId: delBookId, question: '休闲' });
    assert.ok(!bundle4.items.some(i => i.memory.id === delGoal));
});

test('M-T20b 数字字符串ID/偏移结构coercion后仍校验归属与范围', () => {
    const q = '请记住我喜欢分点';
    const s = addRequestWithUserMessage(U1, C1, q);
    const sm = new Map([[s.messageId, { question: q, bookId: B1 }]]);
    const ok = conv.validateCandidate(cand(s.messageId, q, { sourceMessageId: String(s.messageId), sourceRange: { start: '0', end: String(q.length) } }), sm);
    assert.ok(ok.candidate, '数字字符串应coercion后通过');
    assert.strictEqual(ok.candidate.sourceMessageId, s.messageId);
    const bad = conv.validateCandidate(cand(s.messageId, q, { sourceMessageId: '999999' }), sm);
    assert.strictEqual(bad.invalid, 'source_id', '越权ID仍拒绝');
    const badRange = conv.validateCandidate(cand(s.messageId, q, { sourceRange: { start: '0', end: '999' } }), sm);
    assert.strictEqual(badRange.invalid, 'source_range');
    const arr = conv.validateCandidate(cand(s.messageId, q, { sourceRange: [0, q.length] }), sm);
    assert.ok(arr.candidate, '数组形式偏移应coercion后通过');
    const badKind = conv.validateCandidate(cand(s.messageId, q, { kind: 'memory' }), sm);
    assert.strictEqual(badKind.invalid, 'kind', '非法kind仍拒绝');
});

test('M-T23 来源与请求postProcessing同步：纯跳过[]、失败failed、不永久pending', () => {
    // 纯跳过（屏障）→ skipped []
    const q = '我喜欢散文';
    const s = addRequestWithUserMessage(U1, C1, q);
    pendingSource(U1, s.messageId, s.requestId, C1);
    const epoch = conv.getMemorySettings(U1).epoch;
    conv.setMemoryEnabled(U1, { enabled: false, expectedEpoch: epoch });
    conv.setMemoryEnabled(U1, { enabled: true, expectedEpoch: conv.getMemorySettings(U1).epoch });
    assert.strictEqual(srcState(s.messageId), 'skipped');
    const pp = ppOf(s.requestId);
    assert.strictEqual(pp.status, 'skipped');
    assert.deepStrictEqual(pp.memoryChanges, []);
    // 失败来源 → failed + error
    const q2 = '我喜欢小说';
    const s2 = addRequestWithUserMessage(U1, C1, q2);
    processingSource(U1, s2.messageId, s2.requestId, C1);
    db.prepare("UPDATE memory_sources SET state = 'failed', error_code = 'MEMORY_EXTRACT_PARSE' WHERE message_id = ?").run(s2.messageId);
    // 通过聚合入口：再触发一次屏障只影响pending；这里直接验证重启恢复聚合
    db.prepare("UPDATE requests SET post_processing = ? WHERE request_id = ?").run(JSON.stringify({ status: 'pending', memoryChanges: [], error: null }), s2.requestId);
    conv.recoverStaleMemorySources();
    const pp2 = ppOf(s2.requestId);
    assert.strictEqual(pp2.status, 'failed');
    assert.ok(pp2.error && pp2.error.code === 'MEMORY_EXTRACT_PARSE');
    // 已终结回执不被重写
    const before = JSON.stringify(pp2);
    conv.recoverStaleMemorySources();
    assert.strictEqual(JSON.stringify(ppOf(s2.requestId)), before);
});

test('M-T23b 重启遗留pending来源保守skipped并聚合，不留永久pending', () => {
    const q = '我喜欢散文';
    const s = addRequestWithUserMessage(U1, C1, q);
    pendingSource(U1, s.messageId, s.requestId, C1);
    conv.recoverStaleMemorySources();
    assert.strictEqual(srcState(s.messageId), 'skipped');
    const pp = ppOf(s.requestId);
    assert.strictEqual(pp.status, 'skipped');
    assert.deepStrictEqual(pp.memoryChanges, []);
});

test('M-T24/M-T25 MemoryView结构与legacy确认分类', () => {
    const id = insMem(U1, { kind: 'fact', key: 'legacy:999', content: '旧记忆正文', normalizedValue: null, status: 'candidate', sourceType: 'legacy' });
    const view = conv.listMemoriesView(U1).find(m => m.id === id);
    assert.strictEqual(view.source.type, 'legacy');
    assert.strictEqual(view.source.messageId, null);
    assert.strictEqual(view.source.range, null);
    assert.ok(!('normalized_value' in view) && !('normalizedValue' in view), '内部字段不暴露');
    const epoch = conv.getMemorySettings(U1).epoch;
    // 缺分类 → 400
    assert.throws(() => conv.confirmMemory(U1, id, { expectedRevision: 1, expectedEpoch: epoch }), (e) => e.status === 400);
    // 非法分类（枚举键与正文不符）→ 400
    assert.throws(() => conv.confirmMemory(U1, id, { expectedRevision: 1, expectedEpoch: epoch, classification: { kind: 'preference', key: 'preference.answer_length', scope: 'user' } }), (e) => e.status === 400);
    const res = conv.confirmMemory(U1, id, { expectedRevision: 1, expectedEpoch: conv.getMemorySettings(U1).epoch, classification: { kind: 'fact', key: 'fact.role', scope: 'user', bookId: null } });
    assert.strictEqual(res.memory.kind, 'fact');
    assert.strictEqual(res.memory.key, 'fact.role');
    assert.strictEqual(res.memory.status, 'active');
    assert.strictEqual(res.memory.source.type, 'user_confirmation');
    assert.strictEqual(res.memory.source.messageId, null);
});