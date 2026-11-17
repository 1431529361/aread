/**
 * P4 凭据加密迁移离线测试：v2 GCM  roundtrip / legacy CBC 兼容 / 篡改检测 /
 * 错误密钥 / migrate 计数与幂等 / 新写入格式（API 级，隔离数据根）。
 */
const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const { createCredentialCrypto } = require('../credential-crypto');
const { startIsolatedServer, api, registerUser } = require('./helpers/isolated-server');

const KEY = crypto.randomBytes(32).toString('hex');
const cc = createCredentialCrypto(KEY);

function legacyEncrypt(text, keyHex = KEY) {
    const iv = crypto.randomBytes(16);
    const key = Buffer.from(keyHex.slice(0, 64), 'hex');
    const c = crypto.createCipheriv('aes-256-cbc', key, iv);
    return iv.toString('hex') + ':' + (c.update(text, 'utf8', 'hex') + c.final('hex'));
}

test('v2 GCM roundtrip 与格式标记', () => {
    const secret = 'sk-p4-unit-0123456789abcdef';
    const enc = cc.encrypt(secret);
    assert.ok(enc.startsWith('v2.'));
    assert.strictEqual(cc.formatOf(enc), 'v2-gcm');
    assert.strictEqual(cc.decrypt(enc), secret);
    assert.notStrictEqual(cc.encrypt(secret), enc);
});

test('legacy CBC 密文保持可解密', () => {
    const secret = 'sk-legacy-compat-abcdef';
    const legacy = legacyEncrypt(secret);
    assert.strictEqual(cc.formatOf(legacy), 'legacy-cbc');
    assert.strictEqual(cc.decrypt(legacy), secret);
});

test('v2 篡改/截断被认证标签拒绝', () => {
    const enc = cc.encrypt('sk-tamper-target');
    const buf = Buffer.from(enc.slice(3), 'base64');
    buf[20] ^= 0xff;
    assert.strictEqual(cc.decrypt('v2.' + buf.toString('base64')), null);
    assert.strictEqual(cc.decrypt('v2.' + buf.subarray(0, 20).toString('base64')), null);
    assert.strictEqual(cc.decrypt('v2.!!!not-base64!!!'), null);
});

test('错误密钥两种格式均返回 null', () => {
    const other = createCredentialCrypto(crypto.randomBytes(32).toString('hex'));
    assert.strictEqual(other.decrypt(cc.encrypt('x')), null);
    assert.strictEqual(other.decrypt(legacyEncrypt('x')), null);
    assert.strictEqual(cc.decrypt('garbage'), null);
    assert.strictEqual(cc.decrypt(null), null);
});

function memDb() {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE api_keys (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL, provider TEXT NOT NULL,
        encrypted_key TEXT NOT NULL, masked_key TEXT,
        last_updated TEXT, UNIQUE(user_id, provider))`);
    return db;
}

test('migrate：legacy→v2、v2 不动、坏行保留并计数、幂等', () => {
    const db = memDb();
    const ins = db.prepare('INSERT INTO api_keys (user_id, provider, encrypted_key) VALUES (?, ?, ?)');
    ins.run('u1', 'zhipu', legacyEncrypt('sk-one'));
    ins.run('u1', 'siliconflow', cc.encrypt('sk-two'));
    ins.run('u2', 'custom-x', 'broken-not-decryptable');
    const r1 = cc.migrate(db);
    assert.deepStrictEqual(r1, { total: 3, migrated: 1, alreadyV2: 1, failed: 1 });
    const rows = db.prepare('SELECT provider, encrypted_key FROM api_keys ORDER BY provider').all();
    const byProv = Object.fromEntries(rows.map(r => [r.provider, r.encrypted_key]));
    assert.strictEqual(cc.formatOf(byProv.zhipu), 'v2-gcm');
    assert.strictEqual(cc.decrypt(byProv.zhipu), 'sk-one');
    assert.strictEqual(cc.decrypt(byProv.siliconflow), 'sk-two');
    assert.strictEqual(byProv['custom-x'], 'broken-not-decryptable');
    const r2 = cc.migrate(db);
    assert.deepStrictEqual(r2, { total: 3, migrated: 0, alreadyV2: 2, failed: 1 });
    db.close();
});

test('API 级：新写入为 v2 且可验证；legacy 行同密钥仍可解密验证（假模型，不触网）', async () => {
    const { startFakeModelServer } = require('./helpers/fake-model-server');
    const fake = await startFakeModelServer();
    const fixedKey = crypto.randomBytes(32).toString('hex');
    const srv = await startIsolatedServer({ extraEnv: { ENCRYPTION_KEY: fixedKey } });
    try {
        const user = await registerUser(srv.url, 'p4-crypto');
        const prov = await api(srv.url, '/api/providers', {
            method: 'POST', token: user.token,
            body: { id: 'cryptoprov', name: 'CryptoProv', apiEndpoint: `${fake.url}/v1`, defaultModel: 'fake-model', apiKey: 'sk-p4-api-write-0123456789' }
        });
        assert.strictEqual(prov.status, 200);
        const dbPath = path.join(srv.dataRoot, 'data.db');
        let raw = new Database(dbPath, { readonly: true });
        let row = raw.prepare("SELECT encrypted_key FROM api_keys WHERE user_id = ? AND provider = 'cryptoprov'").get(user.userId);
        raw.close();
        assert.ok(row.encrypted_key.startsWith('v2.'), '新写入必须为 v2');
        const v1 = await api(srv.url, '/api/key/verify', { method: 'POST', token: user.token, body: { provider: 'cryptoprov' } });
        assert.strictEqual(v1.data.valid, true);
        // 模拟迁移前旧数据：覆写为 legacy，解密路径仍可用
        raw = new Database(dbPath);
        raw.prepare("UPDATE api_keys SET encrypted_key = ? WHERE user_id = ? AND provider = 'cryptoprov'").run(legacyEncrypt('sk-p4-api-write-0123456789', fixedKey), user.userId);
        raw.close();
        const v2 = await api(srv.url, '/api/key/verify', { method: 'POST', token: user.token, body: { provider: 'cryptoprov' } });
        assert.strictEqual(v2.data.valid, true);
        // 篡改 v2 → 解密失败明确报错
        raw = new Database(dbPath);
        const enc = createCredentialCrypto(fixedKey).encrypt('sk-p4-api-write-0123456789');
        const buf = Buffer.from(enc.slice(3), 'base64'); buf[20] ^= 0xff;
        raw.prepare("UPDATE api_keys SET encrypted_key = ? WHERE user_id = ? AND provider = 'cryptoprov'").run('v2.' + buf.toString('base64'), user.userId);
        raw.close();
        const v3 = await api(srv.url, '/api/key/verify', { method: 'POST', token: user.token, body: { provider: 'cryptoprov' } });
        assert.strictEqual(v3.data.valid, false);
        assert.strictEqual(v3.data.error, 'API密钥解密失败');
    } finally {
        await srv.stop();
        await fake.close();
    }
});