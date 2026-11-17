/**
 * P4 凭据加密迁移独立验收（隔离数据根，不触碰业务 data.db）：
 * 旧legacy+新v2混合库 → 停服一致备份 → migrate → 重启验证 → 备份回滚重启验证 → 篡改检测。
 * 用法：node scripts/p4-credential-migration-check.js
 * 产出：docs/baseline-results/p4-credential-<ts>.json
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const crypto = require('crypto');
const { spawn } = require('child_process');
const Database = require('better-sqlite3');
const REPO_ROOT = path.join(__dirname, '..');
const { createCredentialCrypto } = require('../credential-crypto');
const { startFakeModelServer } = require('../tests/helpers/fake-model-server');
const { api, registerUser } = require('../tests/helpers/isolated-server');

const KEY = crypto.randomBytes(32).toString('hex');
const cc = createCredentialCrypto(KEY);

function legacyEncrypt(text) {
    const iv = crypto.randomBytes(16);
    const c = crypto.createCipheriv('aes-256-cbc', Buffer.from(KEY, 'hex'), iv);
    return iv.toString('hex') + ':' + (c.update(text, 'utf8', 'hex') + c.final('hex'));
}

function freePort() {
    return new Promise(res => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
}

async function spawnServer(dataRoot) {
    const port = await freePort();
    const env = { ...process.env };
    for (const k of ['ZHIPU_API_KEY', 'SILICONFLOW_API_KEY', 'AI_API_KEY', 'CUSTOM_API_KEY', 'EMBED_API_KEY', 'EMBED_BASE_URL', 'EMBED_MODEL_NAME', 'AI_MODEL']) delete env[k];
    Object.assign(env, {
        READER_DATA_ROOT: dataRoot,
        DOTENV_CONFIG_PATH: path.join(dataRoot, '.env'),
        ENCRYPTION_KEY: KEY,
        JWT_SECRET: 'p4-cred-jwt',
        PORT: String(port)
    });
    const logs = [];
    const child = spawn(process.execPath, [path.join(REPO_ROOT, 'server.js')], { env, cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', d => logs.push(d.toString()));
    child.stderr.on('data', d => logs.push(d.toString()));
    const url = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 20000;
    let ready = false;
    while (Date.now() < deadline) {
        if (child.exitCode !== null) break;
        try { const r = await fetch(url + '/api/auth/me', { signal: AbortSignal.timeout(800) }); if (r.status === 401 || r.ok) { ready = true; break; } } catch {}
        await new Promise(r => setTimeout(r, 150));
    }
    if (!ready) { child.kill('SIGKILL'); throw new Error('服务未就绪:\n' + logs.join('')); }
    return {
        url, child,
        async kill() {
            if (child.exitCode === null) {
                child.kill();
                await new Promise(r => { const t = setTimeout(() => { child.kill('SIGKILL'); r(); }, 4000); child.once('exit', () => { clearTimeout(t); r(); }); });
            }
        }
    };
}

function newRoot() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-p4-cred-'));
    fs.writeFileSync(path.join(root, '.env'), '');
    return root;
}

async function main() {
    const steps = [];
    const record = { startedAt: new Date().toISOString(), keyFingerprint: crypto.createHash('sha256').update(KEY).digest('hex').slice(0, 12), steps };
    const ok = (name, pass, detail) => { steps.push({ name, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ' ' + JSON.stringify(detail) : ''}`); if (!pass) process.exitCode = 1; };
    const fake = await startFakeModelServer();
    const rootA = newRoot();
    const rootC = newRoot();
    let A = null, B = null, C = null;
    try {
        A = await spawnServer(rootA);
        const user = await registerUser(A.url, 'p4-cred');
        const p1 = await api(A.url, '/api/providers', { method: 'POST', token: user.token, body: { id: 'cryptoprov', name: 'CryptoProv', apiEndpoint: `${fake.url}/v1`, defaultModel: 'fake-model', apiKey: 'sk-p4-cred-secret-0123456789' } });
        ok('创建自定义提供商(v2写入)', p1.status === 200);
        const p2 = await api(A.url, '/api/providers', { method: 'POST', token: user.token, body: { id: 'cryptoprov2', name: 'CryptoProv2', apiEndpoint: `${fake.url}/v1`, defaultModel: 'fake-model', apiKey: 'sk-p4-cred-second-9876543210' } });
        ok('设置第二密钥(v2写入)', p2.status === 200);
        let raw = new Database(path.join(rootA, 'data.db'));
        raw.prepare("UPDATE api_keys SET encrypted_key = ? WHERE user_id = ? AND provider = 'cryptoprov'").run(legacyEncrypt('sk-p4-cred-secret-0123456789'), user.userId);
        const formats = raw.prepare('SELECT provider, encrypted_key FROM api_keys').all().map(r => [r.provider, cc.formatOf(r.encrypted_key)]);
        ok('构造混合库(1 legacy + 1 v2)', JSON.stringify(formats.sort()) === JSON.stringify([['cryptoprov', 'legacy-cbc'], ['cryptoprov2', 'v2-gcm']]), formats);
        await A.kill(); A = null;
        // SQLite backup API：含 WAL 的一致单文件备份
        raw = new Database(path.join(rootA, 'data.db'));
        await raw.backup(path.join(rootA, 'backup-pre-migration.db'));
        raw.close();
        ok('停服一致备份', fs.existsSync(path.join(rootA, 'backup-pre-migration.db')));
        raw = new Database(path.join(rootA, 'data.db'));
        const mig = cc.migrate(raw);
        raw.close();
        ok('migrate 计数', mig.total === 2 && mig.migrated === 1 && mig.alreadyV2 === 1 && mig.failed === 0, mig);
        B = await spawnServer(rootA);
        const loginB = await api(B.url, '/api/auth/login', { method: 'POST', body: { username: 'p4-cred', password: 'p0-test-pass-123' } });
        const vB = await api(B.url, '/api/key/verify', { method: 'POST', token: loginB.data.token, body: { provider: 'cryptoprov' } });
        ok('迁移后重启验证(v2可读)', loginB.status === 200 && vB.data.valid === true, vB.data);
        await B.kill(); B = null;
        // 篡改检测（迁移后库）
        raw = new Database(path.join(rootA, 'data.db'));
        const row = raw.prepare("SELECT encrypted_key FROM api_keys WHERE provider = 'cryptoprov'").get();
        const buf = Buffer.from(row.encrypted_key.slice(3), 'base64'); buf[20] ^= 0xff;
        const tamperedNull = cc.decrypt('v2.' + buf.toString('base64')) === null;
        raw.close();
        ok('v2篡改检测', tamperedNull);
        // 回滚：备份复制到新根，重启验证 legacy 仍可读
        fs.copyFileSync(path.join(rootA, 'backup-pre-migration.db'), path.join(rootC, 'data.db'));
        C = await spawnServer(rootC);
        const loginC = await api(C.url, '/api/auth/login', { method: 'POST', body: { username: 'p4-cred', password: 'p0-test-pass-123' } });
        const vC = await api(C.url, '/api/key/verify', { method: 'POST', token: loginC.data.token, body: { provider: 'cryptoprov' } });
        ok('备份回滚后重启验证(legacy可读)', loginC.status === 200 && vC.data.valid === true, vC.data);
    } catch (e) {
        ok('异常', false, { error: e.message });
    } finally {
        if (A) await A.kill();
        if (B) await B.kill();
        if (C) await C.kill();
        await fake.close();
        fs.rmSync(rootA, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
        fs.rmSync(rootC, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    }
    record.finishedAt = new Date().toISOString();
    record.allPass = steps.every(s => s.pass);
    const out = path.join(REPO_ROOT, 'docs', 'baseline-results', `p4-credential-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    fs.writeFileSync(out, JSON.stringify(record, null, 2));
    console.log('OUT:', out, 'allPass=', record.allPass);
}

main().catch(e => { console.error(e); process.exit(1); });