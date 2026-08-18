/**
 * 工具注册表
 * - 自动收集本目录下所有工具文件（除 index.js），构建 name → tool 注册表
 * - 新增工具只需在本目录添加一个导出 { name, description, parameters, execute } 的文件
 * - AGENT_TOOLS schema 与工具执行分发均由注册表生成，无需再改 agent.js
 */

const fs = require('fs');
const path = require('path');

const registry = new Map();

for (const file of fs.readdirSync(__dirname)) {
    if (file === 'index.js' || !file.endsWith('.js')) continue;
    const tool = require(path.join(__dirname, file));
    // 校验必备字段，装载期即暴露问题
    if (!tool || typeof tool.name !== 'string' || !tool.name ||
        typeof tool.description !== 'string' ||
        typeof tool.parameters !== 'object' ||
        typeof tool.execute !== 'function') {
        throw new Error(`工具文件 ${file} 缺少必备字段（name/description/parameters/execute）`);
    }
    if (registry.has(tool.name)) {
        throw new Error(`工具名冲突: ${tool.name}（${file}）`);
    }
    registry.set(tool.name, tool);
}

/**
 * 生成 OpenAI function calling 格式的工具 schema 数组
 */
function getToolSchemas() {
    return [...registry.values()].map(t => ({
        type: 'function',
        function: {
            name: t.name,
            description: t.description,
            parameters: t.parameters
        }
    }));
}

/**
 * 执行单个工具
 * @param {string} name 工具名
 * @param {Object} args 参数
 * @param {Object} ctx 执行上下文 { bookId, userId, content, ... }
 */
async function executeTool(name, args, ctx) {
    const tool = registry.get(name);
    if (!tool) return { error: `未知工具: ${name}` };
    return tool.execute(args, ctx);
}

function getToolNames() {
    return [...registry.keys()];
}

module.exports = { getToolSchemas, executeTool, getToolNames };
