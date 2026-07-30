const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const iconv = require('iconv-lite');
const jschardet = require('jschardet');
require('dotenv').config();

const { initDB, getDB, isVecAvailable } = require('./database');
const { authMiddleware, registerHandler, loginHandler, meHandler, addDefaultBooksForUser } = require('./auth');
const { runAgentLoop } = require('./agent');
const rag = require('./rag');
const embeddingMod = require('./embedding');
const { runTask, listTasks } = require('./orchestrator');
const conv = require('./conversation');

const app = express();
const PORT = process.env.PORT || 3000;

const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
const BOOKS_DIR = path.join(__dirname, 'books');

const ALLOWED_EXTENSIONS = ['.txt', '.pdf', '.epub', '.mobi'];
const MAX_FILE_SIZE = 50 * 1024 * 1024;

if (!fs.existsSync(BOOKS_DIR)) {
    fs.mkdirSync(BOOKS_DIR, { recursive: true });
}

let db;

async function startServer() {
    db = await initDB();

    // 注入 Key 读取能力（解密逻辑在本文件），供 embedding 模块解析向量化提供商
    embeddingMod.init({ getApiKey: getStoredApiKey });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/auth/register', registerHandler);
app.post('/api/auth/login', loginHandler);

app.use('/api', authMiddleware);

app.get('/api/auth/me', meHandler);

function encrypt(text) {
    const iv = crypto.randomBytes(16);
    const key = Buffer.from(ENCRYPTION_KEY.slice(0, 64), 'hex');
    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return iv.toString('hex') + ':' + encrypted;
}

function decrypt(encryptedData) {
    try {
        const parts = encryptedData.split(':');
        const iv = Buffer.from(parts[0], 'hex');
        const encrypted = parts[1];
        const key = Buffer.from(ENCRYPTION_KEY.slice(0, 64), 'hex');
        const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
        let decrypted = decipher.update(encrypted, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted;
    } catch (error) {
        console.error('解密失败:', error);
        return null;
    }
}

// 读取用户存储的某 provider 的 Key（仅查表 + 智谱/硅基流动 .env 兜底，不回退到通用 AI_API_KEY）
function getStoredApiKey(userId, providerId) {
    const row = db.prepare('SELECT encrypted_key FROM api_keys WHERE user_id = ? AND provider = ?').get(userId, providerId);
    if (row) {
        const key = decrypt(row.encrypted_key);
        if (key) return key;
    }
    const envKeyMap = { zhipu: 'ZHIPU_API_KEY', siliconflow: 'SILICONFLOW_API_KEY' };
    return envKeyMap[providerId] ? (process.env[envKeyMap[providerId]] || null) : null;
}

function formatFileSize(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function getFileExtension(filename) {
    return path.extname(filename).toLowerCase();
}

function readTextFileWithEncoding(filePath) {
    const buffer = fs.readFileSync(filePath);

    const detected = jschardet.detect(buffer);
    let encoding = detected.encoding || 'utf-8';

    const encodingMap = {
        'GB2312': 'gbk', 'GB18030': 'gbk', 'gb2312': 'gbk', 'gb18030': 'gbk',
        'BIG5': 'big5', 'big5': 'big5',
        'UTF-8': 'utf-8', 'utf-8': 'utf-8',
        'UTF-16LE': 'utf-16le', 'UTF-16BE': 'utf-16be',
        'ascii': 'utf-8', 'ASCII': 'utf-8'
    };

    encoding = encodingMap[encoding] || encoding;

    if (encoding.toLowerCase() === 'utf-8' || encoding.toLowerCase() === 'utf8') {
        const hasBOM = buffer.length >= 3 && buffer[0] === 0xEF && buffer[1] === 0xBB && buffer[2] === 0xBF;
        if (hasBOM) {
            return buffer.slice(3).toString('utf-8');
        }
        try {
            const content = buffer.toString('utf-8');
            if (content.indexOf('\uFFFD') === -1) return content;
        } catch (e) {}
    }

    try {
        const content = iconv.decode(buffer, encoding);
        return content;
    } catch (error) {
        const fallbackEncodings = ['utf-8', 'gbk', 'gb18030', 'big5', 'utf-16le'];
        for (const enc of fallbackEncodings) {
            try {
                const content = iconv.decode(buffer, enc);
                if (content.indexOf('\uFFFD') === -1) return content;
            } catch (e) { continue; }
        }
        return buffer.toString('utf-8');
    }
}

function validateFile(file) {
    const ext = getFileExtension(file.originalname);
    if (!ALLOWED_EXTENSIONS.includes(ext)) {
        return { valid: false, error: `不支持的文件格式。支持的格式: ${ALLOWED_EXTENSIONS.join(', ')}` };
    }
    if (file.size > MAX_FILE_SIZE) {
        return { valid: false, error: `文件大小超过限制。最大允许: ${formatFileSize(MAX_FILE_SIZE)}` };
    }
    return { valid: true };
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const userId = req.user.id;
        const userDir = path.join(BOOKS_DIR, userId);
        if (!fs.existsSync(userDir)) {
            fs.mkdirSync(userDir, { recursive: true });
        }
        cb(null, userDir);
    },
    filename: (req, file, cb) => {
        const bookId = uuidv4();
        const ext = getFileExtension(file.originalname);
        cb(null, bookId + ext);
    }
});

const upload = multer({
    storage: storage,
    limits: { fileSize: MAX_FILE_SIZE },
    fileFilter: (req, file, cb) => {
        const ext = getFileExtension(file.originalname);
        if (ALLOWED_EXTENSIONS.includes(ext)) {
            cb(null, true);
        } else {
            cb(new Error(`不支持的文件格式: ${ext}`));
        }
    }
});

const PROVIDERS = {
    zhipu: {
        name: '智谱AI',
        apiEndpoint: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
        defaultModel: 'glm-4.5-air',
        models: [
            { id: 'glm-4.5-air', name: 'GLM-4.5-Air' },
            { id: 'glm-4-flash', name: 'GLM-4-Flash' },
            { id: 'glm-4-plus', name: 'GLM-4-Plus' },
            { id: 'glm-4-long', name: 'GLM-4-Long' }
        ],
        validateEndpoint: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
        validateModel: 'glm-4-flash'
    },
    siliconflow: {
        name: '硅基流动',
        apiEndpoint: 'https://api.siliconflow.cn/v1/chat/completions',
        defaultModel: 'deepseek-ai/DeepSeek-V4-Flash',
        models: [
            { id: 'deepseek-ai/DeepSeek-V4-Flash', name: 'DeepSeek V4 Flash' },
            { id: 'Qwen/Qwen3.6-35B-A3B', name: 'Qwen 3.6 (35B-A3B)' }
        ],
        validateEndpoint: 'https://api.siliconflow.cn/v1/chat/completions',
        validateModel: 'Qwen/Qwen2.5-7B-Instruct'
    }
};

// 将用户填写的 Base URL 规范化为 OpenAI 兼容的 chat/completions 完整地址。
// 幂等：若已包含 /chat/completions 则原样返回；否则补全该路径。
function normalizeChatEndpoint(endpoint) {
    if (!endpoint || typeof endpoint !== 'string') return endpoint;
    let e = endpoint.trim().replace(/\/+$/, '');
    if (/\/chat\/completions$/i.test(e)) return e;
    return e + '/chat/completions';
}

function getAllProviders(userId) {
    const customRows = db.prepare('SELECT * FROM custom_providers WHERE user_id = ?').all(userId);
    const allProviders = { ...PROVIDERS };
    for (const row of customRows) {
        const fullEndpoint = normalizeChatEndpoint(row.api_endpoint);
        allProviders[row.id] = {
            name: row.name,
            apiEndpoint: fullEndpoint,
            defaultModel: row.default_model,
            models: row.models ? JSON.parse(row.models) : null,
            validateEndpoint: fullEndpoint,
            validateModel: row.default_model,
            isCustom: true
        };
    }
    return allProviders;
}

function getProviderConfig(provider, userId) {
    const allProviders = getAllProviders(userId);
    return allProviders[provider] || allProviders.zhipu;
}

async function validateAPIKey(apiKey, providerConfig) {
    try {
        const endpoint = providerConfig.validateEndpoint || providerConfig.apiEndpoint;
        const model = providerConfig.validateModel || providerConfig.defaultModel;
        const response = await fetch(endpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify({
                model,
                messages: [{ role: 'user', content: 'Hi' }],
                max_tokens: 1
            }),
            signal: AbortSignal.timeout(15000)
        });
        if (response.status === 401 || response.status === 403) return false;
        return response.ok || response.status === 400;
    } catch (error) {
        console.error('验证API密钥失败:', error.message);
        return false;
    }
}

// ==================== API Key Routes ====================

app.get('/api/key/status', (req, res) => {
    const rows = db.prepare('SELECT provider, masked_key, last_updated FROM api_keys WHERE user_id = ?').all(req.user.id);
    const storedKeys = {};
    for (const r of rows) {
        storedKeys[r.provider] = { hasKey: true, maskedKey: r.masked_key, lastUpdated: r.last_updated };
    }

    const allProviders = getAllProviders(req.user.id);
    const providers = {};
    for (const [key] of Object.entries(allProviders)) {
        const keyData = storedKeys[key];
        providers[key] = {
            hasKey: !!keyData?.hasKey,
            maskedKey: keyData?.maskedKey || null,
            lastUpdated: keyData?.lastUpdated || null
        };
    }

    res.json({ providers });
});

app.post('/api/key/set', async (req, res) => {
    const { apiKey, provider } = req.body;

    if (!apiKey || typeof apiKey !== 'string') {
        return res.status(400).json({ error: '请提供有效的API密钥' });
    }
    if (apiKey.length < 20) {
        return res.status(400).json({ error: 'API密钥长度不足，请检查密钥是否完整' });
    }

    const providerConfig = getProviderConfig(provider, req.user.id);

    try {
        const isValid = await validateAPIKey(apiKey, providerConfig);
        if (!isValid) {
            return res.status(400).json({ error: 'API密钥验证失败，请检查密钥是否正确' });
        }

        const encryptedKey = encrypt(apiKey);
        const maskedKey = apiKey.substring(0, 8) + '****' + apiKey.substring(apiKey.length - 4);

        db.prepare(`
            INSERT INTO api_keys (user_id, provider, encrypted_key, masked_key, last_updated)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(user_id, provider) DO UPDATE SET
                encrypted_key = excluded.encrypted_key,
                masked_key = excluded.masked_key,
                last_updated = excluded.last_updated
        `).run(req.user.id, provider, encryptedKey, maskedKey, new Date().toISOString());

        res.json({ success: true, message: `${providerConfig.name} API密钥设置成功`, maskedKey });
    } catch (error) {
        console.error('设置API密钥失败:', error);
        res.status(500).json({ error: '设置API密钥时发生错误' });
    }
});

app.post('/api/key/verify', async (req, res) => {
    const { apiKey, provider } = req.body;
    const providerConfig = getProviderConfig(provider, req.user.id);

    if (!apiKey) {
        const row = db.prepare('SELECT encrypted_key FROM api_keys WHERE user_id = ? AND provider = ?').get(req.user.id, provider);
        if (!row) {
            return res.json({ valid: false, error: '未设置API密钥' });
        }
        const decryptedKey = decrypt(row.encrypted_key);
        if (!decryptedKey) {
            return res.json({ valid: false, error: 'API密钥解密失败' });
        }
        const isValid = await validateAPIKey(decryptedKey, providerConfig);
        return res.json({ valid: isValid });
    }

    const isValid = await validateAPIKey(apiKey, providerConfig);
    res.json({ valid: isValid });
});

app.delete('/api/key', (req, res) => {
    const { provider } = req.body;

    try {
        if (provider) {
            db.prepare('DELETE FROM api_keys WHERE user_id = ? AND provider = ?').run(req.user.id, provider);
        } else {
            db.prepare('DELETE FROM api_keys WHERE user_id = ?').run(req.user.id);
        }
        res.json({ success: true, message: 'API密钥已删除' });
    } catch (error) {
        console.error('删除API密钥失败:', error);
        res.status(500).json({ error: '删除API密钥失败' });
    }
});

// ==================== Embedding（RAG 向量化）设置 Routes ====================

app.get('/api/embedding-settings', (req, res) => {
    const settings = embeddingMod.getEmbeddingSettings(req.user.id);
    const keyRow = db.prepare('SELECT masked_key FROM api_keys WHERE user_id = ? AND provider = ?')
        .get(req.user.id, embeddingMod.ALIYUN_KEY_PROVIDER);
    // 预置提供商（智谱/硅基流动）复用对话 Key，这里只报告是否已配置
    const presetKeyStatus = {};
    for (const pid of Object.keys(embeddingMod.PRESET_PROVIDERS)) {
        presetKeyStatus[pid] = !!getStoredApiKey(req.user.id, pid);
    }
    const active = embeddingMod.resolveEmbedder(req.user.id);
    res.json({
        provider: settings.provider,
        aliyun: {
            baseUrl: settings.aliyun.baseUrl || '',
            model: settings.aliyun.model || '',
            hasKey: !!(keyRow || process.env.EMBED_API_KEY),
            maskedKey: keyRow ? keyRow.masked_key : null
        },
        presetKeyStatus,
        vectorAvailable: isVecAvailable(),
        active: active ? { providerId: active.providerId, providerName: active.providerName, model: active.model } : null
    });
});

app.put('/api/embedding-settings', async (req, res) => {
    const { provider, aliyunBaseUrl, aliyunModel, aliyunApiKey } = req.body;
    try {
        embeddingMod.saveEmbeddingSettings(req.user.id, {
            provider,
            aliyun: { baseUrl: aliyunBaseUrl, model: aliyunModel }
        });

        // 可选：保存阿里云 Embedding Key（先实际调一次 embeddings 接口校验）
        if (aliyunApiKey) {
            if (typeof aliyunApiKey !== 'string' || aliyunApiKey.length < 20) {
                return res.status(400).json({ error: 'API密钥长度不足，请检查密钥是否完整' });
            }
            const settings = embeddingMod.getEmbeddingSettings(req.user.id);
            if (!settings.aliyun.baseUrl || !settings.aliyun.model) {
                return res.status(400).json({ error: '请先填写阿里云接口地址（Base URL）和模型名称' });
            }
            const testEmbedder = {
                providerId: 'aliyun',
                endpoint: settings.aliyun.baseUrl.replace(/\/+$/, '') + '/embeddings',
                model: settings.aliyun.model,
                dims: embeddingMod.EMBED_DIMS,
                apiKey: aliyunApiKey
            };
            try {
                await embeddingMod.validateEmbedder(testEmbedder);
            } catch (e) {
                return res.status(400).json({ error: `Embedding 密钥校验失败: ${e.message}` });
            }
            const encryptedKey = encrypt(aliyunApiKey);
            const maskedKey = aliyunApiKey.substring(0, 8) + '****' + aliyunApiKey.substring(aliyunApiKey.length - 4);
            db.prepare(`
                INSERT INTO api_keys (user_id, provider, encrypted_key, masked_key, last_updated)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(user_id, provider) DO UPDATE SET
                    encrypted_key = excluded.encrypted_key,
                    masked_key = excluded.masked_key,
                    last_updated = excluded.last_updated
            `).run(req.user.id, embeddingMod.ALIYUN_KEY_PROVIDER, encryptedKey, maskedKey, new Date().toISOString());
        }

        const active = embeddingMod.resolveEmbedder(req.user.id);
        res.json({
            success: true,
            active: active ? { providerId: active.providerId, providerName: active.providerName, model: active.model } : null
        });
    } catch (error) {
        res.status(400).json({ error: error.message || '保存设置失败' });
    }
});

app.delete('/api/embedding-settings/aliyun-key', (req, res) => {
    db.prepare('DELETE FROM api_keys WHERE user_id = ? AND provider = ?')
        .run(req.user.id, embeddingMod.ALIYUN_KEY_PROVIDER);
    res.json({ success: true, message: '阿里云 Embedding 密钥已删除' });
});

// ==================== Provider Routes ====================

app.get('/api/providers', (req, res) => {
    const allProviders = getAllProviders(req.user.id);
    const providerList = Object.entries(allProviders).map(([key, value]) => ({
        id: key,
        name: value.name,
        defaultModel: value.defaultModel,
        models: value.models || null,
        isCustom: value.isCustom || false
    }));
    res.json({ providers: providerList });
});

function generateProviderId(name, userId) {
    let baseId = name.toLowerCase()
        .replace(/[^a-z0-9]/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
        .substring(0, 30);

    if (!baseId) baseId = 'custom-provider';

    let id = baseId;
    let counter = 2;
    while (PROVIDERS[id] || db.prepare('SELECT 1 FROM custom_providers WHERE id = ? AND user_id = ?').get(id, userId)) {
        id = `${baseId}-${counter}`;
        counter++;
    }
    return id;
}

app.post('/api/providers', async (req, res) => {
    const { id: providedId, name, apiEndpoint, defaultModel, models, apiKey } = req.body;

    if (!name || !apiEndpoint || !defaultModel || !apiKey) {
        return res.status(400).json({ error: '请提供完整的提供商信息（name, apiEndpoint, defaultModel, apiKey）' });
    }
    if (apiKey.length < 20) {
        return res.status(400).json({ error: 'API密钥长度不足，请检查密钥是否完整' });
    }

    const idRegex = /^[a-z0-9_-]+$/;
    const id = providedId ? providedId.toLowerCase() : generateProviderId(name, req.user.id);

    if (!idRegex.test(id)) {
        return res.status(400).json({ error: '提供商ID包含非法字符' });
    }
    if (PROVIDERS[id]) {
        return res.status(400).json({ error: '该提供商ID与内置提供商冲突，请修改名称或联系管理员' });
    }

    const existing = db.prepare('SELECT 1 FROM custom_providers WHERE id = ? AND user_id = ?').get(id, req.user.id);
    if (existing) {
        return res.status(400).json({ error: '已存在相同名称的提供商，请修改名称' });
    }

    const tempProviderConfig = {
        name, apiEndpoint, defaultModel,
        validateEndpoint: normalizeChatEndpoint(apiEndpoint), validateModel: defaultModel
    };

    try {
        const isValid = await validateAPIKey(apiKey, tempProviderConfig);
        if (!isValid) {
            return res.status(400).json({ error: 'API密钥验证失败，请检查密钥和API地址是否正确' });
        }

        const insertProvider = db.prepare('INSERT INTO custom_providers (id, user_id, name, api_endpoint, default_model, models, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
        insertProvider.run(id, req.user.id, name, apiEndpoint, defaultModel, models ? JSON.stringify(models) : null, new Date().toISOString());

        const encryptedKey = encrypt(apiKey);
        const maskedKey = apiKey.substring(0, 8) + '****' + apiKey.substring(apiKey.length - 4);
        db.prepare(`
            INSERT INTO api_keys (user_id, provider, encrypted_key, masked_key, last_updated)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(user_id, provider) DO UPDATE SET
                encrypted_key = excluded.encrypted_key, masked_key = excluded.masked_key, last_updated = excluded.last_updated
        `).run(req.user.id, id, encryptedKey, maskedKey, new Date().toISOString());

        res.json({
            success: true, message: '自定义提供商添加成功',
            provider: { id, name, api_endpoint: apiEndpoint, default_model: defaultModel, models: models || null, isCustom: true }
        });
    } catch (error) {
        console.error('验证自定义提供商API密钥失败:', error);
        db.prepare('DELETE FROM custom_providers WHERE id = ? AND user_id = ?').run(id, req.user.id);
        res.status(500).json({ error: '验证API密钥时发生错误' });
    }
});

app.put('/api/providers/:id', (req, res) => {
    const { id } = req.params;
    const { name, apiEndpoint, defaultModel, models } = req.body;

    const row = db.prepare('SELECT * FROM custom_providers WHERE id = ? AND user_id = ?').get(id, req.user.id);
    if (!row) {
        return res.status(404).json({ error: '自定义提供商不存在' });
    }

    db.prepare(`
        UPDATE custom_providers SET name = ?, api_endpoint = ?, default_model = ?, models = ?, updated_at = ?
        WHERE id = ? AND user_id = ?
    `).run(
        name || row.name, apiEndpoint || row.api_endpoint, defaultModel || row.default_model,
        models !== undefined ? (models ? JSON.stringify(models) : null) : row.models,
        new Date().toISOString(), id, req.user.id
    );

    res.json({
        success: true, message: '自定义提供商更新成功',
        provider: { id, name: name || row.name, api_endpoint: apiEndpoint || row.api_endpoint, default_model: defaultModel || row.default_model, models: models !== undefined ? models : (row.models ? JSON.parse(row.models) : null), isCustom: true }
    });
});

app.delete('/api/providers/:id', (req, res) => {
    const { id } = req.params;

    const row = db.prepare('SELECT 1 FROM custom_providers WHERE id = ? AND user_id = ?').get(id, req.user.id);
    if (!row) {
        return res.status(404).json({ error: '自定义提供商不存在' });
    }

    db.prepare('DELETE FROM custom_providers WHERE id = ? AND user_id = ?').run(id, req.user.id);
    db.prepare('DELETE FROM api_keys WHERE user_id = ? AND provider = ?').run(req.user.id, id);

    res.json({ success: true, message: '自定义提供商已删除' });
});

// ==================== Book Routes ====================

app.post('/api/books/upload', (req, res) => {
    upload.single('book')(req, res, (err) => {
        if (err) {
            if (err.code === 'LIMIT_FILE_SIZE') {
                return res.status(400).json({ error: `文件大小超过限制，最大允许 ${formatFileSize(MAX_FILE_SIZE)}` });
            }
            return res.status(400).json({ error: err.message });
        }

        if (!req.file) {
            return res.status(400).json({ error: '请选择要上传的文件' });
        }

        const validation = validateFile(req.file);
        if (!validation.valid) {
            fs.unlinkSync(req.file.path);
            return res.status(400).json({ error: validation.error });
        }

        let originalName = req.file.originalname;
        try {
            originalName = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
        } catch (e) {}

        const bookId = path.basename(req.file.filename, path.extname(req.file.filename));
        const ext = getFileExtension(originalName);

        const bookMeta = {
            id: bookId,
            title: path.basename(originalName, ext),
            filename: req.file.filename,
            originalName: originalName,
            format: ext.substring(1).toUpperCase(),
            size: req.file.size,
            sizeFormatted: formatFileSize(req.file.size),
            uploadTime: new Date().toISOString(),
            userId: req.user.id,
            author: '未知',
            lastRead: null,
            readProgress: 0
        };

        db.prepare(`
            INSERT INTO books_meta (id, user_id, title, filename, original_name, format, size, size_formatted, upload_time, author)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(bookId, req.user.id, bookMeta.title, req.file.filename, originalName, bookMeta.format, req.file.size, bookMeta.sizeFormatted, bookMeta.uploadTime, '未知');

        res.json({ success: true, message: '书籍上传成功', book: bookMeta });
    });
});

app.get('/api/books', (req, res) => {
    // Auto-add default books for users who don't have them
    addDefaultBooksForUser(req.user.id);

    const rows = db.prepare('SELECT * FROM books_meta WHERE user_id = ? ORDER BY upload_time DESC').all(req.user.id);
    const booksList = rows.map(r => ({
        id: r.id, title: r.title, filename: r.filename, original_name: r.original_name,
        originalName: r.original_name, format: r.format, size: r.size, size_formatted: r.size_formatted,
        sizeFormatted: r.size_formatted, upload_time: r.upload_time, uploadTime: r.upload_time,
        author: r.author, last_read: r.last_read, lastRead: r.last_read,
        read_progress: r.read_progress, readProgress: r.read_progress, userId: r.user_id
    }));
    res.json({ books: booksList });
});

app.get('/api/books/:id', (req, res) => {
    const bookId = req.params.id;
    const row = db.prepare('SELECT * FROM books_meta WHERE id = ? AND user_id = ?').get(bookId, req.user.id);

    if (!row) {
        return res.status(404).json({ error: '书籍不存在' });
    }

    const book = {
        id: row.id, title: row.title, filename: row.filename, originalName: row.original_name,
        format: row.format, size: row.size, sizeFormatted: row.size_formatted,
        uploadTime: row.upload_time, author: row.author, lastRead: row.last_read, readProgress: row.read_progress
    };

    const filePath = path.join(BOOKS_DIR, req.user.id, row.filename);
    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: '书籍文件不存在' });
    }

    db.prepare('UPDATE books_meta SET last_read = ? WHERE id = ? AND user_id = ?').run(new Date().toISOString(), bookId, req.user.id);

    if (row.format.toLowerCase() === 'txt') {
        try {
            const content = readTextFileWithEncoding(filePath);
            res.json({ book, content });
        } catch (error) {
            console.error('读取书籍内容失败:', error);
            res.status(500).json({ error: '读取书籍内容失败' });
        }
    } else {
        res.json({ book, downloadUrl: `/api/books/${bookId}/download` });
    }
});

app.get('/api/books/:id/download', (req, res) => {
    const bookId = req.params.id;
    const row = db.prepare('SELECT * FROM books_meta WHERE id = ? AND user_id = ?').get(bookId, req.user.id);

    if (!row) {
        return res.status(404).json({ error: '书籍不存在' });
    }

    const filePath = path.join(BOOKS_DIR, req.user.id, row.filename);
    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: '书籍文件不存在' });
    }

    res.download(filePath, row.original_name);
});

app.delete('/api/books/:id', (req, res) => {
    const bookId = req.params.id;
    const row = db.prepare('SELECT * FROM books_meta WHERE id = ? AND user_id = ?').get(bookId, req.user.id);

    if (!row) {
        return res.status(404).json({ error: '书籍不存在' });
    }

    const filePath = path.join(BOOKS_DIR, req.user.id, row.filename);
    try {
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
        db.prepare('DELETE FROM books_meta WHERE id = ? AND user_id = ?').run(bookId, req.user.id);
        // 一并清理该书的 AI 任务结果缓存与 RAG 索引
        db.prepare('DELETE FROM task_results WHERE book_id = ? AND user_id = ?').run(bookId, req.user.id);
        try { rag.deleteIndex(req.user.id, bookId); } catch (e) {}
        res.json({ success: true, message: '书籍已删除' });
    } catch (error) {
        console.error('删除书籍失败:', error);
        res.status(500).json({ error: '删除书籍失败' });
    }
});

app.put('/api/books/:id/progress', (req, res) => {
    const userId = req.user.id;
    const bookId = req.params.id;
    const { progress } = req.body;

    const row = db.prepare('SELECT id FROM books_meta WHERE id = ? AND user_id = ?').get(bookId, userId);
    if (!row) {
        return res.status(404).json({ error: '书籍不存在' });
    }

    db.prepare('UPDATE books_meta SET read_progress = ?, last_read = ? WHERE id = ? AND user_id = ?')
        .run(progress, new Date().toISOString(), bookId, userId);

    res.json({ success: true });
});

// ==================== History Routes ====================

app.get('/api/history', (req, res) => {
    const rows = db.prepare(
        'SELECT id, selected_text, question, answer, created_at FROM history WHERE user_id = ? ORDER BY created_at DESC LIMIT 50'
    ).all(req.user.id);

    const historyList = rows.map(r => ({
        id: r.id,
        text: r.selected_text || '',
        question: r.question,
        answer: r.answer,
        time: r.created_at
    }));

    res.json({ history: historyList });
});

app.post('/api/history', (req, res) => {
    const { text, question, answer } = req.body;

    if (!question || !answer) {
        return res.status(400).json({ error: '缺少必要参数' });
    }

    db.prepare(
        'INSERT INTO history (user_id, selected_text, question, answer) VALUES (?, ?, ?, ?)'
    ).run(req.user.id, text || '', question, answer);

    res.json({ success: true });
});

app.delete('/api/history', (req, res) => {
    db.prepare('DELETE FROM history WHERE user_id = ?').run(req.user.id);
    res.json({ success: true, message: '历史记录已清空' });
});

app.post('/api/ask', async (req, res) => {
    const { text, question, bookName, provider, model: clientModel } = req.body;
    
    if (!text || !question) {
        return res.status(400).json({ error: '请提供选中的文本和问题' });
    }

    const providerId = provider || 'zhipu';
    const providerConfig = getProviderConfig(providerId, req.user.id);
    const storedKeysRows = db.prepare('SELECT provider, encrypted_key, masked_key FROM api_keys WHERE user_id = ?').all(req.user.id);
    const storedKeys = {};
    for (const r of storedKeysRows) { storedKeys[r.provider] = { encryptedApiKey: r.encrypted_key, maskedKey: r.masked_key }; }
    
    console.log(`[DEBUG] 请求提供商: ${providerId}`);
    console.log(`[DEBUG] 存储的密钥结构:`, Object.keys(storedKeys));
    
    const keyData = storedKeys[providerId] || (providerId === 'zhipu' && storedKeys.encryptedApiKey ? storedKeys : null);
    let apiKey = null;
    
    if (keyData?.encryptedApiKey) {
        console.log(`[DEBUG] 找到密钥: ${keyData.maskedKey || '未知'}`);
        apiKey = decrypt(keyData.encryptedApiKey);
        console.log(`[DEBUG] 解密结果: ${apiKey ? apiKey.substring(0, 10) + '...' : '失败(null)'}`);
    } else {
        console.log(`[DEBUG] 未找到${providerId}的密钥`);
    }
    
    if (!apiKey) {
        const envKeyMap = { zhipu: 'ZHIPU_API_KEY', siliconflow: 'SILICONFLOW_API_KEY' };
        apiKey = process.env[envKeyMap[providerId]] || process.env.AI_API_KEY;
        if (apiKey) {
            console.log(`[DEBUG] 从环境变量获取密钥: ${envKeyMap[providerId] || 'AI_API_KEY'}`);
        }
        if (!apiKey && providerId.startsWith('custom')) {
            apiKey = process.env.CUSTOM_API_KEY;
            if (apiKey) {
                console.log(`[DEBUG] 从环境变量获取自定义提供商密钥: CUSTOM_API_KEY`);
            }
        }
    }

    if (!apiKey) {
        return res.status(403).json({ 
            error: `未配置${providerConfig.name}的API密钥`,
            needApiKey: true,
            provider: providerId,
            message: `请先设置${providerConfig.name}的API密钥`
        });
    }

    try {
        const { answer, model } = await callAI(apiKey, text, question, bookName, providerConfig, clientModel);
        res.json({ 
            answer,
            model,
            provider: providerConfig.name
        });
    } catch (error) {
        console.error('AI调用错误:', error);
        
        if (error.message && (error.message.includes('401') || error.message.includes('认证'))) {
            return res.status(401).json({ 
                error: 'API密钥无效或已过期',
                needApiKey: true,
                provider: providerId
            });
        }
        
        res.status(500).json({ error: `AI服务请求失败: ${error.message || '未知错误'}` });
    }
});

app.post('/api/ask-stream', async (req, res) => {
    const { text, question, bookName, provider, model: clientModel, bookId, conversationId } = req.body;
    
    if (!question) {
        return res.status(400).json({ error: '请提供问题' });
    }

    const providerId = provider || 'zhipu';
    const providerConfig = getProviderConfig(providerId, req.user.id);
    const storedKeysRows = db.prepare('SELECT provider, encrypted_key, masked_key FROM api_keys WHERE user_id = ?').all(req.user.id);
    const storedKeys = {};
    for (const r of storedKeysRows) { storedKeys[r.provider] = { encryptedApiKey: r.encrypted_key, maskedKey: r.masked_key }; }
    
    const keyData = storedKeys[providerId] || (providerId === 'zhipu' && storedKeys.encryptedApiKey ? storedKeys : null);
    let apiKey = null;
    
    if (keyData?.encryptedApiKey) {
        apiKey = decrypt(keyData.encryptedApiKey);
    }
    
    if (!apiKey) {
        const envKeyMap = { zhipu: 'ZHIPU_API_KEY', siliconflow: 'SILICONFLOW_API_KEY' };
        apiKey = process.env[envKeyMap[providerId]] || process.env.AI_API_KEY;
        if (!apiKey && providerId.startsWith('custom')) {
            apiKey = process.env.CUSTOM_API_KEY;
        }
    }

    if (!apiKey) {
        return res.status(403).json({ 
            error: `未配置${providerConfig.name}的API密钥`,
            needApiKey: true,
            provider: providerId
        });
    }

    try {
        const model = clientModel || process.env.AI_MODEL || providerConfig.defaultModel;
        const contextLimit = conv.getModelContextLimit(model);
        const bookContext = bookName ? `用户正在阅读的书籍：《${bookName}》\n` : '';
        const apiEndpoint = providerConfig.apiEndpoint;

        // ==================== 会话上下文准备 ====================
        const ctxLLM = { apiKey, providerConfig, model };
        let conversation = conversationId
            ? conv.getConversation(req.user.id, conversationId)
            : null;
        if (!conversation) {
            conversation = conv.getOrCreateActiveConversation(req.user.id, bookId || null, providerId, model);
        }

        const baseSystemPrompt = `你是一个专业的阅读助手，擅长帮助用户理解和分析书籍内容。你当前使用的模型是：${model}。请遵循以下原则：
1. 如果用户的问题可以直接基于选中的文本回答，请优先依据原文内容作答
2. 如果用户正在阅读一本已知的书籍（如名著、经典作品），你可以利用自己对该书的了解来回答问题，但必须明确标注哪些是原文内容、哪些是你补充的原著知识
3. 如果问题与选中文本无关，但你根据书名能够回答，请直接回答，并注明"根据原著"或"根据相关知识"
4. 回答要条理清晰，重点突出，使用分点或段落组织内容
5. 对于复杂概念，用通俗易懂的语言解释，必要时举例说明
6. 不要拒绝回答，尽量给出有帮助的信息
7. 保持客观中立，尊重原著内容
8. 当用户询问你是什么模型、是谁、使用什么技术时，如实告知用户你当前使用的模型名称（${model}）`;

        const userContent = text
            ? `${bookContext}选中的文本：\n"${text}"\n\n问题：${question}`
            : `${bookContext}问题：${question}`;

        // 落盘用户消息 + 设置标题
        conv.appendMessage(conversation.id, { role: 'user', content: userContent });
        conv.maybeSetTitle(conversation.id, question);

        // 检索长期记忆 + 组装携带历史的 messages
        const memoriesText = conv.formatMemoriesBlock(conv.retrieveMemories(req.user.id, question, 6));
        const freshConv = conv.getConversation(req.user.id, conversation.id);
        const messages = conv.buildModelMessages(freshConv, baseSystemPrompt, { memoriesText });

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 60000);

        const response = await fetch(apiEndpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify({
                model,
                messages,
                temperature: 0.3,
                max_tokens: 2000,
                stream: true
            }),
            signal: controller.signal
        });

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            console.error(`${providerConfig.name} API错误:`, response.status, errorData);
            clearTimeout(timeout);
            return res.status(response.status).json({ error: `API请求失败: ${response.status}`, provider: providerId });
        }

        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');

        res.write(`data: ${JSON.stringify({ type: 'start', model, provider: providerConfig.name, conversationId: conversation.id, tokens: freshConv.token_estimate, limit: contextLimit })}\n\n`);

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let fullContent = '';

        // 对话结束后的持久化 + 后处理（压缩 / 记忆抽取），返回最新 token 统计
        const finalize = async () => {
            conv.appendMessage(conversation.id, { role: 'assistant', content: fullContent });
            try {
                const c2 = conv.getConversation(req.user.id, conversation.id);
                const compressResult = await conv.maybeAutoCompress(ctxLLM, c2);
                if (compressResult.compressed) {
                    res.write(`data: ${JSON.stringify({ type: 'compressed', before: compressResult.before, after: compressResult.after, saved: Math.max(0, compressResult.before - compressResult.after), tokens: compressResult.after, limit: contextLimit, auto: true })}\n\n`);
                }
            } catch (e) { console.warn('自动压缩失败:', e.message); }
            // 记忆抽取（异步，不阻塞响应结束）
            const recent = conv.getConversationMessages(conversation.id, { windowOnly: true }).slice(-6);
            conv.extractAndStoreMemories(ctxLLM, req.user.id, conversation.id, recent)
                .catch(e => console.warn('记忆抽取失败:', e.message));
            return conv.getConversation(req.user.id, conversation.id).token_estimate;
        };

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                if (line.startsWith('data: ')) {
                    const dataStr = line.slice(6);
                    if (dataStr.trim() === '[DONE]') {
                        const finalTokens = await finalize();
                        res.write(`data: ${JSON.stringify({ type: 'session_update', tokens: finalTokens, limit: contextLimit })}\n\n`);
                        res.write(`data: ${JSON.stringify({ type: 'end', content: fullContent, conversationId: conversation.id })}\n\n`);
                        res.end();
                        clearTimeout(timeout);
                        return;
                    }
                    try {
                        const parsed = JSON.parse(dataStr);
                        const content = parsed.choices?.[0]?.delta?.content || '';
                        if (content) {
                            fullContent += content;
                            res.write(`data: ${JSON.stringify({ type: 'chunk', content })}\n\n`);
                        }
                    } catch (e) {}
                }
            }
        }

        const finalTokens = await finalize();
        res.write(`data: ${JSON.stringify({ type: 'session_update', tokens: finalTokens, limit: contextLimit })}\n\n`);
        res.write(`data: ${JSON.stringify({ type: 'end', content: fullContent, conversationId: conversation.id })}\n\n`);
        res.end();
        clearTimeout(timeout);
    } catch (error) {
        console.error('流式AI调用错误:', error);
        if (!res.headersSent) {
            res.status(500).json({ error: `AI服务请求失败: ${error.message || '未知错误'}` });
        } else {
            res.write(`data: ${JSON.stringify({ type: 'error', error: error.message || '未知错误' })}\n\n`);
            res.end();
        }
    }
});

async function callAI(apiKey, selectedText, question, bookName, providerConfig, clientModel) {
    const apiEndpoint = providerConfig.apiEndpoint;
    const model = clientModel || process.env.AI_MODEL || providerConfig.defaultModel;
    const bookContext = bookName ? `用户正在阅读的书籍：《${bookName}》\n` : '';

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60000);

    const response = await fetch(apiEndpoint, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
            model,
            messages: [
                {
                    role: 'system',
                    content: `你是一个专业的阅读助手，擅长帮助用户理解和分析书籍内容。你当前使用的模型是：${model}。请遵循以下原则：
1. 如果用户的问题可以直接基于选中的文本回答，请优先依据原文内容作答
2. 如果用户正在阅读一本已知的书籍（如名著、经典作品），你可以利用自己对该书的了解来回答问题，但必须明确标注哪些是原文内容、哪些是你补充的原著知识
3. 如果问题与选中文本无关，但你根据书名能够回答，请直接回答，并注明"根据原著"或"根据相关知识"
4. 回答要条理清晰，重点突出，使用分点或段落组织内容
5. 对于复杂概念，用通俗易懂的语言解释，必要时举例说明
6. 不要拒绝回答，尽量给出有帮助的信息
7. 保持客观中立，尊重原著内容
8. 当用户询问你是什么模型、是谁、使用什么技术时，如实告知用户你当前使用的模型名称（${model}）`
                },
                {
                    role: 'user',
                    content: `${bookContext}选中的文本：\n"${selectedText}"\n\n问题：${question}`
                }
            ],
            temperature: 0.3,
            max_tokens: 2000
        }),
        signal: controller.signal
    });

    clearTimeout(timeout);

    if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        console.error(`${providerConfig.name} API错误:`, response.status, errorData);
        if (response.status === 401) throw new Error('API密钥认证失败');
        throw new Error(`API请求失败: ${response.status}`);
    }

    const data = await response.json();
    return { answer: data.choices[0].message.content, model };
}

// ==================== Agent Routes (Function Calling + RAG + Multi-Agent) ====================

// 解析用户某 provider 的 API Key
function resolveApiKey(userId, providerId) {
    const storedKeysRows = db.prepare('SELECT provider, encrypted_key FROM api_keys WHERE user_id = ?').all(userId);
    const storedKeys = {};
    for (const r of storedKeysRows) storedKeys[r.provider] = r.encrypted_key;
    let apiKey = null;
    if (storedKeys[providerId]) {
        apiKey = decrypt(storedKeys[providerId]);
    }
    if (!apiKey) {
        const envKeyMap = { zhipu: 'ZHIPU_API_KEY', siliconflow: 'SILICONFLOW_API_KEY' };
        apiKey = process.env[envKeyMap[providerId]] || process.env.AI_API_KEY;
        if (!apiKey && providerId.startsWith('custom')) apiKey = process.env.CUSTOM_API_KEY;
    }
    return apiKey;
}

// 读取书籍全文（仅 TXT 支持智能索引/工具）
function getBookContent(userId, bookId) {
    const row = db.prepare('SELECT * FROM books_meta WHERE id = ? AND user_id = ?').get(bookId, userId);
    if (!row) return null;
    const filePath = path.join(BOOKS_DIR, userId, row.filename);
    if (!fs.existsSync(filePath)) return null;
    if (row.format.toLowerCase() !== 'txt') return { book: row, content: null, supported: false };
    try {
        const content = readTextFileWithEncoding(filePath);
        return { book: row, content, supported: true };
    } catch (e) {
        return null;
    }
}

// RAG 索引状态
app.get('/api/books/:id/index-status', (req, res) => {
    res.json(rag.getIndexStatus(req.user.id, req.params.id));
});

// 触发 RAG 索引
app.post('/api/books/:id/index', async (req, res) => {
    const bookId = req.params.id;
    const data = getBookContent(req.user.id, bookId);
    if (!data) return res.status(404).json({ error: '书籍不存在或无法读取' });
    if (!data.supported) return res.status(400).json({ error: '当前仅支持 TXT 格式的智能索引' });

    // 按用户 Embedding 设置解析向量化提供商（不可用则纯 BM25）
    const embedder = embeddingMod.resolveEmbedder(req.user.id);
    try {
        const result = await rag.indexBook({
            bookId, userId: req.user.id, content: data.content, embedder
        });
        res.json({ success: true, ...result });
    } catch (e) {
        res.status(500).json({ error: `索引失败: ${e.message}` });
    }
});

// 删除 RAG 索引
app.delete('/api/books/:id/index', (req, res) => {
    rag.deleteIndex(req.user.id, req.params.id);
    res.json({ success: true });
});

// Agent 流式问答（Function Calling + ReAct）
app.post('/api/agent/stream', async (req, res) => {
    const { text, question, bookName, provider, model: clientModel, bookId, conversationId } = req.body;
    if (!question) return res.status(400).json({ error: '请提供问题' });

    const providerId = provider || 'zhipu';
    const providerConfig = getProviderConfig(providerId, req.user.id);
    const apiKey = resolveApiKey(req.user.id, providerId);
    if (!apiKey) {
        return res.status(403).json({ error: `未配置${providerConfig.name}的API密钥`, needApiKey: true, provider: providerId });
    }

    // 获取书籍内容（供 Agent 工具使用）
    let bookContent = text || '';
    let ctxBookId = bookId || null;
    let ctxBookName = bookName || '';
    if (bookId) {
        const data = getBookContent(req.user.id, bookId);
        if (data && data.supported) {
            bookContent = data.content;
            ctxBookName = ctxBookName || data.book.title;
        }
    }

    const model = clientModel || process.env.AI_MODEL || providerConfig.defaultModel;
    const contextLimit = conv.getModelContextLimit(model);
    const systemPrompt = `你是一个专业的阅读助手 Agent，具备工具调用能力，可以自主决定调用工具来查阅书籍内容。当前书籍：《${ctxBookName}》。

可用工具（仅用于检索书中信息）：
- searchInBook：在全书检索相关段落（RAG）
- getChapterInfo：获取指定章节内容
- lookupCharacter：查找人物出场信息

工作原则：
1. 翻译、总结、解释、改写等任务直接回答，绝对不要调用工具
2. 若问题可基于选中文本或你已有知识直接回答，直接回答（不必调用工具）
3. 仅当需要查阅书中其他部分（如人物出场、其他章节内容、全书检索）时，才调用工具
4. 调用工具后，结合工具返回结果组织最终答案
5. 回答条理清晰，标注信息来源（选中文本/全书检索/章节内容）
6. 避免冗余工具调用，能一次检索解决的不要多次检索
7. 当用户询问模型信息，如实告知当前模型：${model}`;

    const userMessage = text
        ? `选中的文本：\n"${text}"\n\n问题：${question}`
        : `问题：${question}${ctxBookName ? `\n（关于《${ctxBookName}》）` : ''}`;

    // ==================== 会话上下文准备 ====================
    const ctxLLM = { apiKey, providerConfig, model };
    let conversation = conversationId ? conv.getConversation(req.user.id, conversationId) : null;
    if (!conversation) {
        conversation = conv.getOrCreateActiveConversation(req.user.id, ctxBookId, providerId, model);
    }
    conv.appendMessage(conversation.id, { role: 'user', content: userMessage });
    conv.maybeSetTitle(conversation.id, question);

    // 携带历史 + 长期记忆组装 messages（工具调用产生的中间消息不落盘，仅在本轮循环内使用）
    const memoriesText = conv.formatMemoriesBlock(conv.retrieveMemories(req.user.id, question, 6));
    const freshConv = conv.getConversation(req.user.id, conversation.id);
    const messages = conv.buildModelMessages(freshConv, systemPrompt, { memoriesText });

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    res.write(`data: ${JSON.stringify({ type: 'session', conversationId: conversation.id, tokens: freshConv.token_estimate, limit: contextLimit })}\n\n`);

    try {
        const result = await runAgentLoop({
            apiKey, providerConfig, model, providerId,
            systemPrompt, userMessage, messages,
            context: { bookId: ctxBookId, userId: req.user.id, content: bookContent },
            onEvent: (event) => {
                res.write(`data: ${JSON.stringify(event)}\n\n`);
            }
        });

        // 落盘最终回答 + 后处理（压缩 / 记忆抽取）
        if (result && result.content) {
            conv.appendMessage(conversation.id, { role: 'assistant', content: result.content });
            try {
                const c2 = conv.getConversation(req.user.id, conversation.id);
                const compressResult = await conv.maybeAutoCompress(ctxLLM, c2);
                if (compressResult.compressed) {
                    res.write(`data: ${JSON.stringify({ type: 'compressed', before: compressResult.before, after: compressResult.after, saved: Math.max(0, compressResult.before - compressResult.after), tokens: compressResult.after, limit: contextLimit, auto: true })}\n\n`);
                }
            } catch (e) { console.warn('自动压缩失败:', e.message); }
            const recent = conv.getConversationMessages(conversation.id, { windowOnly: true }).slice(-6);
            conv.extractAndStoreMemories(ctxLLM, req.user.id, conversation.id, recent)
                .catch(e => console.warn('记忆抽取失败:', e.message));
        }
        const finalTokens = conv.getConversation(req.user.id, conversation.id).token_estimate;
        res.write(`data: ${JSON.stringify({ type: 'session_update', tokens: finalTokens, limit: contextLimit })}\n\n`);
        res.end();
    } catch (error) {
        console.error('Agent 流式错误:', error);
        if (!res.headersSent) {
            res.status(500).json({ error: `Agent 服务失败: ${error.message}` });
        } else {
            res.write(`data: ${JSON.stringify({ type: 'error', error: error.message })}\n\n`);
            res.end();
        }
    }
});

// Multi-Agent 任务列表
app.get('/api/agent/tasks', (req, res) => {
    res.json({ tasks: listTasks() });
});

// 查询已保存的任务结果（读书笔记/人物分析）
app.get('/api/agent/task/result', (req, res) => {
    const { bookId, taskType } = req.query;
    if (!bookId || !taskType) return res.status(400).json({ error: '缺少 bookId 或 taskType' });
    const row = db.prepare('SELECT content, task_type, updated_at FROM task_results WHERE user_id = ? AND book_id = ? AND task_type = ?')
        .get(req.user.id, bookId, taskType);
    if (!row) return res.json({ result: null });
    res.json({ result: { content: row.content, taskType: row.task_type, updatedAt: row.updated_at } });
});

// 删除已保存的任务结果
app.delete('/api/agent/task/result', (req, res) => {
    const { bookId, taskType } = req.query;
    if (!bookId || !taskType) return res.status(400).json({ error: '缺少 bookId 或 taskType' });
    db.prepare('DELETE FROM task_results WHERE user_id = ? AND book_id = ? AND task_type = ?')
        .run(req.user.id, bookId, taskType);
    res.json({ success: true });
});

// Multi-Agent 任务执行（SSE 进度推送）
app.post('/api/agent/task', async (req, res) => {
    const { taskType, bookId, provider, model: clientModel } = req.body;
    if (!taskType) return res.status(400).json({ error: '请提供 taskType' });
    if (!bookId) return res.status(400).json({ error: '请提供 bookId' });

    const providerId = provider || 'zhipu';
    const providerConfig = getProviderConfig(providerId, req.user.id);
    const apiKey = resolveApiKey(req.user.id, providerId);
    if (!apiKey) {
        return res.status(403).json({ error: `未配置${providerConfig.name}的API密钥`, needApiKey: true, provider: providerId });
    }

    const data = getBookContent(req.user.id, bookId);
    if (!data || !data.supported) {
        return res.status(400).json({ error: '书籍不存在或暂不支持该格式（仅支持 TXT）' });
    }

    const model = clientModel || process.env.AI_MODEL || providerConfig.defaultModel;

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    try {
        const result = await runTask(taskType, {
            bookId, userId: req.user.id, content: data.content,
            bookName: data.book.title, apiKey, providerConfig, model, providerId
        }, (event) => {
            res.write(`data: ${JSON.stringify(event)}\n\n`);
        });
        // 持久化任务产出（下次点击可直接复用，无需重新生成）
        const finalContent = (result.final && (result.final.note || result.final.report)) || '';
        if (finalContent) {
            try {
                db.prepare(`INSERT INTO task_results (user_id, book_id, task_type, content, created_at, updated_at)
                    VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))
                    ON CONFLICT(user_id, book_id, task_type) DO UPDATE SET content = excluded.content, updated_at = datetime('now')`)
                    .run(req.user.id, bookId, taskType, finalContent);
            } catch (e) { console.warn('保存任务结果失败:', e.message); }
        }
        res.write(`data: ${JSON.stringify({ type: 'result', final: result.final, outputs: result.outputs })}\n\n`);
        res.end();
    } catch (error) {
        console.error('Multi-Agent 任务错误:', error);
        if (!res.headersSent) {
            res.status(500).json({ error: `任务执行失败: ${error.message}` });
        } else {
            res.write(`data: ${JSON.stringify({ type: 'error', error: error.message })}\n\n`);
            res.end();
        }
    }
});

// ==================== Conversation Routes (会话管理) ====================

// 列出会话（可按书籍过滤）
app.get('/api/conversations', (req, res) => {
    const bookId = req.query.bookId || null;
    const list = conv.listConversations(req.user.id, bookId).map(c => ({
        id: c.id, bookId: c.book_id, title: c.title, status: c.status,
        tokenEstimate: c.token_estimate, provider: c.provider, model: c.model,
        createdAt: c.created_at, updatedAt: c.updated_at,
        hasSummary: !!(c.summary && c.summary.length)
    }));
    res.json({ conversations: list });
});

// 获取/创建某本书的 active 会话
app.get('/api/conversations/active', (req, res) => {
    const bookId = req.query.bookId || null;
    const c = conv.getOrCreateActiveConversation(req.user.id, bookId, null, null);
    res.json({
        conversation: {
            id: c.id, bookId: c.book_id, title: c.title, status: c.status,
            tokenEstimate: c.token_estimate, model: c.model, provider: c.provider,
            contextLimit: conv.getModelContextLimit(c.model),
            hasSummary: !!(c.summary && c.summary.length)
        }
    });
});

// 新建对话（归档该书旧的 active）
app.post('/api/conversations', (req, res) => {
    const { bookId, provider, model } = req.body;
    const c = conv.createConversation(req.user.id, bookId || null, provider || null, model || null);
    res.json({
        conversation: {
            id: c.id, bookId: c.book_id, title: c.title, status: c.status,
            tokenEstimate: c.token_estimate, model: c.model, provider: c.provider,
            contextLimit: conv.getModelContextLimit(c.model)
        }
    });
});

// 获取会话消息（用于前端回显；默认仅返回工作窗口内消息）
app.get('/api/conversations/:id/messages', (req, res) => {
    const c = conv.getConversation(req.user.id, req.params.id);
    if (!c) return res.status(404).json({ error: '会话不存在' });
    const windowOnly = req.query.all !== '1';
    const rows = conv.getConversationMessages(c.id, { windowOnly });
    const messages = rows
        .filter(m => m.role === 'user' || m.role === 'assistant')
        .map(m => ({ role: m.role, content: m.content, seq: m.seq, inWindow: !!m.in_window, createdAt: m.created_at }));
    res.json({
        conversation: { id: c.id, title: c.title, summary: c.summary, tokenEstimate: c.token_estimate, model: c.model, contextLimit: conv.getModelContextLimit(c.model) },
        messages
    });
});

// 手动压缩上下文
app.post('/api/conversations/:id/compress', async (req, res) => {
    const c = conv.getConversation(req.user.id, req.params.id);
    if (!c) return res.status(404).json({ error: '会话不存在' });

    const providerId = c.provider || req.body.provider || 'zhipu';
    const providerConfig = getProviderConfig(providerId, req.user.id);
    const apiKey = resolveApiKey(req.user.id, providerId);
    if (!apiKey) return res.status(403).json({ error: `未配置${providerConfig.name}的API密钥`, needApiKey: true, provider: providerId });

    try {
        const result = await conv.compressConversation({ apiKey, providerConfig, model: c.model }, c);
        res.json({ success: true, ...result });
    } catch (e) {
        res.status(500).json({ error: `压缩失败: ${e.message}` });
    }
});

// 删除会话
app.delete('/api/conversations/:id', (req, res) => {
    const c = conv.getConversation(req.user.id, req.params.id);
    if (!c) return res.status(404).json({ error: '会话不存在' });
    conv.deleteConversation(req.user.id, req.params.id);
    res.json({ success: true });
});

// ==================== Memory Routes (长期记忆) ====================

app.get('/api/memories', (req, res) => {
    res.json({ memories: conv.listMemories(req.user.id) });
});

app.delete('/api/memories/:id', (req, res) => {
    conv.deleteMemory(req.user.id, Number(req.params.id));
    res.json({ success: true });
});

app.delete('/api/memories', (req, res) => {
    conv.deleteAllMemories(req.user.id);
    res.json({ success: true });
});

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

    app.listen(PORT, () => {
        console.log(`🚀 AI阅读助手服务器已启动`);
        console.log(`📖 访问地址: http://localhost:${PORT}`);
        console.log(`📚 书籍存储目录: ${BOOKS_DIR}`);
        console.log(`📁 支持格式: ${ALLOWED_EXTENSIONS.join(', ')}`);
        console.log(`⚖️ 文件大小限制: ${formatFileSize(MAX_FILE_SIZE)}`);
    });
    
}

startServer().catch(err => {
    console.error("Server startup failed:", err);
    process.exit(1);
});