/**
 * Multi-Agent DAG 编排引擎
 * - 将复杂阅读任务拆解为子 Agent 节点，按拓扑排序并行调度
 * - 内置任务：generate-notes（读书笔记）、character-analysis（人物分析）
 * - 节点失败自动降级，不阻塞后续节点
 * - 全程通过 onEvent 推送进度（node_start / node_progress / node_done / node_error / task_done）
 */

const { splitChapters } = require('./text-utils');
const llmClient = require('./llm-client');

// ==================== 通用 LLM 调用 ====================

// 统一走 llm-client，保留编排器默认参数（长超时 + 2 次退避重试）
function llm(ctx, prompt, { maxTokens = 1200, temperature = 0.5, timeoutMs = 120000, retries = 2 } = {}) {
    return llmClient.complete(ctx, prompt, { maxTokens, temperature, timeoutMs, retries });
}

// ==================== 并发控制 ====================

/**
 * 以受限并发度执行异步任务，避免一次性发出过多请求触发提供商限流/超时
 */
async function runWithConcurrency(items, limit, fn) {
    const results = new Array(items.length);
    let idx = 0;
    const workerCount = Math.max(1, Math.min(limit, items.length));
    const workers = Array.from({ length: workerCount }, async () => {
        while (idx < items.length) {
            const i = idx++;
            results[i] = await fn(items[i], i);
        }
    });
    await Promise.all(workers);
    return results;
}

// ==================== DAG 编排器 ====================

class Orchestrator {
    /**
     * @param {Array} nodes [{ id, name, deps:[], run: async (ctx, inputs, onProgress) => output }]
     */
    constructor(nodes) {
        this.nodes = nodes;
        this.outputs = {};
        this.completed = new Set();
    }

    async run(ctx, onEvent) {
        const pending = [...this.nodes];
        const total = this.nodes.length;
        let progress = 0;

        while (pending.length > 0) {
            // 找出依赖已就绪的节点
            const ready = pending.filter(n => n.deps.every(d => this.completed.has(d)));
            if (ready.length === 0) {
                throw new Error('DAG 存在循环依赖或缺失依赖节点');
            }

            // 并行执行就绪节点
            await Promise.all(ready.map(async (node) => {
                onEvent && onEvent({ type: 'node_start', id: node.id, name: node.name, deps: node.deps });
                const inputs = {};
                for (const d of node.deps) inputs[d] = this.outputs[d];
                try {
                    const output = await node.run(ctx, inputs, (p) => {
                        onEvent && onEvent({ type: 'node_progress', id: node.id, ...p });
                    });
                    this.outputs[node.id] = output;
                    onEvent && onEvent({ type: 'node_done', id: node.id, name: node.name });
                } catch (e) {
                    // 节点失败降级：写入错误输出，不阻塞下游
                    this.outputs[node.id] = { error: e.message };
                    onEvent && onEvent({ type: 'node_error', id: node.id, name: node.name, error: e.message });
                }
                this.completed.add(node.id);
                progress++;
                onEvent && onEvent({ type: 'progress', progress, total, percent: Math.round((progress / total) * 100) });
            }));

            // 统一移除已执行节点
            for (const node of ready) {
                const idx = pending.indexOf(node);
                if (idx >= 0) pending.splice(idx, 1);
            }
        }
        return this.outputs;
    }
}

// ==================== 任务定义 ====================

const MAX_SUMMARY_CHAPTERS = 8; // 限制摘要章节数，控制耗时与成本

/**
 * 读书笔记任务 DAG:
 *   outline（大纲）→ summaries（逐章并行摘要）→ critique（点评）→ integrate（整合）
 */
function buildGenerateNotesTask() {
    return {
        name: '读书笔记生成',
        nodes: [
            {
                id: 'outline',
                name: '大纲 Agent',
                deps: [],
                run: async (ctx, inputs, onProgress) => {
                    const chapters = splitChapters(ctx.content);
                    const chapterList = chapters.slice(0, 20).map((c, i) => `${i + 1}. ${c.title}`).join('\n');
                    const preview = ctx.content.substring(0, 2500);
                    const prompt = `你是一位资深读书笔记撰写者。请基于以下书籍信息生成结构化大纲。

书名：《${ctx.bookName}》
章节列表：
${chapterList}

正文开头预览：
${preview}

请输出：
1. 一段话书籍主旨概括（100字内）
2. 全书结构大纲（按章节，每章一句话概括推测内容）
3. 3-5个核心主题关键词`;
                    onProgress({ stage: '生成大纲' });
                    const result = await llm(ctx, prompt, { maxTokens: 1000 });
                    return { outline: result, chapterCount: chapters.length, chapterList };
                }
            },
            {
                id: 'summaries',
                name: '摘要 Agent（并行）',
                deps: ['outline'],
                run: async (ctx, inputs, onProgress) => {
                    const chapters = splitChapters(ctx.content);
                    const targets = chapters.slice(0, MAX_SUMMARY_CHAPTERS);
                    onProgress({ stage: `并行摘要 ${targets.length} 章` });

                    // 受限并发生成各章摘要（每次最多 3 个请求，避免限流/超时）
                    let doneCount = 0;
                    const summaries = await runWithConcurrency(targets, 3, async (ch, i) => {
                        const prompt = `请用150字以内总结以下章节的核心内容，提炼关键情节与要点：

章节：${ch.title}
内容：
${ch.text.substring(0, 2000)}`;
                        try {
                            const summary = await llm(ctx, prompt, { maxTokens: 400, temperature: 0.3 });
                            doneCount++;
                            onProgress({ stage: `已完成 ${doneCount}/${targets.length}`, done: doneCount, total: targets.length });
                            return { index: i + 1, title: ch.title, summary };
                        } catch (e) {
                            doneCount++;
                            onProgress({ stage: `已完成 ${doneCount}/${targets.length}`, done: doneCount, total: targets.length });
                            return { index: i + 1, title: ch.title, summary: '(摘要生成失败)', error: e.message };
                        }
                    });
                    return { summaries, totalChapters: chapters.length, summarized: targets.length };
                }
            },
            {
                id: 'critique',
                name: '点评 Agent',
                deps: ['outline', 'summaries'],
                run: async (ctx, inputs, onProgress) => {
                    const outline = inputs.outline?.outline || '';
                    const summaries = inputs.summaries?.summaries || [];
                    const summaryText = summaries.map(s => `【${s.title}】${s.summary}`).join('\n');
                    const prompt = `你是一位文学评论家。基于以下书籍大纲与章节摘要，撰写批判性点评。

书名：《${ctx.bookName}》
大纲：
${outline}

章节摘要：
${summaryText}

请输出：
1. 作品价值与亮点（200字内）
2. 不足或争议点（150字内）
3. 适读人群建议（100字内）`;
                    onProgress({ stage: '生成点评' });
                    const critique = await llm(ctx, prompt, { maxTokens: 800 });
                    return { critique };
                }
            },
            {
                id: 'integrate',
                name: '整合 Agent',
                deps: ['outline', 'summaries', 'critique'],
                run: async (ctx, inputs, onProgress) => {
                    const outline = inputs.outline?.outline || '(大纲生成失败)';
                    const summaries = inputs.summaries?.summaries || [];
                    const critique = inputs.critique?.critique || '(点评生成失败)';
                    const summaryText = summaries.map(s => `### ${s.title}\n${s.summary}`).join('\n\n');

                    const prompt = `请将以下素材整合为一份完整、排版优美的读书笔记（Markdown 格式）。

书名：《${ctx.bookName}》

【书籍大纲】
${outline}

【章节摘要】
${summaryText}

【批判性点评】
${critique}

要求：
- 以 "# 《${ctx.bookName}》读书笔记" 为标题
- 包含：书籍概览、结构大纲、章节摘要、深度点评、总结感悟
- 摘要部分使用二级标题分章
- 末尾加一段100字的个人感悟
- 整体语言精炼、有见地`;
                    onProgress({ stage: '整合输出' });
                    const note = await llm(ctx, prompt, { maxTokens: 2000, temperature: 0.6, timeoutMs: 180000 });
                    return { note };
                }
            }
        ]
    };
}

/**
 * 人物分析任务 DAG:
 *   detect（人物检测）→ analyze（并行人物分析）→ integrate（整合关系图谱）
 */
function buildCharacterAnalysisTask() {
    return {
        name: '人物关系分析',
        nodes: [
            {
                id: 'detect',
                name: '人物检测 Agent',
                deps: [],
                run: async (ctx, inputs, onProgress) => {
                    const preview = ctx.content.substring(0, 4000);
                    const prompt = `请从以下小说文本片段中，识别出最重要的3-5个人物角色。

《${ctx.bookName}》文本片段：
${preview}

请以 JSON 数组格式输出人物名单，每个元素包含 name（姓名）和 role（身份/定位简述），只输出 JSON，不要其他文字。示例：
[{"name":"张三","role":"主角"},{"name":"李四","role":"反派"}]`;
                    onProgress({ stage: '识别主要人物' });
                    const result = await llm(ctx, prompt, { maxTokens: 400, temperature: 0.2 });
                    let characters = [];
                    try {
                        const match = result.match(/\[[\s\S]*\]/);
                        characters = JSON.parse(match ? match[0] : result);
                    } catch {
                        characters = [{ name: '未能解析', role: result.substring(0, 100) }];
                    }
                    return { characters: characters.slice(0, 5) };
                }
            },
            {
                id: 'analyze',
                name: '人物分析 Agent（并行）',
                deps: ['detect'],
                run: async (ctx, inputs, onProgress) => {
                    const characters = inputs.detect?.characters || [];
                    onProgress({ stage: `并行分析 ${characters.length} 个人物` });

                    const analyses = await runWithConcurrency(characters, 3, async (char, i) => {
                        const name = char.name;
                        // 在全文中查找该人物的上下文片段
                        const content = ctx.content || '';
                        const pos = content.indexOf(name);
                        const snippet = pos >= 0 ? content.substring(Math.max(0, pos - 100), pos + 600) : '';

                        const prompt = `请基于以下文本片段，分析人物“${name}”的形象。

《${ctx.bookName}》中与“${name}”相关片段：
${snippet}

身份定位：${char.role || '未知'}

请输出：性格特点（3点）、行为动机分析、人物弧光（是否有成长转变），共200字内。`;
                        try {
                            const analysis = await llm(ctx, prompt, { maxTokens: 500, temperature: 0.4 });
                            onProgress({ stage: `已完成 ${i + 1}/${characters.length}` });
                            return { name, role: char.role, analysis };
                        } catch (e) {
                            return { name, role: char.role, analysis: '(分析失败)', error: e.message };
                        }
                    });
                    return { analyses };
                }
            },
            {
                id: 'integrate',
                name: '关系整合 Agent',
                deps: ['detect', 'analyze'],
                run: async (ctx, inputs, onProgress) => {
                    const analyses = inputs.analyze?.analyses || [];
                    const analysisText = analyses.map(a => `【${a.name}（${a.role}）】\n${a.analysis}`).join('\n\n');
                    const prompt = `请基于以下各人物分析，整合输出一份完整的人物关系分析报告（Markdown）。

书名：《${ctx.bookName}》

各人物分析：
${analysisText}

要求：
- 以 "# 《${ctx.bookName}》人物关系分析" 为标题
- 分人物逐一分析（二级标题）
- 末尾总结人物关系网络（谁与谁有何关系、冲突线索）
- 语言精炼有洞察力`;
                    onProgress({ stage: '整合关系图谱' });
                    const report = await llm(ctx, prompt, { maxTokens: 1500, temperature: 0.5, timeoutMs: 180000 });
                    return { report };
                }
            }
        ]
    };
}

const TASK_BUILDERS = {
    'generate-notes': buildGenerateNotesTask,
    'character-analysis': buildCharacterAnalysisTask
};

// ==================== 对外接口 ====================

/**
 * 运行 Multi-Agent 任务
 * @param {string} taskType 任务类型
 * @param {Object} params { bookId, userId, content, bookName, apiKey, providerConfig, model, providerId }
 * @param {Function} onEvent 进度回调
 * @returns {Object} 各节点输出
 */
async function runTask(taskType, params, onEvent) {
    const builder = TASK_BUILDERS[taskType];
    if (!builder) throw new Error(`未知任务类型: ${taskType}，支持: ${Object.keys(TASK_BUILDERS).join(', ')}`);

    const task = builder();
    const ctx = { ...params };
    const orch = new Orchestrator(task.nodes);

    onEvent({ type: 'task_start', taskType, taskName: task.name, nodes: task.nodes.map(n => ({ id: n.id, name: n.name, deps: n.deps })) });

    const outputs = await orch.run(ctx, onEvent);

    // 提取最终产出
    const finalOutput = outputs.integrate || outputs[task.nodes[task.nodes.length - 1].id] || {};
    onEvent({ type: 'task_done', taskType, finalNodeId: 'integrate' });
    return { outputs, final: finalOutput };
}

function listTasks() {
    return Object.keys(TASK_BUILDERS).map(id => {
        const task = TASK_BUILDERS[id]();
        return { id, name: task.name, nodes: task.nodes.map(n => ({ id: n.id, name: n.name, deps: n.deps })) };
    });
}

module.exports = {
    runTask,
    listTasks,
    Orchestrator
};
