import fs from 'node:fs';
import path from 'node:path';

export const EVAL_ENV_FILE = '.env.eval.local';

export interface EvalEnv {
  embedBaseUrl: string;
  embedApiKey: string;
  embedModel: string;
  embedDims: number;
  /** 复用 Embedding Base URL/Key；为空表示不启用 rerank */
  rerankModel: string | null;
  chatBaseUrl: string;
  chatApiKey: string;
  chatModel: string;
}

function parseEnvFile(content: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values.set(key, value);
  }
  return values;
}

function required(values: Map<string, string>, key: string): string {
  const value = values.get(key);
  if (!value) throw new Error(`缺少评测配置 ${key}（参考 .env.eval.example）`);
  return value;
}

function trimBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

export function loadEvalEnv(file = EVAL_ENV_FILE): EvalEnv {  const fullPath = path.resolve(process.cwd(), file);
  if (!fs.existsSync(fullPath)) {
    throw new Error(
      `未找到 ${file}；请复制 .env.eval.example 并填入可用的 Embedding/Chat 配置`,
    );
  }

  const values = parseEnvFile(fs.readFileSync(fullPath, 'utf8'));
  const embedDims = Number(values.get('EVAL_EMBED_DIMS') || 1024);
  if (embedDims !== 1024) {
    throw new Error('EVAL_EMBED_DIMS 必须是 1024');
  }

  return {
    embedBaseUrl: trimBaseUrl(required(values, 'EVAL_EMBED_BASE_URL')),
    embedApiKey: required(values, 'EVAL_EMBED_API_KEY'),
    embedModel: required(values, 'EVAL_EMBED_MODEL'),
    embedDims,
    rerankModel: values.get('EVAL_RERANK_MODEL')?.trim() || null,
    chatBaseUrl: trimBaseUrl(required(values, 'EVAL_CHAT_BASE_URL')),
    chatApiKey: required(values, 'EVAL_CHAT_API_KEY'),
    chatModel: required(values, 'EVAL_CHAT_MODEL'),
  };
}
