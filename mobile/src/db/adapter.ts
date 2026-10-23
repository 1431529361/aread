import type { DB, Scalar } from '@op-engineering/op-sqlite';

export type DbValue = Scalar;

export interface DbRunResult {
  changes: number;
  lastInsertRowId: number;
}

export interface DbExecutor {
  execute(sql: string, params?: DbValue[]): Promise<DbRunResult>;
  queryAll<T>(sql: string, params?: DbValue[]): Promise<T[]>;
  queryOne<T>(sql: string, params?: DbValue[]): Promise<T | null>;
}

export interface DbAdapter extends DbExecutor {
  /**
   * 串行事务。回调内只能使用传入的 tx，不要嵌套调用 transaction。
   * 成功 COMMIT，抛错 ROLLBACK。
   */
  transaction<T>(fn: (tx: DbExecutor) => Promise<T>): Promise<T>;
  close(): void;
}

export function createDbAdapter(raw: DB): DbAdapter {
  const executor: DbExecutor = {
    async execute(sql, params) {
      const result = await raw.execute(sql, params);
      return {
        changes: result.rowsAffected ?? 0,
        lastInsertRowId: result.insertId ?? 0,
      };
    },
    async queryAll<T>(sql: string, params?: DbValue[]): Promise<T[]> {
      const result = await raw.execute(sql, params);
      return result.rows as unknown as T[];
    },
    async queryOne<T>(sql: string, params?: DbValue[]): Promise<T | null> {
      const result = await raw.execute(sql, params);
      return (result.rows[0] as unknown as T | undefined) ?? null;
    },
  };

  return {
    ...executor,
    async transaction<T>(fn: (tx: DbExecutor) => Promise<T>): Promise<T> {
      await raw.execute('BEGIN');
      try {
        const result = await fn(executor);
        await raw.execute('COMMIT');
        return result;
      } catch (error) {
        try {
          await raw.execute('ROLLBACK');
        } catch {
          // 回滚失败时保留原始错误
        }
        throw error;
      }
    },
    close() {
      raw.close();
    },
  };
}
