import { tokenize } from './tokenize';

/**
 * 将 token 包成 FTS5 字符串字面量。内部双引号按 FTS5 规则转义为两个双引号，
 * 避免查询中出现的引号、`*`、`-` 等被解释为 FTS5 语法操作符。
 */
export function escapeFtsToken(token: string): string {
  return `"${token.replace(/"/g, '""')}"`;
}

/**
 * 由用户查询构造 FTS5 查询串：先分词、去重，再以 OR 连接。
 * 返回空串表示没有可用 token，调用方应跳过 FTS 路线。
 */
export function buildFtsQuery(query: string): string {
  const unique = [...new Set(tokenize(query))];
  if (unique.length === 0) return '';
  return unique.map(escapeFtsToken).join(' OR ');
}
