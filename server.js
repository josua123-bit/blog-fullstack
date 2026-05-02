const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const Database = require('better-sqlite3');
const multer = require('multer');
const fs = require('fs');
require('dotenv').config();

const app = express();
const db = new Database('blog.db');

const uploadDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname);
        cb(null, Date.now() + ext);
    }
});

const upload = multer({
    storage,
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const allowed = /jpeg|jpg|png|gif|webp/;
        if (allowed.test(path.extname(file.originalname).toLowerCase())) {
            cb(null, true);
        } else {
            cb(new Error('Hanya file gambar yang diperbolehkan!'));
        }
    }
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

db.exec(`
    CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS articles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        tag TEXT NOT NULL,
        content TEXT NOT NULL,
        author TEXT NOT NULL,
        date TEXT NOT NULL,
        image_url TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS comments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        article_id INTEGER NOT NULL,
        author TEXT NOT NULL,
        text TEXT NOT NULL,
        image_url TEXT,
        date TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (article_id) REFERENCES articles(id)
    );
`);

try {
    db.exec(`ALTER TABLE comments ADD COLUMN image_url TEXT`);
} catch (e) {}

// =================== AUTH ===================
app.post('/api/register', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ message: 'Username dan password wajib diisi' });
    const existing = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (existing) return res.status(400).json({ message: 'Username sudah dipakai' });
    const hashed = await bcrypt.hash(password, 10);
    db.prepare('INSERT INTO users (username, password) VALUES (?, ?)').run(username, hashed);
    res.json({ message: 'Registrasi berhasil!' });
});

app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (!user) return res.status(400).json({ message: 'User tidak ditemukan' });
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(400).json({ message: 'Password salah' });
    const token = jwt.sign({ username }, process.env.JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, username });
});

// =================== MIDDLEWARE ===================
function authMiddleware(req, res, next) {
    const token = req.headers['authorization']?.split(' ')[1];
    if (!token) return res.status(401).json({ message: 'Token tidak ada' });
    try {
        req.user = jwt.verify(token, process.env.JWT_SECRET);
        next();
    } catch {
        res.status(401).json({ message: 'Token tidak valid' });
    }
}

// =================== UPLOAD ===================
app.post('/api/upload', authMiddleware, upload.single('image'), (req, res) => {
    if (!req.file) return res.status(400).json({ message: 'Tidak ada file yang diupload' });
    res.json({ url: `/uploads/${req.file.filename}` });
});

// =================== ARTIKEL ===================
app.get('/api/articles', (req, res) => {
    const articles = db.prepare('SELECT * FROM articles ORDER BY created_at DESC').all();
    const result = articles.map(a => ({
        ...a,
        comments: db.prepare('SELECT * FROM comments WHERE article_id = ?').all(a.id)
    }));
    res.json(result);
});

app.post('/api/articles', authMiddleware, (req, res) => {
    const { title, tag, content, imageUrl } = req.body;
    if (!title || !content) return res.status(400).json({ message: 'Judul dan isi wajib diisi' });
    const date = new Date().toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' });
    const result = db.prepare('INSERT INTO articles (title, tag, content, author, date, image_url) VALUES (?, ?, ?, ?, ?, ?)')
        .run(title, tag, content, req.user.username, date, imageUrl || null);
    const article = db.prepare('SELECT * FROM articles WHERE id = ?').get(result.lastInsertRowid);
    res.json({ message: 'Artikel berhasil dibuat!', article });
});

app.get('/api/articles/:id', (req, res) => {
    const article = db.prepare('SELECT * FROM articles WHERE id = ?').get(req.params.id);
    if (!article) return res.status(404).json({ message: 'Artikel tidak ditemukan' });
    article.comments = db.prepare('SELECT * FROM comments WHERE article_id = ?').all(article.id);
    res.json(article);
});

app.delete('/api/articles/:id', authMiddleware, (req, res) => {
    const article = db.prepare('SELECT * FROM articles WHERE id = ?').get(req.params.id);
    if (!article) return res.status(404).json({ message: 'Artikel tidak ditemukan' });
    const isAdmin = req.user.username === process.env.ADMIN;
    if (article.author !== req.user.username && !isAdmin) return res.status(403).json({ message: 'Tidak punya izin' });
    db.prepare('DELETE FROM comments WHERE article_id = ?').run(req.params.id);
    db.prepare('DELETE FROM articles WHERE id = ?').run(req.params.id);
    res.json({ message: 'Artikel berhasil dihapus!' });
});

// =================== KOMENTAR ===================
app.post('/api/articles/:id/comments', authMiddleware, upload.single('image'), (req, res) => {
    const article = db.prepare('SELECT * FROM articles WHERE id = ?').get(req.params.id);
    if (!article) return res.status(404).json({ message: 'Artikel tidak ditemukan' });
    const date = new Date().toLocaleDateString('id-ID');
    const imageUrl = req.file ? `/uploads/${req.file.filename}` : null;
    const text = req.body.text || '';
    if (!text && !imageUrl) return res.status(400).json({ message: 'Komentar tidak boleh kosong!' });
    db.prepare('INSERT INTO comments (article_id, author, text, image_url, date) VALUES (?, ?, ?, ?, ?)')
        .run(req.params.id, req.user.username, text, imageUrl, date);
    const comments = db.prepare('SELECT * FROM comments WHERE article_id = ?').all(article.id);
    res.json({ message: 'Komentar ditambahkan!', comments });
});

// =================== START ===================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server jalan di http://localhost:${PORT}`);
});