/**
 * 统一问答服务（P1a A1/A2/A3，SC-1.1 §4/§5/§10/§11）
 * 唯一完成责任：校验→幂等→短事务建请求/消息→start→决策/工具/任务→门控→
 *   短事务提交助手正文+状态+后处理→end→异步一次记忆抽取。
 * 内层 Agent/工具/编排器不发终态。取消/失败保留部分正文并标状态，不触发抽取。
 */
const crypto = require('crypto');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOTAL_BUDGET_MS = 120000;
const OUTPUT_RESERVE_TOKENS = 2500;

function createQaService(deps) {
    const { conv, rs, llmClient, agent, rag, orchestrator, getProviderConfig, resolveApiKey, getBookContent } = deps;
    const busyConversations = new Set();

    function estimateMessagesTokens(messages) {
        return messages.reduce((s, m) => s + conv.estimateTokens(typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '')), 0);
    }

    function makeSse(res, requestId) {
        let seq = 0;
        return (type, data) => {
            seq++;
            if (res.writableEnded) return;
            res.write(`data: ${JSON.stringify({ type, requestId, seq, data })}\n\n`);
        };
    }

    function jsonError(res, status, code, message, requestId = null) {
        return res.status(status).json({ error: { code, message, retryable: false }, requestId });
    }

    function assignEvidence(candidates, selection, bookId) {
        const evidence = [];
        const seen = new Set();
        let n = 0;
        const push = (kind, c) => {
            const key = `${kind}|${c.bookId || ''}|${c.locator ? c.locator.start + ':' + c.locator.end : c.text}`;
            if (seen.has(key)) return;
            seen.add(key);
            n++;
            evidence.push({
                evidenceId: `E${n}`, kind,
                bookId: c.bookId || bookId || null,
                chapter: c.chapter || null,
                text: c.text,
                locator: c.locator || null,
                verified: false, // P1a 无精确定位，P1b 补 locator 后才可 verified
                method: c.method || (kind === 'user_selection' ? 'selection' : 'bm25')
            });
        };
        if (selection && selection.text) push('user_selection', { bookId, text: selection.text, method: 'selection', chapter: null });
        for (const c of candidates || []) push('book_excerpt', c);
        return evidence;
    }

    function buildSystemPrompt(model, bookName, requirement) {
        const evidenceRule = requirement === 'book'
            ? '涉及本书事实的问题必须基于工具检索到的原文证据回答；没有证据时明确说明"现有证据不足"，不要用你对名著的印象冒充原文依据。'
            : '可基于用户选中的文本或你的知识回答；涉及选文之外的本书事实时，调用工具检索原文。';
        return `你是一个专业的阅读助手。当前模型：${model}。${bookName ? `当前书籍：《${bookName}》。` : ''}
原则：
1. ${evidenceRule}
2. 解释/翻译/改写用户选中文本时直接回答，无需检索。
3. 需要查阅书中其他部分时调用工具（searchInBook/getChapterInfo/lookupCharacter）。
4. 回答条理清晰；区分原文依据与补充知识。
5. 书中没有的信息如实说明，不虚构。
6. 用户询问模型信息时如实告知：${model}。`;
    }

    async function handleAsk(req, res) {
        const userId = req.user.id;
        const body = req.body || {};
        const requestId = body.requestId;
        const question = body.question;
        const selection = body.selection && body.selection.text ? { text: String(body.selection.text), locator: body.selection.locator || null } : null;
        const action = body.action || 'ask';
        const bookId = body.bookId || null;
        const conversationId = body.conversationId || null;
        const taskType = body.taskType || null;

        // ---- 校验（先于 SSE，JSON 错误） ----
        if (!requestId || !UUID_RE.test(requestId)) return jsonError(res, 400, 'INVALID_REQUEST', 'requestId 必须为 UUID');
        if (!question || typeof question !== 'string' || !question.trim()) return jsonError(res, 400, 'INVALID_REQUEST', 'question 必填非空', requestId);
        if (question.length > 8000) return jsonError(res, 400, 'INVALID_REQUEST', 'question 超长', requestId);

        const providerId = body.provider || 'zhipu';
        const providerConfig = getProviderConfig(providerId, userId);
        const apiKey = resolveApiKey(userId, providerId);
        if (!apiKey) return jsonError(res, 403, 'UNAUTHENTICATED', `未配置${providerConfig.name}的API密钥`, requestId);
        const model = body.model || process.env.AI_MODEL || providerConfig.defaultModel;

        let book = null;
        if (bookId) {
            const data = getBookContent(userId, bookId);
            if (!data) return jsonError(res, 404, 'RESOURCE_NOT_FOUND', '书籍不存在或无法读取', requestId);
            book = { bookId, title: data.book.title, content: data.supported ? data.content : null, supported: data.supported };
        }

        // ---- 幂等判定 ----
        const fingerprint = rs.computeFingerprint({ entry: taskType ? 'task' : 'ask', question, selection, action, bookId, conversationId, provider: providerId, model, taskType });
        const existing = rs.getRequest(userId, requestId);
        if (existing) {
            if (existing.fingerprint !== fingerprint) return jsonError(res, 409, 'REQUEST_CONFLICT', '同 requestId 请求内容不一致', requestId);
            if (rs.isTerminal(existing.status)) return replay(req, res, existing, { requestId, model, providerConfig });
            return jsonError(res, 409, 'REQUEST_RUNNING', '请求正在处理中', requestId);
        }

        // ---- 会话归属 ----
        let conversation;
        if (conversationId) {
            conversation = conv.getConversation(userId, conversationId);
            if (!conversation) return jsonError(res, 404, 'RESOURCE_NOT_FOUND', '会话不存在', requestId);
            if ((conversation.book_id || null) !== (bookId || null)) return jsonError(res, 409, 'CONVERSATION_BOOK_MISMATCH', '会话与书籍不匹配', requestId);
        } else {
            conversation = conv.getOrCreateActiveConversation(userId, bookId, providerId, model);
        }
        const convId = conversation.id;
        if (busyConversations.has(convId)) return jsonError(res, 409, 'CONVERSATION_BUSY', '该会话有请求正在处理', requestId);
        busyConversations.add(convId);

        const ctxLLM = { apiKey, providerConfig, model };
        const contextLimit = conv.getModelContextLimit(model);
        const deadlineAt = Date.now() + TOTAL_BUDGET_MS;
        const controller = new AbortController();
        const signal = controller.signal;
        let normallyEnded = false;
        const onClose = () => { if (!normallyEnded && !res.writableEnded) controller.abort(); };
        res.on('close', onClose);

        let send = null;
        let assistantMessageId = null;
        let userMessageId = null;
        const t0 = Date.now();
        let firstAnswerAt = null;
        let fullContent = '';
        let metrics = { toolCallCount: 0, llmCallCount: 0, tokenUsage: { kind: 'unavailable' } };

        const persistFinal = (status, content, metadata, error = null, postProcessing = { status: 'skipped', memoryChanges: [], error: null }) => {
            conv.updateMessage(assistantMessageId, { content, status, metadata });
            rs.updateRequest(userId, requestId, { status, error: error ? JSON.stringify(error) : null, postProcessing: JSON.stringify(postProcessing), assistantMessageId });
        };

        try {
            // ---- 短事务：用户消息 + 待完成助手消息 + 请求记录 ----
            const userMsg = conv.appendMessage(convId, { role: 'user', content: question, requestId, status: 'completed', metadata: { origin: taskType ? 'task_action' : 'user_text', selection, action } });
            userMessageId = userMsg.id;
            conv.maybeSetTitle(convId, question);
            const asstMsg = conv.appendMessage(convId, { role: 'assistant', content: '', requestId, status: 'running' });
            assistantMessageId = asstMsg.id;
            rs.createRequest({ userId, requestId, fingerprint, conversationId: convId, userMessageId, assistantMessageId });

            // ---- SSE 头 + start ----
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');
            res.setHeader('X-Accel-Buffering', 'no');
            send = makeSse(res, requestId);
            send('start', { schemaVersion: 1, conversationId: convId, userMessageId, assistantMessageId, model, provider: providerConfig.name, replayed: false });

            // ---- 长任务路由 ----
            if (taskType) {
                await runLongTask({ send, ctxLLM, book, bookId, userId, convId, taskType, model, providerId, signal, deadlineAt, requestId, persistFinal, metrics, t0 });
                normallyEnded = true;
                return;
            }

            // ---- 上下文预算（发送前检查） ----
            send('status', { phase: 'preparing', label: '正在准备上下文' });
            const requirement = selection ? 'selection' : (book && book.supported ? 'book' : 'none');
            const memoriesText = conv.formatMemoriesBlock(conv.retrieveMemories(userId, question, 6));
            let freshConv = conv.getConversation(userId, convId);
            // 发送前预算检查：逼近窗口先压缩
            const preMessages = conv.buildModelMessages(freshConv, buildSystemPrompt(model, book ? book.title : '', requirement), { memoriesText });
            if (estimateMessagesTokens(preMessages) + OUTPUT_RESERVE_TOKENS > contextLimit * 0.9) {
                try { await conv.maybeAutoCompress(ctxLLM, freshConv); } catch {}
                freshConv = conv.getConversation(userId, convId);
            }
            const systemPrompt = buildSystemPrompt(model, book ? book.title : '', requirement);
            const messages = conv.buildModelMessages(freshConv, systemPrompt, { memoriesText });

            // ---- Agent 自动决策/工具 ----
            const result = await agent.runAgentLoop({
                apiKey, providerConfig, model, providerId, systemPrompt, userMessage: question, messages,
                context: { bookId, userId, content: book ? book.content : '' },
                budget: { maxIterations: 8 }, signal, deadlineAt,
                onEvent: (evt) => {
                    if (evt.type === 'status') send('status', { phase: evt.phase, label: evt.label });
                    else if (evt.type === 'tool_call') send('tool_call', { callId: evt.callId, name: evt.name, args: evt.args });
                    else if (evt.type === 'tool_result') send('tool_result', { callId: evt.callId, name: evt.name, status: evt.status, returnedCount: evt.returnedCount, truncated: evt.truncated, elapsedMs: evt.elapsedMs, error: evt.error });
                    else if (evt.type === 'fallback') send('warning', { code: 'TOOLS_UNSUPPORTED', message: evt.reason, retryable: false });
                }
            });
            metrics.toolCallCount = result.totalToolCalls || 0;
            metrics.llmCallCount = result.llmCallCount || 0;
            metrics.tokenUsage = result.usage || { kind: 'unavailable' };

            if (signal.aborted) throw Object.assign(new Error('已取消'), { name: 'AbortError' });

            // ---- 证据登记与门控 ----
            let evidence = assignEvidence(result.evidenceCandidates, selection, bookId);
            let answerKind = 'answer';
            let finalRoute = result.route;

            if (result.fallback) {
                // 模型不支持工具：需取证时服务端先取证
                if (requirement === 'book' && book && book.supported) {
                    send('status', { phase: 'retrieving', label: '服务端取证' });
                    const ret = await rag.retrieveDetailed(userId, bookId, question, 5, { signal });
                    evidence = assignEvidence(ret.hits.map((h, i) => ({ bookId, chapter: h.chapter, text: h.text, method: h.method, rank: i + 1 })), selection, bookId);
                }
                finalRoute = 'direct';
            } else if (requirement === 'book' && result.route === 'direct' && !result.evidenceCandidates.length) {
                // 需取证却直答 → 受限补查一次
                send('status', { phase: 'retrieving', label: '补充取证' });
                const ret = await rag.retrieveDetailed(userId, bookId, question, 5, { signal });
                if (ret.hits.length) {
                    evidence = assignEvidence(ret.hits.map((h, i) => ({ bookId, chapter: h.chapter, text: h.text, method: h.method, rank: i + 1 })), selection, bookId);
                    finalRoute = 'tools';
                } else {
                    answerKind = 'insufficient_evidence';
                }
            }

            // 冻结证据集合，发 evidence 事件
            send('evidence', { items: evidence });
            const evidenceBlock = evidence.length
                ? '\n\n【本轮可引用的原文证据】\n' + evidence.map(e => `[${e.evidenceId}] ${e.chapter ? '(' + e.chapter + ') ' : ''}${e.text}`).join('\n')
                : '';

            // ---- 最终答案发射 ----
            if (answerKind === 'insufficient_evidence') {
                fullContent = '抱歉，我在当前书籍中没有检索到足以回答这个问题的原文证据。为避免误导，我不凭印象作答。你可以换一种问法，或指定相关章节后再试。';
                send('answer_start', { answerKind, delivery: 'buffered' });
                firstAnswerAt = Date.now();
                send('chunk', { content: fullContent });
            } else if (finalRoute === 'tools' || result.fallback) {
                // 证据型回答：真流式生成
                send('answer_start', { answerKind: 'answer', delivery: 'stream' });
                const finalMessages = [...messages];
                if (result.content) finalMessages.push({ role: 'assistant', content: result.content });
                finalMessages.push({ role: 'user', content: `请基于以下证据组织最终回答，引用处用[[E编号]]标注；证据不足的部分如实说明。${evidenceBlock}\n\n用户问题：${question}` });
                const streamed = await llmClient.stream(ctxLLM, {
                    messages: finalMessages, temperature: 0.4, maxTokens: 2000, timeoutMs: 90000, signal, deadlineAt,
                    onChunk: (c) => { if (firstAnswerAt === null) firstAnswerAt = Date.now(); fullContent += c; send('chunk', { content: c }); }
                });
                metrics.llmCallCount++;
                if (streamed.usage && streamed.usage.kind === 'actual') metrics.tokenUsage = streamed.usage;
                if (streamed.interrupted) throw Object.assign(new Error('上游流中断'), { name: 'InterruptedError', partial: fullContent });
            } else {
                // 直答（选文足够/无需取证）：诚实标 buffered，不以整段冒充逐 token
                fullContent = result.content || '';
                send('answer_start', { answerKind: 'answer', delivery: 'buffered' });
                firstAnswerAt = Date.now();
                if (fullContent) send('chunk', { content: fullContent });
            }

            if (signal.aborted) throw Object.assign(new Error('已取消'), { name: 'AbortError' });

            // ---- 短事务提交：助手正文 + 状态 + 后处理待办 ----
            send('status', { phase: 'persisting', label: '正在保存' });
            const metadata = { schemaVersion: 1, answerKind, evidence, citedEvidenceIds: [], memoryRefs: [], task: null, warnings: [] };
            const postProcessing = { status: 'pending', memoryChanges: [], error: null };
            persistFinal('completed', fullContent, metadata, null, postProcessing);
            normallyEnded = true;

            metrics.elapsedMs = Date.now() - t0;
            metrics.timeToFirstAnswerMs = firstAnswerAt ? firstAnswerAt - t0 : null;
            const assistantMessage = { id: assistantMessageId, requestId, role: 'assistant', content: fullContent, status: 'completed', metadata };
            send('end', { status: 'completed', assistantMessage, metrics, postProcessing, error: null });
            res.end();

            // ---- 异步一次记忆抽取（仅 completed；用原始 question 来源） ----
            const recent = conv.getConversationMessages(convId, { windowOnly: true }).slice(-6);
            conv.extractAndStoreMemories(ctxLLM, userId, convId, recent)
                .then(() => rs.updateRequest(userId, requestId, { postProcessing: JSON.stringify({ status: 'completed', memoryChanges: [], error: null }) }))
                .catch(e => rs.updateRequest(userId, requestId, { postProcessing: JSON.stringify({ status: 'failed', memoryChanges: [], error: { code: 'MEMORY_EXTRACT_FAILED', message: e.message, retryable: true } }) }));
        } catch (error) {
            const aborted = error.name === 'AbortError' || signal.aborted;
            const interrupted = error.name === 'InterruptedError';
            const status = aborted ? 'cancelled' : (interrupted ? 'interrupted' : 'failed');
            const errObj = { code: aborted ? 'CANCELLED' : (interrupted ? 'UPSTREAM_INTERRUPTED' : 'UPSTREAM_ERROR'), message: aborted ? '请求已取消' : (error.message || '未知错误'), retryable: !aborted };
            try {
                if (assistantMessageId) persistFinal(status, fullContent || error.partialContent || '', { schemaVersion: 1, answerKind: 'answer', evidence: [], citedEvidenceIds: [], memoryRefs: [], task: null, warnings: [errObj] }, errObj, { status: 'skipped', memoryChanges: [], error: null });
            } catch {}
            if (send && !res.writableEnded) {
                metrics.elapsedMs = Date.now() - t0;
                metrics.timeToFirstAnswerMs = firstAnswerAt ? firstAnswerAt - t0 : null;
                send('end', { status, assistantMessage: { id: assistantMessageId, content: fullContent, status }, metrics, postProcessing: { status: 'skipped', memoryChanges: [], error: null }, error: errObj });
                res.end();
            } else if (!res.headersSent) {
                jsonError(res, aborted ? 499 : 500, errObj.code, errObj.message, requestId);
            }
        } finally {
            busyConversations.delete(convId);
            res.removeListener('close', onClose);
        }
    }

    async function runLongTask({ send, ctxLLM, book, bookId, userId, convId, taskType, model, providerId, signal, deadlineAt, requestId, persistFinal, metrics, t0 }) {
        if (!book || !book.supported) {
            send('answer_start', { answerKind: 'task_result', delivery: 'buffered' });
            const msg = '当前书籍不支持该任务（仅支持 TXT）。';
            send('chunk', { content: msg });
            persistFinal('completed', msg, { schemaVersion: 1, answerKind: 'task_result', evidence: [], citedEvidenceIds: [], memoryRefs: [], task: { taskType, status: 'failed', coverage: { mode: 'unknown' } }, warnings: [] });
            send('end', { status: 'completed', assistantMessage: { content: msg, status: 'completed' }, metrics: { elapsedMs: Date.now() - t0 }, postProcessing: { status: 'skipped', memoryChanges: [], error: null }, error: null });
            return;
        }
        send('status', { phase: 'task', label: '正在执行长任务' });
        const result = await orchestrator.runTask(taskType, {
            bookId, userId, content: book.content, bookName: book.title,
            apiKey: ctxLLM.apiKey, providerConfig: ctxLLM.providerConfig, model, providerId
        }, (evt) => {
            if (evt.type === 'task_progress' || evt.type === 'progress') send('task_progress', evt);
        });
        const finalContent = (result.final && (result.final.note || result.final.report)) || '';
        const taskStatus = finalContent ? 'completed' : 'failed';
        const task = { taskType, bookId, contentHash: null, status: taskStatus, content: finalContent, cached: false, coverage: { mode: 'sampled', processedChars: null, totalChars: book.content.length, completedUnits: 0, totalUnits: 0, failedUnits: 0 }, warnings: [] };
        send('answer_start', { answerKind: 'task_result', delivery: 'buffered' });
        send('chunk', { content: finalContent });
        const metadata = { schemaVersion: 1, answerKind: 'task_result', evidence: [], citedEvidenceIds: [], memoryRefs: [], task, warnings: [] };
        persistFinal('completed', finalContent, metadata);
        // 持久化任务缓存（复用既有 task_results）
        try {
            const { getDB } = require('./database');
            if (finalContent) getDB().prepare(`INSERT INTO task_results (user_id, book_id, task_type, content, created_at, updated_at) VALUES (?, ?, ?, ?, datetime('now'), datetime('now')) ON CONFLICT(user_id, book_id, task_type) DO UPDATE SET content = excluded.content, updated_at = datetime('now')`).run(userId, bookId, taskType, finalContent);
        } catch {}
        send('end', { status: 'completed', assistantMessage: { content: finalContent, status: 'completed', metadata }, metrics: { elapsedMs: Date.now() - t0 }, postProcessing: { status: 'skipped', memoryChanges: [], error: null }, error: null });
    }

    async function replay(req, res, existing, { requestId, model, providerConfig }) {
        const { getDB } = require('./database');
        const asst = existing.assistant_message_id ? getDB().prepare('SELECT * FROM messages WHERE id = ?').get(existing.assistant_message_id) : null;
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        const send = makeSse(res, requestId);
        send('start', { schemaVersion: 1, conversationId: existing.conversation_id, userMessageId: existing.user_message_id, assistantMessageId: existing.assistant_message_id, model, provider: providerConfig.name, replayed: true });
        const metadata = asst && asst.metadata ? JSON.parse(asst.metadata) : null;
        send('end', { status: existing.status, assistantMessage: asst ? { id: asst.id, content: asst.content, status: asst.status, metadata } : null, metrics: { elapsedMs: 0, replayed: true }, postProcessing: existing.post_processing ? JSON.parse(existing.post_processing) : null, error: existing.error ? JSON.parse(existing.error) : null });
        res.end();
    }

    function handleRequestQuery(req, res) {
        const userId = req.user.id;
        const r = rs.getRequest(userId, req.params.requestId);
        if (!r) return jsonError(res, 404, 'RESOURCE_NOT_FOUND', '请求不存在', req.params.requestId);
        const { getDB } = require('./database');
        const um = r.user_message_id ? getDB().prepare('SELECT id, role, content, status FROM messages WHERE id = ?').get(r.user_message_id) : null;
        const am = r.assistant_message_id ? getDB().prepare('SELECT id, role, content, status, metadata FROM messages WHERE id = ?').get(r.assistant_message_id) : null;
        res.json({
            requestId: r.request_id, status: r.status, conversationId: r.conversation_id,
            userMessage: um || null,
            assistantMessage: am ? { ...am, metadata: am.metadata ? JSON.parse(am.metadata) : null } : null,
            postProcessing: r.post_processing ? JSON.parse(r.post_processing) : null,
            error: r.error ? JSON.parse(r.error) : null
        });
    }

    return { handleAsk, handleRequestQuery };
}

module.exports = { createQaService };