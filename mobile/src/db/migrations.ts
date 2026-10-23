import type { DbAdapter, DbExecutor } from './adapter';
import {
  LATEST_SCHEMA_VERSION,
  SCHEMA_STATEMENTS,
  SEED_STATEMENTS,
} from './schema';

export interface Migration {
  version: number;
  statements: readonly string[];
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    statements: [...SCHEMA_STATEMENTS, ...SEED_STATEMENTS],
  },
];

export async function getSchemaVersion(db: DbExecutor): Promise<number> {
  const row = await db.queryOne<{ user_version: number }>('PRAGMA user_version');
  return Number(row?.user_version ?? 0);
}

/**
 * 顺序执行未应用的 migration。每个 migration 与其 user_version 更新在同一事务内。
 * 库版本高于当前 App 时直接报错，避免旧代码写坏新 schema。
 */
export async function runMigrations(db: DbAdapter): Promise<number> {
  let current = await getSchemaVersion(db);
  if (current > LATEST_SCHEMA_VERSION) {
    throw new Error(
      `数据库版本（${current}）高于当前 App 支持的版本（${LATEST_SCHEMA_VERSION}）`,
    );
  }

  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue;

    await db.transaction(async (tx) => {
      for (const statement of migration.statements) {
        await tx.execute(statement);
      }
      await tx.execute(`PRAGMA user_version = ${Math.floor(migration.version)}`);
    });

    current = migration.version;
  }

  return current;
}
