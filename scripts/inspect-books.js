/**
 * P0 书籍元数据检查（只读）：字节数、编码、解码字符数、SHA-256、
 * 可识别章节数、长章分布、是否疑似节选。不修改任何书籍文件。
 * 用法：node scripts/inspect-books.js [输出路径]
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const jschardet = require('jschardet');
const iconv = require('iconv-lite');

const REPO_ROOT = path.join(__dirname, '..');
const BOOKS = [
    { id: 'confessions', file: 'books/__defaults/忏悔录 作者：卢梭.txt', title: '忏悔录（卢梭）' },
    { id: 'one-hundred-years', file: 'books/__defaults/百年孤独.txt', title: '百年孤独' }
];

const CHAPTER_RE = /^(第[一二三四五六七八九十零百千万]+[章节回部篇集]|[第\d]+[章节回部篇集]|[一二三四五六七八九十零]+[、.]|[\d]+[、.]|Chapter\s*\d+|CHAPTER\s*\d+)/i;

function decode(buffer) {
    const detected = jschardet.detect(buffer);
    let encoding = detected.encoding || 'utf-8';
    const map = {
        'GB2312': 'gbk', 'GB18030': 'gbk', 'gb2312': 'gbk', 'gb18030': 'gbk',
        'BIG5': 'big5', 'UTF-8': 'utf-8', 'utf-8': 'utf-8',
        'UTF-16LE': 'utf-16le', 'UTF-16BE': 'utf-16be', 'ascii': 'utf-8', 'ASCII': 'utf-8'
    };
    encoding = map[encoding] || encoding;
    let text;
    if (/utf-?8/i.test(encoding)) {
        const hasBOM = buffer.length >= 3 && buffer[0] === 0xEF && buffer[1] === 0xBB && buffer[2] === 0xBF;
        text = (hasBOM ? buffer.slice(3) : buffer).toString('utf-8');
        if (!text.includes('\uFFFD')) return { text, encoding: 'utf-8', confidence: detected.confidence };
    }
    try {
        text = iconv.decode(buffer, encoding);
        if (!text.includes('\uFFFD')) return { text, encoding, confidence: detected.confidence };
    } catch {}
    for (const enc of ['utf-8', 'gbk', 'gb18030', 'big5', 'utf-16le']) {
        try {
            const t = iconv.decode(buffer, enc);
            if (!t.includes('\uFFFD')) return { text: t, encoding: enc, confidence: detected.confidence };
        } catch {}
    }
    return { text: buffer.toString('utf-8'), encoding: 'utf-8(fallback)', confidence: detected.confidence };
}

function analyze(content) {
    const lines = content.split(/\r?\n/);
    const chapters = [];
    let current = null;
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (CHAPTER_RE.test(trimmed)) {
            if (current) chapters.push(current);
            current = { title: trimmed.substring(0, 60), chars: 0 };
        } else if (current) {
            current.chars += trimmed.length;
        }
    }
    if (current) chapters.push(current);
    const lengths = chapters.map(c => c.chars).sort((a, b) => a - b);
    const totalChapterChars = lengths.reduce((a, b) => a + b, 0);
    return {
        chapterCount: chapters.length,
        totalChars: content.length,
        lineCount: lines.length,
        chapterCharTotal: totalChapterChars,
        medianChapterChars: lengths.length ? lengths[Math.floor(lengths.length / 2)] : 0,
        maxChapterChars: lengths.length ? lengths[lengths.length - 1] : 0,
        longChaptersOver5000: chapters.filter(c => c.chars > 5000).length,
        firstChapters: chapters.slice(0, 5).map(c => c.title),
        lastChapters: chapters.slice(-3).map(c => c.title)
    };
}

function main() {
    const outPath = process.argv[2] || path.join(REPO_ROOT, 'docs', 'baseline', 'book-metadata.json');
    const results = [];
    for (const b of BOOKS) {
        const abs = path.join(REPO_ROOT, b.file);
        if (!fs.existsSync(abs)) {
            results.push({ id: b.id, title: b.title, file: b.file, exists: false });
            continue;
        }
        const buffer = fs.readFileSync(abs);
        const { text, encoding, confidence } = decode(buffer);
        const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
        const stats = analyze(text);
        results.push({
            id: b.id,
            title: b.title,
            file: b.file,
            exists: true,
            bytes: buffer.length,
            encoding,
            encodingConfidence: confidence,
            sha256,
            decodedChars: text.length,
            replacementChars: (text.match(/\uFFFD/g) || []).length,
            ...stats,
            // 节选判断仅为启发式提示，需人工结合版本说明确认
            excerptHeuristic: stats.chapterCount < 5 ? '章节极少，疑似节选，需人工确认' : '章节数正常，完整性仍需人工确认'
        });
    }
    const payload = { generatedAt: new Date().toISOString(), note: '只读检查；不根据书名补齐本地不存在的内容', books: results };
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(payload, null, 2), 'utf-8');
    console.log(JSON.stringify(payload, null, 2));
}

main();