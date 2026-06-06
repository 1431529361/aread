const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');
const { getDB } = require('./database');

const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');

const BOOKS_DIR = path.join(__dirname, 'books');
const DEFAULTS_DIR = path.join(BOOKS_DIR, '__defaults');
const DEFAULT_BOOKS = [
    { title: '百年孤独', filename: '百年孤独.txt', author: '加西亚·马尔克斯' }
];

function addDefaultBooksForUser(userId) {
    const db = getDB();
    const userDir = path.join(BOOKS_DIR, userId);
    if (!fs.existsSync(userDir)) {
        fs.mkdirSync(userDir, { recursive: true });
    }

    for (const defBook of DEFAULT_BOOKS) {
        const srcPath = path.join(DEFAULTS_DIR, defBook.filename);
        if (!fs.existsSync(srcPath)) continue;

        // Check if user already has a book with this title
        const existing = db.prepare('SELECT id FROM books_meta WHERE user_id = ? AND title = ?').get(userId, defBook.title);
        if (existing) continue;

        const bookId = uuidv4();
        const destPath = path.join(userDir, bookId + path.extname(defBook.filename));
        fs.copyFileSync(srcPath, destPath);

        const stat = fs.statSync(destPath);
        const sizeKB = (stat.size / 1024).toFixed(2);
        const sizeFormatted = stat.size >= 1048576
            ? `${(stat.size / 1048576).toFixed(2)} MB`
            : `${sizeKB} KB`;

        db.prepare(`
            INSERT INTO books_meta (id, user_id, title, filename, original_name, format, size, size_formatted, upload_time, author)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(bookId, userId, defBook.title, bookId + path.extname(defBook.filename),
            defBook.filename, 'TXT', stat.size, sizeFormatted,
            new Date().toISOString(), defBook.author);
    }
}

function signToken(userId, username, rememberMe) {
    const expiresIn = rememberMe ? '30d' : '7d';
    return jwt.sign({ id: userId, username }, JWT_SECRET, { expiresIn });
}

function authMiddleware(req, res, next) {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
        return res.status(401).json({ error: '请先登录', needAuth: true });
    }
    try {
        const token = header.slice(7);
        const decoded = jwt.verify(token, JWT_SECRET);
        req.user = { id: decoded.id, username: decoded.username };
        next();
    } catch (err) {
        return res.status(401).json({ error: '登录已过期，请重新登录', needAuth: true });
    }
}

function registerHandler(req, res) {
    const { username, password } = req.body;

    if (!username || typeof username !== 'string' || username.trim().length < 1) {
        return res.status(400).json({ error: '请输入用户名' });
    }

    if (!password || typeof password !== 'string' || password.length < 6) {
        return res.status(400).json({ error: '密码至少6位' });
    }

    const db = getDB();
    const trimmedUsername = username.trim();

    const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(trimmedUsername);
    if (existing) {
        return res.status(400).json({ error: '用户名已存在' });
    }

    const userId = uuidv4();
    const passwordHash = bcrypt.hashSync(password, 10);

    db.prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)').run(userId, trimmedUsername, passwordHash);

    // Add default books for new user
    addDefaultBooksForUser(userId);

    const token = signToken(userId, trimmedUsername, false);
    res.json({ token, user: { id: userId, username: trimmedUsername } });
}

function loginHandler(req, res) {
    const { username, password, rememberMe } = req.body;

    if (!username || !password) {
        return res.status(400).json({ error: '请输入用户名和密码' });
    }

    const db = getDB();
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username.trim());

    if (!user || !bcrypt.compareSync(password, user.password_hash)) {
        return res.status(401).json({ error: '用户名或密码错误' });
    }

    const token = signToken(user.id, user.username, !!rememberMe);
    res.json({ token, user: { id: user.id, username: user.username } });
}

function meHandler(req, res) {
    res.json({ user: { id: req.user.id, username: req.user.username } });
}

module.exports = { authMiddleware, registerHandler, loginHandler, meHandler, addDefaultBooksForUser };
