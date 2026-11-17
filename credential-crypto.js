/**
 * 凭据加密（P4 版本化迁移）：
 * - 新写入一律 v2：`v2.` + base64(iv(12) | ciphertext | tag(16))，AES-256-GCM，带完整性保护；
 * - 旧格式 legacy：`ivHex:cipherHex`，AES-256-CBC，仅保持可解密（无认证标签，篡改不可靠检测）；
 * - migrate(db) 显式将 legacy 行重加密为 v2（事务内、逐行失败保留原值），不自动运行，
 *   业务库迁移须单独确认后在备份之上执行。
 */
const crypto = require('crypto');

function createCredentialCrypto(keyHex) {
    const key = Buffer.from(String(keyHex).slice(0, 64), 'hex');

    function encrypt(text) {
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
        const ct = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
        return 'v2.' + Buffer.concat([iv, ct, cipher.getAuthTag()]).toString('base64');
    }

    function decrypt(data) {
        try {
            if (typeof data !== 'string' || !data) return null;
            if (data.startsWith('v2.')) {
                const buf = Buffer.from(data.slice(3), 'base64');
                if (buf.length < 12 + 16 + 1) return null;
                const iv = buf.subarray(0, 12);
                const tag = buf.subarray(buf.length - 16);
                const ct = buf.subarray(12, buf.length - 16);
                const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
                d.setAuthTag(tag);
                return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
            }
            const parts = data.split(':');
            if (parts.length !== 2) return null;
            const iv = Buffer.from(parts[0], 'hex');
            const d = crypto.createDecipheriv('aes-256-cbc', key, iv);
            return d.update(parts[1], 'hex', 'utf8') + d.final('utf8');
        } catch {
            return null;
        }
    }

    function formatOf(data) {
        return typeof data === 'string' && data.startsWith('v2.') ? 'v2-gcm' : 'legacy-cbc';
    }

    function migrate(db) {
        const rows = db.prepare('SELECT user_id, provider, encrypted_key FROM api_keys').all();
        const upd = db.prepare('UPDATE api_keys SET encrypted_key = ?, last_updated = ? WHERE user_id = ? AND provider = ?');
        let migrated = 0, alreadyV2 = 0, failed = 0;
        db.transaction(() => {
            for (const r of rows) {
                if (formatOf(r.encrypted_key) === 'v2-gcm') { alreadyV2++; continue; }
                const plain = decrypt(r.encrypted_key);
                if (plain == null) { failed++; continue; }
                upd.run(encrypt(plain), new Date().toISOString(), r.user_id, r.provider);
                migrated++;
            }
        })();
        return { total: rows.length, migrated, alreadyV2, failed };
    }

    return { encrypt, decrypt, formatOf, migrate };
}

module.exports = { createCredentialCrypto };