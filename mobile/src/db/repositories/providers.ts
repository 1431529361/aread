import type { DbExecutor } from '../adapter';

export type ProviderKind = 'chat' | 'embedding';

export interface ProviderConfigRecord {
  kind: ProviderKind;
  baseUrl: string;
  model: string;
  dims: number | null;
  dimensionsParam: number | null;
  maskedKey: string | null;
  /** 仅 embedding 行使用；留空表示不启用 rerank */
  rerankModel: string | null;
  updatedAt: string | null;
}

interface ProviderRow {
  kind: string;
  base_url: string;
  model: string;
  dims: number | null;
  dimensions_param: number | null;
  masked_key: string | null;
  rerank_model: string | null;
  updated_at: string | null;
}

function mapRow(row: ProviderRow): ProviderConfigRecord {
  return {
    kind: row.kind === 'chat' ? 'chat' : 'embedding',
    baseUrl: row.base_url,
    model: row.model,
    dims: row.dims == null ? null : Number(row.dims),
    dimensionsParam:
      row.dimensions_param == null ? null : Number(row.dimensions_param),
    maskedKey: row.masked_key,
    rerankModel: row.rerank_model?.trim() || null,
    updatedAt: row.updated_at,
  };
}

export async function getProviderConfig(
  db: DbExecutor,
  kind: ProviderKind,
): Promise<ProviderConfigRecord | null> {
  const row = await db.queryOne<ProviderRow>(
    'SELECT * FROM provider_config WHERE kind = ?',
    [kind],
  );
  return row ? mapRow(row) : null;
}

export async function listProviderConfigs(
  db: DbExecutor,
): Promise<ProviderConfigRecord[]> {
  const rows = await db.queryAll<ProviderRow>(
    'SELECT * FROM provider_config ORDER BY kind',
  );
  return rows.map(mapRow);
}

export interface SaveProviderConfig {
  kind: ProviderKind;
  baseUrl: string;
  model: string;
  dims?: number | null;
  dimensionsParam?: number | null;
  maskedKey?: string | null;
  /** 仅 embedding 使用；空字符串等价于关闭 */
  rerankModel?: string | null;
  now?: string;
}

export async function saveProviderConfig(
  db: DbExecutor,
  config: SaveProviderConfig,
): Promise<void> {
  const rerankModel =
    config.kind === 'embedding' ? config.rerankModel?.trim() || null : null;
  const dims = config.kind === 'embedding' ? config.dims ?? 1024 : null;
  const dimensionsParam =
    config.kind === 'embedding' ? config.dimensionsParam ?? null : null;

  await db.execute(
    `INSERT INTO provider_config
      (kind, base_url, model, dims, dimensions_param, masked_key, rerank_model, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(kind) DO UPDATE SET
       base_url = excluded.base_url,
       model = excluded.model,
       dims = excluded.dims,
       dimensions_param = excluded.dimensions_param,
       masked_key = excluded.masked_key,
       rerank_model = excluded.rerank_model,
       updated_at = excluded.updated_at`,
    [
      config.kind,
      config.baseUrl.trim().replace(/\/+$/, ''),
      config.model.trim(),
      dims,
      dimensionsParam,
      config.maskedKey ?? null,
      rerankModel,
      config.now ?? new Date().toISOString(),
    ],
  );
}
