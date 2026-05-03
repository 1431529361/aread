const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const cookieParser = require('cookie-parser');
const iconv = require('iconv-lite');
const jschardet = require('jschardet');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
const KEY_STORAGE_PATH = path.join(__dirname, '.api_keys.json');
const BOOKS_DIR = path.join(__dirname, 'books');
const BOOKS_META_PATH = path.join(__dirname, '.books_meta.json');
const USERS_PATH = path.join(__dirname, '.users.json');
const CUSTOM_PROVIDERS_PATH = path.join(__dirname, '.custom_providers.json');

const ALLOWED_EXTENSIONS = ['.txt', '.pdf', '.epub', '.mobi'];
const MAX_FILE_SIZE = 50 * 1024 * 1024;

if (!fs.existsSync(BOOKS_DIR)) {
    fs.mkdirSync(BOOKS_DIR, { recursive: true });
}

app.use(cors());
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

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

function getUserId(req) {
    let userId = req.cookies.userId;
    if (!userId) {
        userId = uuidv4();
    }
    return userId;
}

function setUserIdCookie(res, userId) {
    res.cookie('userId', userId, {
        maxAge: 365 * 24 * 60 * 60 * 1000,
        httpOnly: true,
        sameSite: 'lax'
    });
}

function loadStoredKeys() {
    try {
        if (fs.existsSync(KEY_STORAGE_PATH)) {
            const data = fs.readFileSync(KEY_STORAGE_PATH, 'utf8');
            return JSON.parse(data);
        }
    } catch (error) {
        console.error('加载密钥失败:', error);
    }
    return {};
}

function saveStoredKeys(keys) {
    try {
        fs.writeFileSync(KEY_STORAGE_PATH, JSON.stringify(keys, null, 2));
        return true;
    } catch (error) {
        console.error('保存密钥失败:', error);
        return false;
    }
}

function loadBooksMeta() {
    try {
        if (fs.existsSync(BOOKS_META_PATH)) {
            const data = fs.readFileSync(BOOKS_META_PATH, 'utf8');
            return JSON.parse(data);
        }
    } catch (error) {
        console.error('加载书籍元数据失败:', error);
    }
    return {};
}

function saveBooksMeta(meta) {
    try {
        fs.writeFileSync(BOOKS_META_PATH, JSON.stringify(meta, null, 2));
        return true;
    } catch (error) {
        console.error('保存书籍元数据失败:', error);
        return false;
    }
}

function loadCustomProviders() {
    try {
        if (fs.existsSync(CUSTOM_PROVIDERS_PATH)) {
            const data = fs.readFileSync(CUSTOM_PROVIDERS_PATH, 'utf8');
            return JSON.parse(data);
        }
    } catch (error) {
        console.error('加载自定义提供商失败:', error);
    }
    return {};
}

function saveCustomProviders(providers) {
    try {
        fs.writeFileSync(CUSTOM_PROVIDERS_PATH, JSON.stringify(providers, null, 2));
        return true;
    } catch (error) {
        console.error('保存自定义提供商失败:', error);
        return false;
    }
}

function getAllProviders() {
    const customProviders = loadCustomProviders();
    const allProviders = { ...PROVIDERS };
    
    for (const [key, value] of Object.entries(customProviders)) {
        allProviders[key] = {
            name: value.name,
            apiEndpoint: value.apiEndpoint,
            defaultModel: value.defaultModel,
            models: value.models || null,
            validateEndpoint: value.apiEndpoint,
            validateModel: value.defaultModel,
            isCustom: true
        };
    }
    
    return allProviders;
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
        'GB2312': 'gbk',
        'GB18030': 'gbk',
        'gb2312': 'gbk',
        'gb18030': 'gbk',
        'BIG5': 'big5',
        'big5': 'big5',
        'UTF-8': 'utf-8',
        'utf-8': 'utf-8',
        'UTF-16LE': 'utf-16le',
        'UTF-16BE': 'utf-16be',
        'ascii': 'utf-8',
        'ASCII': 'utf-8'
    };
    
    encoding = encodingMap[encoding] || encoding;
    
    if (encoding.toLowerCase() === 'utf-8' || encoding.toLowerCase() === 'utf8') {
        const hasBOM = buffer.length >= 3 && 
            buffer[0] === 0xEF && 
            buffer[1] === 0xBB && 
            buffer[2] === 0xBF;
        
        if (hasBOM) {
            return buffer.slice(3).toString('utf-8');
        }
        
        try {
            const content = buffer.toString('utf-8');
            const replacementChar = content.indexOf('\uFFFD');
            if (replacementChar === -1) {
                return content;
            }
        } catch (e) {
        }
    }
    
    try {
        const content = iconv.decode(buffer, encoding);
        return content;
    } catch (error) {
        console.error('解码失败，尝试其他编码:', error);
        
        const fallbackEncodings = ['utf-8', 'gbk', 'gb18030', 'big5', 'utf-16le'];
        for (const enc of fallbackEncodings) {
            try {
                const content = iconv.decode(buffer, enc);
                const hasReplacement = content.indexOf('\uFFFD') !== -1;
                if (!hasReplacement) {
                    console.log(`使用 ${enc} 编码成功解码`);
                    return content;
                }
            } catch (e) {
                continue;
            }
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
    
    const dangerousPatterns = [/<script/i, /javascript:/i, /on\w+=/i];
    return { valid: true };
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const userId = getUserId(req);
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

function getProviderConfig(provider) {
    const allProviders = getAllProviders();
    return allProviders[provider] || allProviders.zhipu;
}

app.get('/api/key/status', (req, res) => {
    const storedKeys = loadStoredKeys();
    const allProviders = getAllProviders();
    
    const providers = {};
    for (const [key, value] of Object.entries(allProviders)) {
        // 兼容旧格式（智谱密钥存在根级别）
        let keyData = storedKeys[key];
        if (!keyData && key === 'zhipu' && storedKeys.encryptedApiKey) {
            keyData = storedKeys;
        }
        providers[key] = {
            hasKey: !!keyData?.encryptedApiKey,
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

    const providerConfig = getProviderConfig(provider);

    try {
        const isValid = await validateAPIKey(apiKey, providerConfig);
        
        if (!isValid) {
            return res.status(400).json({ error: 'API密钥验证失败，请检查密钥是否正确' });
        }

        const encryptedKey = encrypt(apiKey);
        const maskedKey = apiKey.substring(0, 8) + '****' + apiKey.substring(apiKey.length - 4);
        
        const storedKeys = loadStoredKeys();
        storedKeys[provider] = {
            encryptedApiKey: encryptedKey,
            maskedKey: maskedKey,
            lastUpdated: new Date().toISOString()
        };
        
        saveStoredKeys(storedKeys);
        
        res.json({ 
            success: true, 
            message: `${providerConfig.name} API密钥设置成功`,
            maskedKey: maskedKey
        });
    } catch (error) {
        console.error('设置API密钥失败:', error);
        res.status(500).json({ error: '设置API密钥时发生错误' });
    }
});

app.post('/api/key/verify', async (req, res) => {
    const { apiKey, provider } = req.body;
    const providerConfig = getProviderConfig(provider);
    
    if (!apiKey) {
        const storedKeys = loadStoredKeys();
        let keyData = storedKeys[provider];
        if (provider === 'zhipu' && !keyData && storedKeys.encryptedApiKey) {
            keyData = storedKeys;
        }
        if (!keyData?.encryptedApiKey) {
            return res.json({ valid: false, error: '未设置API密钥' });
        }
        const decryptedKey = decrypt(keyData.encryptedApiKey);
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
        const storedKeys = loadStoredKeys();
        if (provider) {
            delete storedKeys[provider];
        } else {
            const allProviders = getAllProviders();
            for (const key of Object.keys(allProviders)) {
                delete storedKeys[key];
            }
        }
        saveStoredKeys(storedKeys);
        res.json({ success: true, message: 'API密钥已删除' });
    } catch (error) {
        console.error('删除API密钥失败:', error);
        res.status(500).json({ error: '删除API密钥失败' });
    }
});

app.get('/api/providers', (req, res) => {
    const allProviders = getAllProviders();
    const providerList = Object.entries(allProviders).map(([key, value]) => ({
        id: key,
        name: value.name,
        defaultModel: value.defaultModel,
        models: value.models || null,
        isCustom: value.isCustom || false
    }));
    res.json({ providers: providerList });
});

function generateProviderId(name) {
    let baseId = name.toLowerCase()
        .replace(/[^a-z0-9]/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
        .substring(0, 30);

    if (!baseId) {
        baseId = 'custom-provider';
    }

    const customProviders = loadCustomProviders();

    let id = baseId;
    let counter = 2;
    while (PROVIDERS[id] || customProviders[id]) {
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

    const id = providedId
        ? providedId.toLowerCase()
        : generateProviderId(name);

    if (!idRegex.test(id)) {
        return res.status(400).json({ error: '提供商ID包含非法字符' });
    }

    if (PROVIDERS[id]) {
        return res.status(400).json({ error: '该提供商ID与内置提供商冲突，请修改名称或联系管理员' });
    }

    const customProviders = loadCustomProviders();

    if (customProviders[id]) {
        return res.status(400).json({ error: '已存在相同名称的提供商，请修改名称' });
    }

    const providerData = {
        name,
        apiEndpoint,
        defaultModel,
        models: models || null,
        createdAt: new Date().toISOString()
    };

    customProviders[id] = providerData;

    if (!saveCustomProviders(customProviders)) {
        return res.status(500).json({ error: '保存自定义提供商失败' });
    }

    // 验证并保存 API 密钥
    const tempProviderConfig = {
        name,
        apiEndpoint,
        defaultModel,
        validateEndpoint: apiEndpoint,
        validateModel: defaultModel
    };

    try {
        const isValid = await validateAPIKey(apiKey, tempProviderConfig);

        if (!isValid) {
            // 验证失败，回滚提供商添加
            delete customProviders[id];
            saveCustomProviders(customProviders);
            return res.status(400).json({ error: 'API密钥验证失败，请检查密钥和API地址是否正确' });
        }

        const encryptedKey = encrypt(apiKey);
        const maskedKey = apiKey.substring(0, 8) + '****' + apiKey.substring(apiKey.length - 4);

        const storedKeys = loadStoredKeys();
        storedKeys[id] = {
            encryptedApiKey: encryptedKey,
            maskedKey: maskedKey,
            lastUpdated: new Date().toISOString()
        };
        saveStoredKeys(storedKeys);

        res.json({
            success: true,
            message: '自定义提供商添加成功',
            provider: {
                id,
                ...providerData,
                isCustom: true
            }
        });
    } catch (error) {
        console.error('验证自定义提供商API密钥失败:', error);
        // 回滚提供商添加
        delete customProviders[id];
        saveCustomProviders(customProviders);
        res.status(500).json({ error: '验证API密钥时发生错误' });
    }
});

app.put('/api/providers/:id', (req, res) => {
    const { id } = req.params;
    const { name, apiEndpoint, defaultModel, models } = req.body;

    const customProviders = loadCustomProviders();

    if (!customProviders[id]) {
        return res.status(404).json({ error: '自定义提供商不存在' });
    }

    if (name) customProviders[id].name = name;
    if (apiEndpoint) customProviders[id].apiEndpoint = apiEndpoint;
    if (defaultModel) customProviders[id].defaultModel = defaultModel;
    if (models !== undefined) customProviders[id].models = models;
    customProviders[id].updatedAt = new Date().toISOString();

    if (saveCustomProviders(customProviders)) {
        res.json({
            success: true,
            message: '自定义提供商更新成功',
            provider: {
                id,
                ...customProviders[id],
                isCustom: true
            }
        });
    } else {
        res.status(500).json({ error: '保存自定义提供商失败' });
    }
});

app.delete('/api/providers/:id', (req, res) => {
    const { id } = req.params;
    const customProviders = loadCustomProviders();

    if (!customProviders[id]) {
        return res.status(404).json({ error: '自定义提供商不存在' });
    }

    delete customProviders[id];

    // 同时删除该提供商的API密钥
    const storedKeys = loadStoredKeys();
    if (storedKeys[id]) {
        delete storedKeys[id];
        saveStoredKeys(storedKeys);
    }

    if (saveCustomProviders(customProviders)) {
        res.json({ success: true, message: '自定义提供商已删除' });
    } else {
        res.status(500).json({ error: '删除自定义提供商失败' });
    }
});

async function validateAPIKey(apiKey, providerConfig) {
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 30000);

        console.log(`[DEBUG] 验证API密钥: ${providerConfig.name}`);
        console.log(`[DEBUG] 验证端点: ${providerConfig.validateEndpoint}`);
        console.log(`[DEBUG] 验证模型: ${providerConfig.validateModel}`);
        console.log(`[DEBUG] API密钥: ${apiKey.substring(0, 8)}****${apiKey.substring(apiKey.length - 4)}`);

        const response = await fetch(providerConfig.validateEndpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify({
                model: providerConfig.validateModel,
                messages: [{ role: 'user', content: 'Hi' }],
                max_tokens: 5
            }),
            signal: controller.signal
        });

        clearTimeout(timeout);
        console.log(`[DEBUG] 验证响应状态: ${response.status}`);
        
        if (response.ok) {
            console.log('[DEBUG] 验证成功');
            return true;
        }

        const errorBody = await response.json().catch(() => null);
        console.log(`[DEBUG] 错误响应:`, JSON.stringify(errorBody));
        
        // 400 可能是模型不存在或其他参数错误，但密钥有效
        if (response.status === 400) {
            if (errorBody && errorBody.message && errorBody.message.includes('key')) {
                console.log('[DEBUG] 密钥无效（400且包含key错误）');
                return false;
            }
            console.log('[DEBUG] 验证通过（400但不是密钥问题）');
            return true;
        }
        
        // 404 可能是模型不存在，尝试用通用模型重试
        if (response.status === 404) {
            console.log('[DEBUG] 验证时模型可能不存在，使用通用模型重试');
            const retryController = new AbortController();
            const retryTimeout = setTimeout(() => retryController.abort(), 30000);

            const retryResponse = await fetch(providerConfig.validateEndpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${apiKey}`
                },
                body: JSON.stringify({
                    model: 'gpt-3.5-turbo',
                    messages: [{ role: 'user', content: 'Hi' }],
                    max_tokens: 5
                }),
                signal: retryController.signal
            });

            clearTimeout(retryTimeout);
            console.log(`[DEBUG] 重试响应状态: ${retryResponse.status}`);
            return retryResponse.ok || retryResponse.status === 400;
        }
        
        // 401 明确表示密钥无效
        if (response.status === 401) {
            console.log('[DEBUG] 密钥认证失败（401）');
        }
        
        return false;
    } catch (error) {
        console.error('[DEBUG] 验证API密钥异常:', error.message);
        return false;
    }
}

app.post('/api/books/upload', (req, res) => {
    const userId = getUserId(req);
    setUserIdCookie(res, userId);
    
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
        } catch (e) {
            console.log('文件名编码转换失败，使用原始文件名');
        }
        
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
            userId: userId,
            author: '未知',
            lastRead: null,
            readProgress: 0
        };
        
        const allBooks = loadBooksMeta();
        if (!allBooks[userId]) {
            allBooks[userId] = {};
        }
        allBooks[userId][bookId] = bookMeta;
        saveBooksMeta(allBooks);
        
        res.json({
            success: true,
            message: '书籍上传成功',
            book: bookMeta
        });
    });
});

app.get('/api/books', (req, res) => {
    const userId = getUserId(req);
    setUserIdCookie(res, userId);
    
    const allBooks = loadBooksMeta();
    const userBooks = allBooks[userId] || {};
    
    const booksList = Object.values(userBooks).sort((a, b) => 
        new Date(b.uploadTime) - new Date(a.uploadTime)
    );
    
    res.json({ books: booksList });
});

app.get('/api/books/:id', (req, res) => {
    const userId = getUserId(req);
    const bookId = req.params.id;
    
    const allBooks = loadBooksMeta();
    const userBooks = allBooks[userId];
    
    if (!userBooks || !userBooks[bookId]) {
        return res.status(404).json({ error: '书籍不存在' });
    }
    
    const book = userBooks[bookId];
    const filePath = path.join(BOOKS_DIR, userId, book.filename);
    
    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: '书籍文件不存在' });
    }
    
    book.lastRead = new Date().toISOString();
    allBooks[userId][bookId] = book;
    saveBooksMeta(allBooks);
    
    if (book.format.toLowerCase() === 'txt') {
        try {
            const content = readTextFileWithEncoding(filePath);
            res.json({
                book: book,
                content: content
            });
        } catch (error) {
            console.error('读取书籍内容失败:', error);
            res.status(500).json({ error: '读取书籍内容失败' });
        }
    } else {
        res.json({
            book: book,
            downloadUrl: `/api/books/${bookId}/download`
        });
    }
});

app.get('/api/books/:id/download', (req, res) => {
    const userId = getUserId(req);
    const bookId = req.params.id;
    
    const allBooks = loadBooksMeta();
    const userBooks = allBooks[userId];
    
    if (!userBooks || !userBooks[bookId]) {
        return res.status(404).json({ error: '书籍不存在' });
    }
    
    const book = userBooks[bookId];
    const filePath = path.join(BOOKS_DIR, userId, book.filename);
    
    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: '书籍文件不存在' });
    }
    
    res.download(filePath, book.originalName);
});

app.delete('/api/books/:id', (req, res) => {
    const userId = getUserId(req);
    const bookId = req.params.id;
    
    const allBooks = loadBooksMeta();
    const userBooks = allBooks[userId];
    
    if (!userBooks || !userBooks[bookId]) {
        return res.status(404).json({ error: '书籍不存在' });
    }
    
    const book = userBooks[bookId];
    const filePath = path.join(BOOKS_DIR, userId, book.filename);
    
    try {
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
        
        delete allBooks[userId][bookId];
        saveBooksMeta(allBooks);
        
        res.json({ success: true, message: '书籍已删除' });
    } catch (error) {
        console.error('删除书籍失败:', error);
        res.status(500).json({ error: '删除书籍失败' });
    }
});

app.put('/api/books/:id/progress', (req, res) => {
    const userId = getUserId(req);
    const bookId = req.params.id;
    const { progress } = req.body;
    
    const allBooks = loadBooksMeta();
    const userBooks = allBooks[userId];
    
    if (!userBooks || !userBooks[bookId]) {
        return res.status(404).json({ error: '书籍不存在' });
    }
    
    allBooks[userId][bookId].readProgress = progress;
    allBooks[userId][bookId].lastRead = new Date().toISOString();
    saveBooksMeta(allBooks);
    
    res.json({ success: true });
});

app.post('/api/ask', async (req, res) => {
    const { text, question, bookName, provider } = req.body;
    
    if (!text || !question) {
        return res.status(400).json({ error: '请提供选中的文本和问题' });
    }

    const providerId = provider || 'zhipu';
    const providerConfig = getProviderConfig(providerId);
    const storedKeys = loadStoredKeys();
    
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
            console.log(`[DEBUG] 从环境变量获取密钥: ${envKeyMap[providerId]}`);
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
        const { answer, model } = await callAI(apiKey, text, question, bookName, providerConfig);
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
    const { text, question, bookName, provider, model: clientModel } = req.body;
    
    if (!text || !question) {
        return res.status(400).json({ error: '请提供选中的文本和问题' });
    }

    const providerId = provider || 'zhipu';
    const providerConfig = getProviderConfig(providerId);
    const storedKeys = loadStoredKeys();
    
    const keyData = storedKeys[providerId] || (providerId === 'zhipu' && storedKeys.encryptedApiKey ? storedKeys : null);
    let apiKey = null;
    
    if (keyData?.encryptedApiKey) {
        apiKey = decrypt(keyData.encryptedApiKey);
    }
    
    if (!apiKey) {
        const envKeyMap = { zhipu: 'ZHIPU_API_KEY', siliconflow: 'SILICONFLOW_API_KEY' };
        apiKey = process.env[envKeyMap[providerId]] || process.env.AI_API_KEY;
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
        const bookContext = bookName ? `用户正在阅读的书籍：《${bookName}》\n` : '';
        const apiEndpoint = providerConfig.apiEndpoint;

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 60000);

        const response = await fetch(apiEndpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify({
                model: model,
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
                max_tokens: 2000,
                stream: true
            }),
            signal: controller.signal
        });

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            console.error(`${providerConfig.name} API错误:`, response.status, errorData);
            clearTimeout(timeout);
            return res.status(response.status).json({ 
                error: `API请求失败: ${response.status}`,
                provider: providerId
            });
        }

        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');

        res.write(`data: ${JSON.stringify({ type: 'start', model, provider: providerConfig.name })}\n\n`);

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let fullContent = '';

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
                        res.write(`data: ${JSON.stringify({ type: 'end', content: fullContent })}\n\n`);
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
                    } catch (e) {
                    }
                }
            }
        }

        res.write(`data: ${JSON.stringify({ type: 'end', content: fullContent })}\n\n`);
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

async function callAI(apiKey, selectedText, question, bookName, providerConfig) {
    const apiEndpoint = providerConfig.apiEndpoint;
    const model = process.env.AI_MODEL || providerConfig.defaultModel;

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
            model: model,
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
        
        if (response.status === 401) {
            throw new Error('API密钥认证失败');
        }
        throw new Error(`API请求失败: ${response.status}`);
    }

    const data = await response.json();
    return {
        answer: data.choices[0].message.content,
        model: model
    };
}

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
