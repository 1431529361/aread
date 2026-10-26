import { describe, expect, it } from 'vitest';
import {
  getProviderConfig,
  listProviderConfigs,
  saveProviderConfig,
} from '../src/db/repositories/providers';
import {
  buildChatConfig,
  buildEmbeddingConfig,
  buildReranker,
} from '../src/services/providerSettings';
import { createTestDb } from './helpers/testDb';

describe('provider_config', () => {
  it('向量配置支持可选 rerank_model，留空即关闭', async () => {
    const { db, close } = await createTestDb();

    await saveProviderConfig(db, {
      kind: 'embedding',
      baseUrl: 'https://api.siliconflow.cn/v1/',
      model: 'BAAI/bge-m3',
      dims: 1024,
      dimensionsParam: null,
      maskedKey: 'sk-****1234',
      rerankModel: 'BAAI/bge-reranker-v2-m3',
      now: '2026-10-23T00:00:00.000Z',
    });

    const record = await getProviderConfig(db, 'embedding');
    expect(record).toMatchObject({
      kind: 'embedding',
      baseUrl: 'https://api.siliconflow.cn/v1',
      model: 'BAAI/bge-m3',
      dims: 1024,
      rerankModel: 'BAAI/bge-reranker-v2-m3',
    });

    await saveProviderConfig(db, {
      kind: 'embedding',
      baseUrl: 'https://api.siliconflow.cn/v1',
      model: 'BAAI/bge-m3',
      dims: 1024,
      rerankModel: '   ',
    });
    expect((await getProviderConfig(db, 'embedding'))?.rerankModel).toBeNull();
    close();
  });

  it('对话配置不保存 rerank_model', async () => {
    const { db, close } = await createTestDb();

    await saveProviderConfig(db, {
      kind: 'chat',
      baseUrl: 'https://token-plan.example.com/v1',
      model: 'qwen-test',
      rerankModel: 'should-be-ignored',
      contextWindow: 128000,
    });

    const record = await getProviderConfig(db, 'chat');
    expect(record).toMatchObject({
      kind: 'chat',
      rerankModel: null,
      contextWindow: 128000,
    });
    expect((await listProviderConfigs(db)).map((item) => item.kind)).toEqual([
      'chat',
    ]);
    close();
  });
});

describe('providerSettings', () => {
  it('构建 chat/embedding 配置并复用向量 Key 构建 reranker', async () => {
    const { db, close } = await createTestDb();
    await saveProviderConfig(db, {
      kind: 'embedding',
      baseUrl: 'https://api.siliconflow.cn/v1',
      model: 'BAAI/bge-m3',
      dims: 1024,
      rerankModel: 'BAAI/bge-reranker-v2-m3',
    });
    await saveProviderConfig(db, {
      kind: 'chat',
      baseUrl: 'https://chat.example.com/v1',
      model: 'qwen-test',
    });

    const embedding = (await getProviderConfig(db, 'embedding'))!;
    const chat = (await getProviderConfig(db, 'chat'))!;

    expect(buildEmbeddingConfig(embedding, 'embed-key')).toMatchObject({
      baseUrl: 'https://api.siliconflow.cn/v1',
      model: 'BAAI/bge-m3',
      dims: 1024,
    });
    expect(buildChatConfig(chat, 'chat-key')).toMatchObject({
      baseUrl: 'https://chat.example.com/v1',
      model: 'qwen-test',
    });
    expect(buildReranker(embedding, 'embed-key')).not.toBeNull();
    expect(buildReranker(embedding, '')).toBeNull();

    await saveProviderConfig(db, {
      kind: 'embedding',
      baseUrl: 'https://api.siliconflow.cn/v1',
      model: 'BAAI/bge-m3',
      dims: 1024,
      rerankModel: '',
    });
    expect(buildReranker((await getProviderConfig(db, 'embedding'))!, 'key')).toBeNull();
    expect(() =>
      buildChatConfig({ ...chat, baseUrl: 'http://chat.example.com/v1' }, 'chat-key'),
    ).toThrow('Base URL 必须使用 HTTPS');
    expect(() =>
      buildEmbeddingConfig(
        { ...embedding, baseUrl: 'http://embedding.example.com/v1' },
        'embed-key',
      ),
    ).toThrow('Base URL 必须使用 HTTPS');
    close();
  });
});
