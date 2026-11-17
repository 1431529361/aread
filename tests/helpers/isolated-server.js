/**
 * 隔离服务运行器：在操作系统临时目录启动独立 server.js 子进程。
 * - READER_DATA_ROOT 指向临时数据根（database/books/rag_index 全部隔离）
 * - DOTENV_CONFIG_PATH 指向临时空 .env，不加载仓库真实 .env
 * - 清除供应商 Key 环境变量，使用临时 JWT/加密密钥
 * - 不关闭生产鉴权；测试结束仅终止本轮子进程并清理本轮临时目录
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const crypto = require('crypto');

const REPO_ROOT = path.join(__dirname, '..', '..');

const SCRUB_ENV_KEYS = [
    'ZHIPU_API_KEY', 'SILICONFLOW_API_KEY', 'AI_API_KEY', 'CUSTOM_API_KEY',
    'EMBED_API_KEY', 'EMBED_BASE_URL', 'EMBED_MODEL_NAME', 'AI_MODEL',
    'READER_DATA_ROOT', 'DOTENV_CONFIG_PATH'
];

function getFreePort() {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.unref();
        srv.on('error', reject);
        srv.listen(0, '127.0.0.1', () => {
            const port = srv.address().port;
            srv.close(() => resolve(port));
        });
    });
}

async function waitForReady(url, child, logs, timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs;
    let exited = false;
    child.once('exit', () => { exited = true; });
    while (Date.now() < deadline) {
        if (exited) throw new Error(`隔离服务提前退出:\n${logs.join('')}`);
        try {
            const res = await fetch(`${url}/api/auth/me`, { signal: AbortSignal.timeout(1000) });
            if (res.status === 401 || res.ok) return;
        } catch {}
        await new Promise(r => setTimeout(r, 150));
    }
    throw new Error(`隔离服务启动超时:\n${logs.join('')}`);
}

async function startIsolatedServer({ keepKeys = false, extraEnv = {} } = {}) {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-p0-'));
    if (dataRoot.toLowerCase().startsWith(REPO_ROOT.toLowerCase())) {
        throw new Error(`临时数据根不得位于仓库内: ${dataRoot}`);
    }
    fs.writeFileSync(path.join(dataRoot, '.env'), '');
    const port = await getFreePort();
    const url = `http://127.0.0.1:${port}`;

    const env = { ...process.env };
    if (!keepKeys) {
        for (const k of SCRUB_ENV_KEYS) delete env[k];
    } else {
        // 在线基线：保留供应商凭据，但仍隔离数据根与 .env
        delete env.READER_DATA_ROOT;
        delete env.DOTENV_CONFIG_PATH;
    }
    Object.assign(env, extraEnv);
    env.READER_DATA_ROOT = dataRoot;
    env.DOTENV_CONFIG_PATH = path.join(dataRoot, '.env');
    env.JWT_SECRET = 'p0-test-jwt-' + crypto.randomBytes(8).toString('hex');
    env.ENCRYPTION_KEY = extraEnv.ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
    env.PORT = String(port);

    const logs = [];
    const child = spawn(process.execPath, [path.join(REPO_ROOT, 'server.js')], {
        env,
        cwd: REPO_ROOT,
        stdio: ['ignore', 'pipe', 'pipe']
    });
    child.stdout.on('data', d => logs.push(d.toString()));
    child.stderr.on('data', d => logs.push(d.toString()));

    await waitForReady(url, child, logs);

    return {
        url,
        port,
        dataRoot,
        child,
        logs,
        logText: () => logs.join(''),
        async stop() {
            if (child.exitCode === null) {
                child.kill();
                await new Promise(resolve => {
                    const t = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 5000);
                    child.once('exit', () => { clearTimeout(t); resolve(); });
                });
            }
            fs.rmSync(dataRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
        }
    };
}

async function api(base, reqPath, { method = 'GET', token, body, headers = {} } = {}) {
    const h = { ...headers };
    if (token) h.Authorization = `Bearer ${token}`;
    if (body !== undefined) h['Content-Type'] = 'application/json';
    const res = await fetch(base + reqPath, {
        method,
        headers: h,
        body: body !== undefined ? JSON.stringify(body) : undefined
    });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch {}
    return { status: res.status, data, text, headers: res.headers };
}

async function registerUser(base, username, password = 'p0-test-pass-123') {
    const res = await api(base, '/api/auth/register', { method: 'POST', body: { username, password } });
    if (res.status !== 200) throw new Error(`注册失败 ${username}: ${res.text}`);
    return { token: res.data.token, userId: res.data.user.id, username };
}

/** 读取 SSE 响应直至 end/error 或超时，返回事件数组 */
async function readSSE(res, { timeoutMs = 30000 } = {}) {
    const events = [];
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const deadline = Date.now() + timeoutMs;
    try {
        while (Date.now() < deadline) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                try {
                    const evt = JSON.parse(line.slice(6));
                    events.push(evt);
                    if (evt.type === 'end' || evt.type === 'error') return events;
                } catch {}
            }
        }
    } finally {
        try { reader.cancel(); } catch {}
    }
    return events;
}

async function postSSE(base, reqPath, { token, body, timeoutMs = 30000 }) {
    const res = await fetch(base + reqPath, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body)
    });
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('text/event-stream')) {
        const text = await res.text();
        let data = null;
        try { data = JSON.parse(text); } catch {}
        return { status: res.status, events: [], json: data, text };
    }
    const events = await readSSE(res, { timeoutMs });
    return { status: res.status, events, json: null };
}

/** 轮询等待条件成立（用于异步记忆抽取等） */
async function waitFor(fn, { timeoutMs = 8000, intervalMs = 200 } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const v = await fn();
        if (v) return v;
        await new Promise(r => setTimeout(r, intervalMs));
    }
    return null;
}

module.exports = {
    REPO_ROOT,
    startIsolatedServer,
    getFreePort,
    api,
    registerUser,
    readSSE,
    postSSE,
    waitFor
};