const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const { v4: uuidv4 } = require('uuid');
const iconv = require('iconv-lite');
const jschardet = require('jschardet');
require('dotenv').config();

const logger = require('./logger');
const { initDB, getDB } = require('./database');
const { authMiddleware, registerHandler, loginHandler, meHandler } = require('./auth');

const log = logger.child('server');

const app = express();
const PORT = process.env.PORT || 3000;
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
const ENCRYPTION_KEY_PERSISTED = !!process.env.ENCRYPTION_KEY;
const BOOKS_DIR = path.join(__dirname, 'books');

const ALLOWED_EXTENSIONS = ['.txt', '.pdf', '.epub', '.mobi'];
const MAX_FILE_SIZE = 50 * 1024 * 1024;

// ==================== Rate Limiters ====================
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 分钟
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: '登录/注册尝试过于频繁，请稍后再试' }
});

const aiLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 分钟
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'AI 请求过于频繁，请稍后再试' }
});

const uploadLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: '上传过于频繁，请稍后再试' }
});

if (!fs.existsSync(BOOKS_DIR)) {
    fs.mkdirSync(BOOKS_DIR, { recursive: true });
}

let db;

async function startServer() {
    db = await initDB();

app.use(cors({
    origin: IS_PRODUCTION ? false : true, // 生产环境同源策略，仅开发环境允许跨域
    credentials: false
}));
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// 统一错误处理：捕获 JSON 解析失败、payload 过大等
app.use((err, req, res, next) => {
    if (err.type === 'entity.too.large') {
        return res.status(413).json({ error: '请求体过大' });
    }
    if (err.type === 'entity.parse.failed') {
        return res.status(400).json({ error: '请求体 JSON 格式错误' });
    }
    log.error('未处理错误:', err);
    res.status(500).json({ error: '服务器内部错误' });
});

app.post('/api/auth/register', authLimiter, registerHandler);
app.post('/api/auth/login', authLimiter, loginHandler);

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
        log.error('解密失败:', error);
        return null;
    }
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

function getAllProviders(userId) {
    const customRows = db.prepare('SELECT * FROM custom_providers WHERE user_id = ?').all(userId);
    const allProviders = { ...PROVIDERS };
    for (const row of customRows) {
        allProviders[row.id] = {
            name: row.name,
            apiEndpoint: row.api_endpoint,
            defaultModel: row.default_model,
            models: row.models ? JSON.parse(row.models) : null,
            validateEndpoint: row.api_endpoint,
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
        log.error('验证API密钥失败:', error.message);
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

app.post('/api/key/set', aiLimiter, async (req, res) => {
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
        log.error('设置API密钥失败:', error);
        res.status(500).json({ error: '设置API密钥时发生错误' });
    }
});

app.post('/api/key/verify', aiLimiter, async (req, res) => {
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
        log.error('删除API密钥失败:', error);
        res.status(500).json({ error: '删除API密钥失败' });
    }
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

app.post('/api/providers', aiLimiter, async (req, res) => {
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
        validateEndpoint: apiEndpoint, validateModel: defaultModel
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
        log.error('验证自定义提供商API密钥失败:', error);
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

app.post('/api/books/upload', uploadLimiter, (req, res) => {
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
            log.error('读取书籍内容失败:', error);
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
        res.json({ success: true, message: '书籍已删除' });
    } catch (error) {
        log.error('删除书籍失败:', error);
        res.status(500).json({ error: '删除书籍失败' });
    }
});

app.put('/api/books/:id/progress', (req, res) => {
    const bookId = req.params.id;
    const { progress } = req.body;

    if (typeof progress !== 'number' || progress < 0 || progress > 100) {
        return res.status(400).json({ error: '进度值必须为 0-100 之间的数字' });
    }

    const row = db.prepare('SELECT 1 FROM books_meta WHERE id = ? AND user_id = ?').get(bookId, req.user.id);
    if (!row) {
        return res.status(404).json({ error: '书籍不存在' });
    }

    db.prepare(`
        UPDATE books_meta SET read_progress = ?, last_read = ?
        WHERE id = ? AND user_id = ?
    `).run(progress, new Date().toISOString(), bookId, req.user.id);

    res.json({ success: true });
});

// ==================== Ask Routes ====================

function getApiKeyForUser(userId, providerId) {
    const row = db.prepare('SELECT encrypted_key FROM api_keys WHERE user_id = ? AND provider = ?').get(userId, providerId);
    if (row) {
        const decrypted = decrypt(row.encrypted_key);
        if (decrypted) return { apiKey: decrypted, source: 'db' };
    }
    const envKeyMap = { zhipu: 'ZHIPU_API_KEY', siliconflow: 'SILICONFLOW_API_KEY' };
    const envKey = process.env[envKeyMap[providerId]] || process.env.AI_API_KEY;
    if (envKey) return { apiKey: envKey, source: 'env' };
    if (providerId.startsWith('custom') && process.env.CUSTOM_API_KEY) {
        return { apiKey: process.env.CUSTOM_API_KEY, source: 'env' };
    }
    return { apiKey: null, source: null };
}

function buildAIRequestBody({ model, text, question, bookName, stream }) {
    const bookContext = bookName ? `用户正在阅读的书籍：《${bookName}》\n` : '';
    const body = {
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
                content: `${bookContext}选中的文本：\n"${text}"\n\n问题：${question}`
            }
        ],
        temperature: 0.3,
        max_tokens: 2000
    };
    if (stream) body.stream = true;
    return body;
}

app.post('/api/ask', aiLimiter, async (req, res) => {
    const { text, question, bookName, provider, model: clientModel } = req.body;

    if (!text || !question) {
        return res.status(400).json({ error: '请提供选中的文本和问题' });
    }
    if (typeof text !== 'string' || typeof question !== 'string') {
        return res.status(400).json({ error: '参数类型错误' });
    }
    if (text.length > 50000 || question.length > 2000) {
        return res.status(400).json({ error: '文本或问题过长' });
    }

    const providerId = provider || 'zhipu';
    const providerConfig = getProviderConfig(providerId, req.user.id);

    const { apiKey } = getApiKeyForUser(req.user.id, providerId);
    if (!apiKey) {
        return res.status(403).json({
            error: `未配置${providerConfig.name}的API密钥`,
            needApiKey: true,
            provider: providerId,
            message: `请先设置${providerConfig.name}的API密钥`
        });
    }

    const model = clientModel || providerConfig.defaultModel;

    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 60000);

        const response = await fetch(providerConfig.apiEndpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify(buildAIRequestBody({ model, text, question, bookName, stream: false })),
            signal: controller.signal
        });
        clearTimeout(timer);

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            log.error(`${providerConfig.name} API错误:`, response.status, errorData);
            if (response.status === 401 || response.status === 403) {
                return res.status(401).json({
                    error: 'API密钥无效或已过期',
                    needApiKey: true,
                    provider: providerId
                });
            }
            return res.status(response.status).json({ error: `API请求失败: ${response.status}` });
        }

        const data = await response.json();
        res.json({
            answer: data.choices?.[0]?.message?.content || '',
            model,
            provider: providerConfig.name
        });
    } catch (error) {
        log.error('AI调用错误:', error);
        res.status(500).json({ error: `AI服务请求失败: ${error.message || '未知错误'}` });
    }
});

app.post('/api/ask-stream', aiLimiter, async (req, res) => {
    const { text, question, bookName, provider, model: clientModel } = req.body;

    if (!text || !question) {
        return res.status(400).json({ error: '请提供选中的文本和问题' });
    }
    if (typeof text !== 'string' || typeof question !== 'string') {
        return res.status(400).json({ error: '参数类型错误' });
    }
    if (text.length > 50000 || question.length > 2000) {
        return res.status(400).json({ error: '文本或问题过长' });
    }

    const providerId = provider || 'zhipu';
    const providerConfig = getProviderConfig(providerId, req.user.id);

    const { apiKey } = getApiKeyForUser(req.user.id, providerId);
    if (!apiKey) {
        return res.status(403).json({
            error: `未配置${providerConfig.name}的API密钥`,
            needApiKey: true,
            provider: providerId
        });
    }

    const model = clientModel || providerConfig.defaultModel;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60000);

    // 跟踪 SSE 状态，避免在已发送 header 后再调 res.status().json()
    let sseStarted = false;
    const startSse = () => {
        if (sseStarted) return;
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        res.flushHeaders?.();
        sseStarted = true;
    };

    // 客户端断开时主动中止上游请求
    let clientClosed = false;
    req.on('close', () => {
        clientClosed = true;
        controller.abort();
    });

    try {
        const response = await fetch(providerConfig.apiEndpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify(buildAIRequestBody({ model, text, question, bookName, stream: true })),
            signal: controller.signal
        });

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            log.error(`${providerConfig.name} API错误:`, response.status, errorData);
            clearTimeout(timer);
            if (response.status === 401 || response.status === 403) {
                return res.status(401).json({
                    error: 'API密钥无效或已过期',
                    needApiKey: true,
                    provider: providerId
                });
            }
            return res.status(response.status).json({ error: `API请求失败: ${response.status}` });
        }

        startSse();
        res.write(`data: ${JSON.stringify({ type: 'start', model, provider: providerConfig.name })}\n\n`);

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let fullContent = '';

        while (!clientClosed) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                const dataStr = line.slice(6);
                if (dataStr.trim() === '[DONE]') {
                    res.write(`data: ${JSON.stringify({ type: 'end', content: fullContent })}\n\n`);
                    res.end();
                    clearTimeout(timer);
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

        res.write(`data: ${JSON.stringify({ type: 'end', content: fullContent })}\n\n`);
        res.end();
        clearTimeout(timer);
    } catch (error) {
        log.error('流式AI调用错误:', error);
        clearTimeout(timer);
        if (!sseStarted) {
            res.status(500).json({ error: `AI服务请求失败: ${error.message || '未知错误'}` });
        } else if (!res.writableEnded) {
            try {
                res.write(`data: ${JSON.stringify({ type: 'error', error: error.message || '未知错误' })}\n\n`);
                res.end();
            } catch (_) {}
        }
    }
});

// ==================== History Routes ====================

// 单用户最多保留 200 条历史记录
const HISTORY_MAX_PER_USER = 200;

app.post('/api/history', aiLimiter, (req, res) => {
    const { text, question, answer } = req.body;

    if (!question || !answer || typeof question !== 'string' || typeof answer !== 'string') {
        return res.status(400).json({ error: 'question 和 answer 为必填字符串' });
    }
    if (question.length > 2000 || answer.length > 20000) {
        return res.status(400).json({ error: 'question 或 answer 过长' });
    }
    if (text && (typeof text !== 'string' || text.length > 50000)) {
        return res.status(400).json({ error: 'text 字段类型或长度错误' });
    }

    // 超出上限时删除最旧的
    const count = db.prepare('SELECT COUNT(*) as n FROM history WHERE user_id = ?').get(req.user.id).n;
    if (count >= HISTORY_MAX_PER_USER) {
        db.prepare(`
            DELETE FROM history WHERE id IN (
                SELECT id FROM history WHERE user_id = ?
                ORDER BY created_at ASC LIMIT ?
            )
        `).run(req.user.id, count - HISTORY_MAX_PER_USER + 1);
    }

    const result = db.prepare(`
        INSERT INTO history (user_id, selected_text, question, answer)
        VALUES (?, ?, ?, ?)
    `).run(req.user.id, text || null, question, answer);

    res.json({ success: true, id: result.lastInsertRowid });
});

app.get('/api/history', (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 50, HISTORY_MAX_PER_USER);
    const offset = parseInt(req.query.offset) || 0;

    const rows = db.prepare(`
        SELECT id, selected_text as text, question, answer, created_at
        FROM history
        WHERE user_id = ?
        ORDER BY created_at DESC, id DESC
        LIMIT ? OFFSET ?
    `).all(req.user.id, limit, offset);

    res.json({
        history: rows.map(r => ({
            id: r.id,
            text: r.text || '',
            question: r.question,
            answer: r.answer,
            time: r.created_at
        })),
        limit,
        offset,
        hasMore: rows.length === limit
    });
});

app.delete('/api/history', (req, res) => {
    const { id } = req.body;
    if (id) {
        const result = db.prepare('DELETE FROM history WHERE id = ? AND user_id = ?').run(id, req.user.id);
        return res.json({ success: true, deleted: result.changes });
    }
    const result = db.prepare('DELETE FROM history WHERE user_id = ?').run(req.user.id);
    res.json({ success: true, deleted: result.changes });
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

        // 启动时安全警告：未持久化的密钥会导致重启后数据无法解密
        if (!ENCRYPTION_KEY_PERSISTED) {
            console.warn('\n⚠️  [安全警告] ENCRYPTION_KEY 未在 .env 中配置');
            console.warn('   当前为每次启动自动生成，所有用户已加密的 API Key 在重启后将无法解密！');
            console.warn('   建议在 .env 中设置一个 64 位十六进制的 ENCRYPTION_KEY 并妥善保存。\n');
        }
        if (!process.env.JWT_SECRET) {
            console.warn('⚠️  [安全警告] JWT_SECRET 未在 .env 中配置');
            console.warn('   当前为每次启动自动生成，所有已签发的 token 在重启后将立即失效。\n');
        }
    });
    
}

startServer().catch(err => {
    log.error("Server startup failed:", err);
    process.exit(1);
});

// 优雅退出：确保内存中的数据库写入落盘
function gracefulShutdown(signal) {
    console.log(`\n收到 ${signal}，正在关闭...`);
    try {
        db?.flush?.();
        db?.close?.();
    } catch (e) {
        log.error('关闭数据库时出错:', e.message);
    }
    process.exit(0);
}
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));