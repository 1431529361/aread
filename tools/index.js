/**
 * 工具注册表（P1a A2）
 * - 自动收集本目录下工具文件（除 index.js 与辅助模块），构建 name → tool 注册表
 * - 参数完整且通过 schema 校验后才执行；未知工具/非法参数返回结构化 ToolResult 错误
 */
const fs = require('fs');
const path = require('path');
const TR = require('./tool-result');

const HELPER_FILES = new Set(['index.js', 'tool-result.js']);
const registry = new Map();

for (const file of fs.readdirSync(__dirname)) {
    if (HELPER_FILES.has(file) || !file.endsWith('.js')) continue;
    const tool = require(path.join(__dirname, file));
    if (!tool || typeof tool.name !== 'string' || !tool.name ||
        typeof tool.description !== 'string' ||
        typeof tool.parameters !== 'object' ||
        typeof tool.execute !== 'function') {
        throw new Error(`工具文件 ${file} 缺少必备字段（name/description/parameters/execute）`);
    }
    if (registry.has(tool.name)) throw new Error(`工具名冲突: ${tool.name}（${file}）`);
    registry.set(tool.name, tool);
}

function getToolSchemas() {
    return [...registry.values()].map(t => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters }
    }));
}

/** 校验参数：必须为对象，required 字段存在且类型匹配 */
function validateArgs(tool, args) {
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
        return { valid: false, error: '参数必须为 JSON 对象' };
    }
    const schema = tool.parameters || {};
    const props = schema.properties || {};
    for (const req of schema.required || []) {
        if (args[req] === undefined || args[req] === null || args[req] === '') {
            return { valid: false, error: `缺少必填参数: ${req}` };
        }
    }
    for (const [key, val] of Object.entries(args)) {
        const spec = props[key];
        if (!spec) continue;
        if (spec.type === 'string' && typeof val !== 'string') return { valid: false, error: `参数 ${key} 应为字符串` };
        if (spec.type === 'integer' && !Number.isInteger(val)) return { valid: false, error: `参数 ${key} 应为整数` };
    }
    return { valid: true };
}

async function executeTool(name, args, ctx) {
    const tool = registry.get(name);
    if (!tool) return TR.error('UNKNOWN_TOOL', `未知工具: ${name}`);
    const v = validateArgs(tool, args);
    if (!v.valid) return TR.error('INVALID_TOOL_ARGS', v.error);
    try {
        return await tool.execute(args, ctx);
    } catch (e) {
        return TR.error('TOOL_EXECUTION_FAILED', e.message);
    }
}

function getToolNames() { return [...registry.keys()]; }

module.exports = { getToolSchemas, executeTool, getToolNames, validateArgs };