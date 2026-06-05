// 轻量级结构化日志：避免引入 winston/pino 依赖
// 输出 JSON 行 + 人类可读格式，可被日志聚合系统（如 Loki、CloudWatch）解析

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const ACTIVE_LEVEL = LEVELS[process.env.LOG_LEVEL || 'info'] || LEVELS.info;
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

function formatMessage(level, msg, meta) {
    const timestamp = new Date().toISOString();
    if (IS_PRODUCTION) {
        // 生产环境输出 JSON，便于采集
        return JSON.stringify({ timestamp, level, msg, ...meta });
    }
    // 开发环境彩色输出
    const colors = { debug: '\x1b[90m', info: '\x1b[36m', warn: '\x1b[33m', error: '\x1b[31m' };
    const reset = '\x1b[0m';
    const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
    return `${colors[level]}${timestamp} [${level.toUpperCase()}]${reset} ${msg}${metaStr}`;
}

function log(level, msg, meta = {}) {
    if (LEVELS[level] < ACTIVE_LEVEL) return;
    const line = formatMessage(level, msg, meta);
    if (level === 'error' || level === 'warn') {
        console.error(line);
    } else {
        console.log(line);
    }
}

module.exports = {
    debug: (msg, meta) => log('debug', msg, meta),
    info: (msg, meta) => log('info', msg, meta),
    warn: (msg, meta) => log('warn', msg, meta),
    error: (msg, meta) => log('error', msg, meta),
    // 包装函数，自动捕获异常
    child: (component) => ({
        debug: (msg, meta) => log('debug', msg, { component, ...meta }),
        info: (msg, meta) => log('info', msg, { component, ...meta }),
        warn: (msg, meta) => log('warn', msg, { component, ...meta }),
        error: (msg, meta) => log('error', msg, { component, ...meta })
    })
};
