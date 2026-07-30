/**
 * Embedding 提供商管理模块
 * - 预置提供商：zhipu / siliconflow（端点与模型后端写死，复用用户已配置的对话 API Key）
 * - 阿里云（aliyun）：专属 MaaS 端点因用户而异，baseUrl + 模型由用户配置，Key 独立存储（api_keys 表 provider='aliyun-embed'）
 * - 统一 1024 维，保证 rag_vec 虚拟表可混用不同提供商
 * - 通过 init() 注入 getApiKey（解密逻辑在 server.js），避免循环依赖
 */

const { getDB } = require('./database');

const EMBED_DIMS = 1024;
const ALIYUN_KEY_PROVIDER = 'aliyun-embed'; // api_keys 表中的 provider 标识

// 预置提供商（端点/模型固定，不允许用户改地址）
const PRESET_PROVIDERS = {
    zhipu: {
        name: '智谱AI',
        endpoint: 'https://open.bigmodel.cn/api/paas/v4/embeddings',
        model: 'embedding-3',
        extraBody: { dimensions: EMBED_DIMS } // embedding-3 支持指定维度
    },
    siliconflow: {
        name: '硅基流动',
        endpoint: 'https://api.siliconflow.cn/v1/embeddings',
        model: 'BAAI/bge-large-zh-v1.5' // 原生 1024 维
    }
};

const VALID_CHOICES = ['auto', 'aliyun', 'zhipu', 'siliconflow', 'off'];

let deps = { getApiKey: null };

function init({ getApiKey }) {
    deps.getApiKey = getApiKey;
}

// ==================== 用户设置读写（user_settings 表） ====================

function getSetting(userId, key) {
    const row = getDB().prepare('SELECT value FROM user_settings WHERE user_id = ? AND key = ?').get(userId, key);
    return row ? row.value : null;
}

function setSetting(userId, key, value) {
    getDB().prepare(`
        INSERT INTO user_settings (user_id, key, value, updated_at)
        VALUES (?, ?, ?, datetime('now'))
        ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(userId, key, value);
}

/**
 * 读取用户 Embedding 配置
 * @returns {{ provider: string, aliyun: { baseUrl: string, model: string } }}
 */
function getEmbeddingSettings(userId) {
    const provider = getSetting(userId, 'embedding_provider') || 'auto';
    let aliyun = { baseUrl: '', model: '' };
    try {
        const raw = getSetting(userId, 'embedding_aliyun');
        if (raw) aliyun = { ...aliyun, ...JSON.parse(raw) };
    } catch {}
    // .env 兜底（开发/单机部署便利）
    if (!aliyun.baseUrl && process.env.EMBED_BASE_URL) {
        aliyun.baseUrl = process.env.EMBED_BASE_URL;
        aliyun.model = aliyun.model || process.env.EMBED_MODEL_NAME || '';
    }
    return { provider: VALID_CHOICES.includes(provider) ? provider : 'auto', aliyun };
}

function saveEmbeddingSettings(userId, { provider, aliyun }) {
    if (provider) {
        if (!VALID_CHOICES.includes(provider)) throw new Error(`无效的 embedding 提供商: ${provider}`);
        setSetting(userId, 'embedding_provider', provider);
    }
    if (aliyun && (aliyun.baseUrl || aliyun.model)) {
        setSetting(userId, 'embedding_aliyun', JSON.stringify({
            baseUrl: String(aliyun.baseUrl || '').trim().replace(/\/+$/, ''),
            model: String(aliyun.model || '').trim()
        }));
    }
}

// ==================== Embedder 解析 ====================

function getAliyunKey(userId) {
    const key = deps.getApiKey && deps.getApiKey(userId, ALIYUN_KEY_PROVIDER);
    return key || process.env.EMBED_API_KEY || null;
}

function buildAliyunEmbedder(userId, settings) {
    const { baseUrl, model } = settings.aliyun;
    if (!baseUrl || !model) return null;
    const apiKey = getAliyunKey(userId);
    if (!apiKey) return null;
    return {
        providerId: 'aliyun',
        providerName: '阿里云',
        endpoint: baseUrl.replace(/\/+$/, '') + '/embeddings',
        model,
        dims: EMBED_DIMS,
        apiKey,
        extraBody: null
    };
}

function buildPresetEmbedder(userId, providerId) {
    const preset = PRESET_PROVIDERS[providerId];
    if (!preset) return null;
    const apiKey = deps.getApiKey && deps.getApiKey(userId, providerId);
    if (!apiKey) return null;
    return {
        providerId,
        providerName: preset.name,
        endpoint: preset.endpoint,
        model: preset.model,
        dims: EMBED_DIMS,
        apiKey,
        extraBody: preset.extraBody || null
    };
}

/**
 * 解析用户当前可用的 Embedder
 * @param {string} userId
 * @param {string|null} forProvider 指定提供商（查询时按建库 meta 指定）；不传则按用户设置/auto 解析
 * @returns {Object|null} { providerId, model, dims, apiKey, endpoint, extraBody } 或 null（不可用→纯 BM25）
 */
function resolveEmbedder(userId, forProvider = null) {
    const settings = getEmbeddingSettings(userId);
    if (forProvider) {
        return forProvider === 'aliyun'
            ? buildAliyunEmbedder(userId, settings)
            : buildPresetEmbedder(userId, forProvider);
    }
    if (settings.provider === 'off') return null;
    if (settings.provider === 'aliyun') return buildAliyunEmbedder(userId, settings);
    if (PRESET_PROVIDERS[settings.provider]) return buildPresetEmbedder(userId, settings.provider);
    // auto：阿里云配置完整 → 智谱 → 硅基流动
    return buildAliyunEmbedder(userId, settings)
        || buildPresetEmbedder(userId, 'zhipu')
        || buildPresetEmbedder(userId, 'siliconflow');
}

// ==================== Embedding API 调用 ====================

/**
 * 调用 Embedding API（带重试）
 * @param {Object} embedder resolveEmbedder 返回的对象
 * @param {string[]} texts
 * @returns {Promise<number[][]>}
 */
async function embedTexts(embedder, texts, { retries = 2, timeoutMs = 30000 } = {}) {
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const resp = await fetch(embedder.endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${embedder.apiKey}` },
                body: JSON.stringify({ model: embedder.model, input: texts, ...(embedder.extraBody || {}) }),
                signal: AbortSignal.timeout(timeoutMs)
            });
            if (!resp.ok) {
                const err = new Error(`Embedding API 失败: ${resp.status}`);
                err.status = resp.status;
                throw err;
            }
            const data = await resp.json();
            const vectors = data.data.map(d => d.embedding);
            if (vectors.length !== texts.length) throw new Error('Embedding 返回数量与输入不一致');
            if (vectors[0].length !== embedder.dims) {
                const err = new Error(`Embedding 维度不匹配：期望 ${embedder.dims}，实际 ${vectors[0].length}（请更换模型或联系管理员）`);
                err.fatal = true;
                throw err;
            }
            return vectors;
        } catch (e) {
            lastErr = e;
            // 维度不匹配 / 4xx（限流除外）重试无意义
            const status = e.status || 0;
            if (e.fatal || (status >= 400 && status < 500 && status !== 429)) break;
            if (attempt < retries) await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
        }
    }
    throw lastErr;
}

/**
 * 校验 Embedding 配置可用性（保存设置/Key 时调用）
 */
async function validateEmbedder(embedder) {
    await embedTexts(embedder, ['测试'], { retries: 0, timeoutMs: 15000 });
    return true;
}

module.exports = {
    EMBED_DIMS,
    ALIYUN_KEY_PROVIDER,
    PRESET_PROVIDERS,
    init,
    getEmbeddingSettings,
    saveEmbeddingSettings,
    resolveEmbedder,
    embedTexts,
    validateEmbedder
};
