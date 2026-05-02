const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const multer = require('multer');
const fs = require('fs');
const { Pool } = require('pg');
const cloudinary = require('cloudinary').v2;

cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});
require('dotenv').config();

const app = express();

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

const uploadDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.memoryStorage();
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

// Setup database
async function setupDB() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS users (
            id SERIAL PRIMARY KEY,
            username TEXT UNIQUE NOT NULL,
            password TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS articles (
            id SERIAL PRIMARY KEY,
            title TEXT NOT NULL,
            tag TEXT NOT NULL,
            content TEXT NOT NULL,
            author TEXT NOT NULL,
            date TEXT NOT NULL,
            image_url TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS comments (
            id SERIAL PRIMARY KEY,
            article_id INTEGER NOT NULL,
            author TEXT NOT NULL,
            text TEXT,
            image_url TEXT,
            date TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (article_id) REFERENCES articles(id)
        );
    `);
    console.log('Database siap!');
}

setupDB();

// =================== AUTH ===================
app.post('/api/register', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ message: 'Username dan password wajib diisi' });
    const existing = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
    if (existing.rows.length > 0) return res.status(400).json({ message: 'Username sudah dipakai' });
    const hashed = await bcrypt.hash(password, 10);
    await pool.query('INSERT INTO users (username, password) VALUES ($1, $2)', [username, hashed]);
    res.json({ message: 'Registrasi berhasil!' });
});

app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
    const user = result.rows[0];
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
app.post('/api/upload', authMiddleware, upload.single('image'), async (req, res) => {
    if (!req.file) return res.status(400).json({ message: 'Tidak ada file yang diupload' });
    try {
        const result = await new Promise((resolve, reject) => {
            cloudinary.uploader.upload_stream({ folder: 'blog' }, (error, result) => {
                if (error) reject(error);
                else resolve(result);
            }).end(req.file.buffer);
        });
        res.json({ url: result.secure_url });
    } catch (error) {
        res.status(500).json({ message: 'Gagal upload gambar' });
    }
});
// =================== ARTIKEL ===================
app.get('/api/articles', async (req, res) => {
    const articles = await pool.query('SELECT * FROM articles ORDER BY created_at DESC');
    const result = await Promise.all(articles.rows.map(async a => {
        const comments = await pool.query('SELECT * FROM comments WHERE article_id = $1', [a.id]);
        return { ...a, comments: comments.rows };
    }));
    res.json(result);
});

app.post('/api/articles', authMiddleware, async (req, res) => {
    const { title, tag, content, imageUrl } = req.body;
    if (!title || !content) return res.status(400).json({ message: 'Judul dan isi wajib diisi' });
    const date = new Date().toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' });
    const result = await pool.query(
        'INSERT INTO articles (title, tag, content, author, date, image_url) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
        [title, tag, content, req.user.username, date, imageUrl || null]
    );
    res.json({ message: 'Artikel berhasil dibuat!', article: result.rows[0] });
});

app.get('/api/articles/:id', async (req, res) => {
    const article = await pool.query('SELECT * FROM articles WHERE id = $1', [req.params.id]);
    if (article.rows.length === 0) return res.status(404).json({ message: 'Artikel tidak ditemukan' });
    const comments = await pool.query('SELECT * FROM comments WHERE article_id = $1', [req.params.id]);
    res.json({ ...article.rows[0], comments: comments.rows });
});

app.delete('/api/articles/:id', authMiddleware, async (req, res) => {
    const article = await pool.query('SELECT * FROM articles WHERE id = $1', [req.params.id]);
    if (article.rows.length === 0) return res.status(404).json({ message: 'Artikel tidak ditemukan' });
    const isAdmin = req.user.username === process.env.ADMIN;
    if (article.rows[0].author !== req.user.username && !isAdmin) return res.status(403).json({ message: 'Tidak punya izin' });
    await pool.query('DELETE FROM comments WHERE article_id = $1', [req.params.id]);
    await pool.query('DELETE FROM articles WHERE id = $1', [req.params.id]);
    res.json({ message: 'Artikel berhasil dihapus!' });
});

// =================== KOMENTAR ===================
app.post('/api/articles/:id/comments', authMiddleware, upload.single('image'), async (req, res) => {
    const article = await pool.query('SELECT * FROM articles WHERE id = $1', [req.params.id]);
    if (article.rows.length === 0) return res.status(404).json({ message: 'Artikel tidak ditemukan' });
    const date = new Date().toLocaleDateString('id-ID');
    let imageUrl = null;
    if (req.file) {
        const result = await new Promise((resolve, reject) => {
            cloudinary.uploader.upload_stream({ folder: 'blog' }, (error, result) => {
                if (error) reject(error);
                else resolve(result);
            }).end(req.file.buffer);
        });
        imageUrl = result.secure_url;
    }
    const text = req.body.text || '';
    if (!text && !imageUrl) return res.status(400).json({ message: 'Komentar tidak boleh kosong!' });
    await pool.query(
        'INSERT INTO comments (article_id, author, text, image_url, date) VALUES ($1, $2, $3, $4, $5)',
        [req.params.id, req.user.username, text, imageUrl, date]
    );
    const comments = await pool.query('SELECT * FROM comments WHERE article_id = $1', [req.params.id]);
    res.json({ message: 'Komentar ditambahkan!', comments: comments.rows });
});

// =================== START ===================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server jalan di http://localhost:${PORT}`);
});