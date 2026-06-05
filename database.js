const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');
const logger = require('./logger');
const { runMigrations } = require('./migrations');

const DB_PATH = path.join(__dirname, 'data.db');
const SAVE_DEBOUNCE_MS = 200;
const log = logger.child('db');

let db = null;
let saveTimer = null;
let pendingWrite = false;
let isShuttingDown = false;

function createDbWrapper(sqlJsDb) {
    function flushToDisk() {
        try {
            const data = sqlJsDb.export();
            fs.writeFileSync(DB_PATH, Buffer.from(data));
        } catch (err) {
            log.error('写入磁盘失败', { error: err.message });
        }
    }

    // 防抖写入：短时间内多次 run 只触发一次 export + writeFile
    function scheduleSave() {
        if (isShuttingDown) {
            flushToDisk();
            return;
        }
        pendingWrite = true;
        if (saveTimer) return;
        saveTimer = setTimeout(() => {
            saveTimer = null;
            if (pendingWrite) {
                pendingWrite = false;
                flushToDisk();
            }
        }, SAVE_DEBOUNCE_MS);
    }

    function createStatement(sql) {
        return {
            get: (...params) => {
                const stmt = sqlJsDb.prepare(sql);
                try {
                    if (params.length > 0) stmt.bind(params);
                    if (stmt.step()) return stmt.getAsObject();
                    return undefined;
                } finally {
                    stmt.free();
                }
            },
            all: (...params) => {
                const stmt = sqlJsDb.prepare(sql);
                const results = [];
                try {
                    if (params.length > 0) stmt.bind(params);
                    while (stmt.step()) results.push(stmt.getAsObject());
                    return results;
                } finally {
                    stmt.free();
                }
            },
            run: (...params) => {
                const stmt = sqlJsDb.prepare(sql);
                try {
                    if (params.length > 0) stmt.bind(params);
                    stmt.step();
                    scheduleSave();
                    return { changes: sqlJsDb.getRowsModified() };
                } finally {
                    stmt.free();
                }
            }
        };
    }

    return {
        prepare: (sql) => createStatement(sql),
        exec: (sql) => {
            sqlJsDb.run(sql);
            scheduleSave();
        },
        pragma: (setting) => {
            try { sqlJsDb.run('PRAGMA ' + setting); } catch (e) {}
        },
        // 强制立即落盘（用于退出前）
        flush: flushToDisk,
        close: () => {
            isShuttingDown = true;
            if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
            flushToDisk();
            sqlJsDb.close();
        }
    };
}

async function initDB() {
    const SQL = await initSqlJs();
    let sqlJsDb;
    if (fs.existsSync(DB_PATH)) {
        const fileBuffer = fs.readFileSync(DB_PATH);
        sqlJsDb = new SQL.Database(fileBuffer);
        log.info('已加载现有数据库', { path: DB_PATH });
    } else {
        sqlJsDb = new SQL.Database();
        log.info('创建新数据库', { path: DB_PATH });
    }

    sqlJsDb.run('PRAGMA journal_mode = WAL');
    sqlJsDb.run('PRAGMA foreign_keys = ON');

    // 运行迁移系统（幂等且事务安全）
    runMigrations(sqlJsDb);

    db = createDbWrapper(sqlJsDb);
    // 迁移后立即持久化一次
    db.flush();
    return db;
}

function getDB() {
    if (!db) throw new Error('Database not initialized. Call initDB() first.');
    return db;
}

module.exports = { initDB, getDB };
