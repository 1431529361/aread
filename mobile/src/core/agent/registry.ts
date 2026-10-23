import type { LlmToolSchema } from '../llm/client';
import type { AgentTool, AgentToolContext } from './types';
import { searchInBookTool } from './tools/searchInBook';
import { getChapterInfoTool } from './tools/getChapterInfo';
import { lookupCharacterTool } from './tools/lookupCharacter';

export const DEFAULT_TOOLS: readonly AgentTool[] = [
  searchInBookTool,
  getChapterInfoTool,
  lookupCharacterTool,
];

export function getToolSchemas(
  tools: readonly AgentTool[] = DEFAULT_TOOLS,
): LlmToolSchema[] {
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

export function getToolByName(
  tools: readonly AgentTool[],
  name: string,
): AgentTool | null {
  return tools.find((tool) => tool.name === name) ?? null;
}

export async function executeToolByName(
  tools: readonly AgentTool[],
  name: string,
  args: Record<string, unknown>,
  context: AgentToolContext,
): Promise<unknown> {
  const tool = getToolByName(tools, name);
  if (!tool) return { error: `未知工具: ${name}` };
  return tool.execute(args, context);
}
