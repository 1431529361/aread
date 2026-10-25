import type { DbAdapter } from './adapter';

export type Fts5Status = {
  available: boolean;
  error: string | null;
  checkedAt: string | null;
};

let status: Fts5Status = { available: true, error: null, checkedAt: null };

export function getFts5Status(): Fts5Status {
  return { ...status };
}

export function isFts5Available(): boolean {
  return status.available;
}

/** 仅供测试/诊断强制切换；运行时以 detectFts5 的结果为准。 */
export function setFts5Available(available: boolean, error: string | null = null): void {
  status = { available, error, checkedAt: new Date().toISOString() };
}

/**
 * M0-B 设备能力探测：op-sqlite 不一定启用 FTS5。
 * 建临时虚拟表 → 写入 → MATCH 查询 → 删除，任一步失败都降级到 JS BM25。
 */
export async function detectFts5(db: DbAdapter): Promise<Fts5Status> {
  try {
    await db.execute('DROP TABLE IF EXISTS __fts5_probe');
    await db.execute('CREATE VIRTUAL TABLE __fts5_probe USING fts5(tokens)');
    await db.execute("INSERT INTO __fts5_probe (tokens) VALUES ('阅读 测试 fts5')");
    const row = await db.queryOne<{ count: number }>(
      "SELECT COUNT(*) AS count FROM __fts5_probe WHERE __fts5_probe MATCH '测试'",
    );
    if (Number(row?.count ?? 0) < 1) throw new Error('FTS5 查询未命中探针数据');
    await db.execute('DROP TABLE __fts5_probe');
    status = { available: true, error: null, checkedAt: new Date().toISOString() };
  } catch (error) {
    try {
      await db.execute('DROP TABLE IF EXISTS __fts5_probe');
    } catch {
      // 清理失败不影响降级结论
    }
    status = {
      available: false,
      error: error instanceof Error ? error.message : String(error),
      checkedAt: new Date().toISOString(),
    };
  }
  return getFts5Status();
}
