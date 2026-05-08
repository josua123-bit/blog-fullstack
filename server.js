require('dotenv').config();
console.log('🔑 VAPID_PUBLIC_KEY:', process.env.VAPID_PUBLIC_KEY);

const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const multer = require('multer');
const fs = require('fs');
const { Pool } = require('pg');
const cloudinary = require('cloudinary').v2;
const webpush = require('web-push');
const http = require('http');
const { Server: SocketIOServer } = require('socket.io');

cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

webpush.setVapidDetails(
    'mailto:' + (process.env.ADMIN_EMAIL || 'admin@forheal.app'),
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
);

const app = express();

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

const storage = multer.memoryStorage();
const upload = multer({
    storage,
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const allowedTypes = [
            'image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp',
            'audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/webm', 'audio/mp4'
        ];
        if (allowedTypes.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('Hanya gambar & audio yang diperbolehkan!'), false);
        }
    }
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// =================== SOCKET.IO SETUP ===================
const server = http.createServer(app);
const io = new SocketIOServer(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Object buat tracking online users
const onlineUsers = new Map(); // key: socket.id, value: username

io.on('connection', (socket) => {
    console.log(`🟢 User connected: ${socket.id}`);

    // User login/identifikasi diri
    socket.on('user-join', (username) => {
        onlineUsers.set(socket.id, username);
        socket.username = username;
        console.log(`👤 ${username} online`);
        
        // Kirim list online users ke semua client
        io.emit('online-users', Array.from(new Set(onlineUsers.values())));
    });

    // User disconnect
    socket.on('disconnect', () => {
        console.log(`🔴 User disconnected: ${socket.id}`);
        const username = onlineUsers.get(socket.id);
        onlineUsers.delete(socket.id);
        if (username) {
            io.emit('online-users', Array.from(new Set(onlineUsers.values())));
        }
    });

    // Join ke room artikel tertentu (biar real-time comment spesifik)
    socket.on('join-article', (articleId) => {
        socket.join(`article-${articleId}`);
        console.log(`📄 ${socket.username || socket.id} joined article-${articleId}`);
    });

    // Leave room artikel
    socket.on('leave-article', (articleId) => {
        socket.leave(`article-${articleId}`);
        console.log(`📄 ${socket.username || socket.id} left article-${articleId}`);
    });

    // Join ke room global content (TIL, Quotes, Voice Notes)
    socket.on('join-content', (contentType) => {
        socket.join(`content-${contentType}`);
        console.log(`📦 ${socket.username || socket.id} joined content-${contentType}`);
    });
    
    // Leave room content
    socket.on('leave-content', (contentType) => {
        socket.leave(`content-${contentType}`);
        console.log(`📦 ${socket.username || socket.id} left content-${contentType}`);
    });
});

// Helper function buat broadcast real-time
function broadcastToArticle(articleId, eventName, data) {
    io.to(`article-${articleId}`).emit(eventName, data);
}

function broadcastToContent(contentType, eventName, data) {
    io.to(`content-${contentType}`).emit(eventName, data);
}

function broadcastToAll(eventName, data) {
    io.emit(eventName, data);
}

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
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS likes (
            id SERIAL PRIMARY KEY,
            article_id INTEGER NOT NULL,
            username TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(article_id, username)
        );
        CREATE TABLE IF NOT EXISTS til (
            id SERIAL PRIMARY KEY,
            username TEXT NOT NULL,
            content TEXT NOT NULL,
            date TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS quotes (
            id SERIAL PRIMARY KEY,
            username TEXT NOT NULL,
            content TEXT NOT NULL,
            author TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS voice_notes (
            id SERIAL PRIMARY KEY,
            username TEXT NOT NULL,
            title TEXT NOT NULL,
            url TEXT NOT NULL,
            date TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS push_subscriptions (
            id SERIAL PRIMARY KEY,
            username TEXT NOT NULL,
            subscription JSONB NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(username, subscription)
        );
    `);

    // Migration soft delete
    try { await pool.query(`ALTER TABLE articles ADD COLUMN deleted_at TIMESTAMP`); } catch {}
    try { await pool.query(`ALTER TABLE articles ADD COLUMN deleted_by TEXT`); } catch {}
    try { await pool.query(`ALTER TABLE quotes ADD COLUMN deleted_at TIMESTAMP`); } catch {}
    try { await pool.query(`ALTER TABLE quotes ADD COLUMN deleted_by TEXT`); } catch {}
    try { await pool.query(`ALTER TABLE til ADD COLUMN deleted_at TIMESTAMP`); } catch {}
    try { await pool.query(`ALTER TABLE til ADD COLUMN deleted_by TEXT`); } catch {}
    try { await pool.query(`ALTER TABLE voice_notes ADD COLUMN deleted_at TIMESTAMP`); } catch {}
    try { await pool.query(`ALTER TABLE voice_notes ADD COLUMN deleted_by TEXT`); } catch {}
    try { await pool.query(`ALTER TABLE comments ADD COLUMN deleted_at TIMESTAMP`); } catch {}
    try { await pool.query(`ALTER TABLE comments ADD COLUMN deleted_by TEXT`); } catch {}
    try { await pool.query(`ALTER TABLE comments ADD COLUMN target_type TEXT DEFAULT 'article'`); } catch {}
    try { await pool.query(`ALTER TABLE comments ADD COLUMN target_id INTEGER`); } catch {}
    try { await pool.query(`UPDATE comments SET target_type = 'article', target_id = article_id WHERE target_type IS NULL`); } catch {}
    try { await pool.query(`ALTER TABLE comments ADD COLUMN audio_url TEXT`); } catch {}
    try { await pool.query(`ALTER TABLE comments ALTER COLUMN article_id DROP NOT NULL`); } catch {}
    
    // Migration profile
    try { await pool.query(`ALTER TABLE users ADD COLUMN bio TEXT`); } catch {}
    try { await pool.query(`ALTER TABLE users ADD COLUMN avatar_url TEXT`); } catch {}

    console.log('Database siap!');
}

setupDB();

// =================== HELPER PUSH ===================
async function sendPushToUser(username, payload) {
    try {
        const subs = await pool.query('SELECT subscription FROM push_subscriptions WHERE username = $1', [username]);
        for (const row of subs.rows) {
            try {
                await webpush.sendNotification(row.subscription, JSON.stringify(payload));
            } catch (err) {
                // Subscription expired/invalid, hapus dari DB
                if (err.statusCode === 410 || err.statusCode === 404) {
                    await pool.query('DELETE FROM push_subscriptions WHERE subscription = $1', [JSON.stringify(row.subscription)]);
                }
            }
        }
    } catch {}
}

async function sendPushToAll(payload, excludeUsername = null) {
    try {
        const subs = await pool.query(
            excludeUsername
                ? 'SELECT username, subscription FROM push_subscriptions WHERE username != $1'
                : 'SELECT username, subscription FROM push_subscriptions',
            excludeUsername ? [excludeUsername] : []
        );
        for (const row of subs.rows) {
            try {
                await webpush.sendNotification(row.subscription, JSON.stringify(payload));
            } catch (err) {
                if (err.statusCode === 410 || err.statusCode === 404) {
                    await pool.query('DELETE FROM push_subscriptions WHERE subscription = $1', [JSON.stringify(row.subscription)]);
                }
            }
        }
    } catch {}
}

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

// =================== PROFILE ===================
app.get('/api/user/:username', async (req, res) => {
    const { username } = req.params;
    const user = await pool.query(
        'SELECT id, username, bio, avatar_url, created_at FROM users WHERE username = $1',
        [username]
    );
    if (!user.rows.length) return res.status(404).json({ message: 'User tidak ditemukan' });

    const articles = await pool.query(
        'SELECT id, title, tag, content, date, image_url, created_at FROM articles WHERE author = $1 AND deleted_at IS NULL ORDER BY created_at DESC',
        [username]
    );
    const til = await pool.query(
        'SELECT * FROM til WHERE username = $1 AND deleted_at IS NULL ORDER BY created_at DESC',
        [username]
    );
    const quotes = await pool.query(
        'SELECT * FROM quotes WHERE username = $1 AND deleted_at IS NULL ORDER BY created_at DESC',
        [username]
    );

    res.json({
        ...user.rows[0],
        articles: articles.rows,
        til: til.rows,
        quotes: quotes.rows
    });
});

app.put('/api/user/profile', authMiddleware, upload.single('avatar'), async (req, res) => {
    const { bio } = req.body;
    let avatarUrl = null;

    if (req.file) {
        const result = await new Promise((resolve, reject) => {
            cloudinary.uploader.upload_stream({ folder: 'avatars', resource_type: 'image' }, (error, result) => {
                if (error) reject(error);
                else resolve(result);
            }).end(req.file.buffer);
        });
        avatarUrl = result.secure_url;
    }

    const fields = [];
    const values = [];
    let i = 1;

    if (bio !== undefined) { fields.push(`bio = $${i++}`); values.push(bio); }
    if (avatarUrl) { fields.push(`avatar_url = $${i++}`); values.push(avatarUrl); }
    if (!fields.length) return res.status(400).json({ message: 'Tidak ada yang diupdate' });

    values.push(req.user.username);
    await pool.query(
        `UPDATE users SET ${fields.join(', ')} WHERE username = $${i}`,
        values
    );

    const updated = await pool.query(
        'SELECT id, username, bio, avatar_url, created_at FROM users WHERE username = $1',
        [req.user.username]
    );
    res.json({ message: 'Profil diupdate!', user: updated.rows[0] });
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

function adminMiddleware(req, res, next) {
    const token = req.headers['authorization']?.split(' ')[1];
    if (!token) return res.status(401).json({ message: 'Token tidak ada' });
    try {
        const user = jwt.verify(token, process.env.JWT_SECRET);
        if (user.username !== process.env.ADMIN) return res.status(403).json({ message: 'Bukan admin' });
        req.user = user;
        next();
    } catch {
        res.status(401).json({ message: 'Token tidak valid' });
    }
}

// =================== PUSH NOTIFICATION ===================
// Kirim VAPID public key ke frontend
app.get('/api/push/vapid-key', (req, res) => {
    res.json({ publicKey: process.env.VAPID_PUBLIC_KEY });
});

// Simpan subscription user
app.post('/api/push/subscribe', authMiddleware, async (req, res) => {
    const { subscription } = req.body;
    if (!subscription) return res.status(400).json({ message: 'Subscription tidak ada' });
    try {
        await pool.query(
            'INSERT INTO push_subscriptions (username, subscription) VALUES ($1, $2) ON CONFLICT DO NOTHING',
            [req.user.username, JSON.stringify(subscription)]
        );
        res.json({ message: 'Subscribed!' });
    } catch {
        res.status(500).json({ message: 'Gagal subscribe' });
    }
});

// Hapus subscription (unsubscribe)
app.post('/api/push/unsubscribe', authMiddleware, async (req, res) => {
    const { subscription } = req.body;
    await pool.query(
        'DELETE FROM push_subscriptions WHERE username = $1 AND subscription = $2',
        [req.user.username, JSON.stringify(subscription)]
    );
    res.json({ message: 'Unsubscribed!' });
});

// =================== UPLOAD ===================
app.post('/api/upload', authMiddleware, upload.single('image'), async (req, res) => {
    if (!req.file) return res.status(400).json({ message: 'Tidak ada file yang diupload' });
    try {
        const result = await new Promise((resolve, reject) => {
            cloudinary.uploader.upload_stream({ folder: 'blog', resource_type: 'auto' }, (error, result) => {
                if (error) reject(error);
                else resolve(result);
            }).end(req.file.buffer);
        });
        res.json({ url: result.secure_url });
    } catch {
        res.status(500).json({ message: 'Gagal upload gambar' });
    }
});

// =================== ARTIKEL ===================
app.get('/api/articles', async (req, res) => {
    const articles = await pool.query('SELECT * FROM articles WHERE deleted_at IS NULL ORDER BY created_at DESC');
    const result = await Promise.all(articles.rows.map(async a => {
    const comments = await pool.query(`
        SELECT c.*, u.avatar_url 
        FROM comments c
        LEFT JOIN users u ON u.username = c.author
        WHERE (c.article_id = $1 OR (c.target_type = $2 AND c.target_id = $1)) AND c.deleted_at IS NULL 
        ORDER BY c.created_at ASC
    `, [a.id, 'article']);
        const likes = await pool.query('SELECT COUNT(*) FROM likes WHERE article_id = $1', [a.id]);
        return { ...a, comments: comments.rows, likes: parseInt(likes.rows[0].count) };
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

    // Real-time broadcast artikel baru
    broadcastToAll('new-article', { 
        article: result.rows[0]
    });

    // Kirim notif ke semua user (kecuali yang nulis)
    sendPushToAll({
        title: '📝 Artikel Baru!',
        body: `${req.user.username} nulis "${title}"`,
        url: `/artikel.html?id=${result.rows[0].id}`
    }, req.user.username);

    res.json({ message: 'Artikel berhasil dibuat!', article: result.rows[0] });
});

app.get('/api/articles/:id', async (req, res) => {
    const article = await pool.query(`
        SELECT a.*, u.avatar_url 
        FROM articles a
        LEFT JOIN users u ON u.username = a.author
        WHERE a.id = $1 AND a.deleted_at IS NULL
    `, [req.params.id]);
    if (article.rows.length === 0) return res.status(404).json({ message: 'Artikel tidak ditemukan' });
    const comments = await pool.query(`
        SELECT c.*, u.avatar_url 
        FROM comments c
        LEFT JOIN users u ON u.username = c.author
        WHERE (c.article_id = $1 OR (c.target_type = $2 AND c.target_id = $1)) AND c.deleted_at IS NULL 
        ORDER BY c.created_at ASC
    `, [req.params.id, 'article']);
    const likes = await pool.query('SELECT COUNT(*) FROM likes WHERE article_id = $1', [req.params.id]);
    res.json({ ...article.rows[0], comments: comments.rows, likes: parseInt(likes.rows[0].count) });
});

app.delete('/api/articles/:id', authMiddleware, async (req, res) => {
    const article = await pool.query('SELECT * FROM articles WHERE id = $1', [req.params.id]);
    if (article.rows.length === 0) return res.status(404).json({ message: 'Artikel tidak ditemukan' });
    const isAdmin = req.user.username === process.env.ADMIN;
    if (article.rows[0].author !== req.user.username && !isAdmin) {
        return res.status(403).json({ message: 'Tidak punya izin' });
    }
    await pool.query(
        'UPDATE articles SET deleted_at = NOW(), deleted_by = $1 WHERE id = $2',
        [req.user.username, req.params.id]
    );

    // Real-time broadcast artikel dihapus
    broadcastToAll('article-deleted', { articleId: parseInt(req.params.id) });

    res.json({ message: 'Artikel berhasil dihapus!' });
});

// =================== LIKES ===================
app.post('/api/articles/:id/like', authMiddleware, async (req, res) => {
    const { id } = req.params;
    const username = req.user.username;
    const existing = await pool.query('SELECT * FROM likes WHERE article_id = $1 AND username = $2', [id, username]);
    if (existing.rows.length > 0) {
        await pool.query('DELETE FROM likes WHERE article_id = $1 AND username = $2', [id, username]);
        const count = await pool.query('SELECT COUNT(*) FROM likes WHERE article_id = $1', [id]);

        // Real-time broadcast unlike
        broadcastToArticle(parseInt(id), 'like-updated', {
            articleId: parseInt(id),
            liked: false,
            count: parseInt(count.rows[0].count),
            username: username
        });

        return res.json({ liked: false, count: parseInt(count.rows[0].count) });
    }
    await pool.query('INSERT INTO likes (article_id, username) VALUES ($1, $2)', [id, username]);
    const count = await pool.query('SELECT COUNT(*) FROM likes WHERE article_id = $1', [id]);

    // Real-time broadcast like
    broadcastToArticle(parseInt(id), 'like-updated', {
        articleId: parseInt(id),
        liked: true,
        count: parseInt(count.rows[0].count),
        username: username
    });

    // Notif ke penulis artikel
    const article = await pool.query('SELECT author, title FROM articles WHERE id = $1', [id]);
    if (article.rows.length > 0 && article.rows[0].author !== username) {
        sendPushToUser(article.rows[0].author, {
            title: '❤️ Ada yang suka artikelmu!',
            body: `${username} menyukai "${article.rows[0].title}"`,
            url: `/artikel.html?id=${id}`
        });
    }

    res.json({ liked: true, count: parseInt(count.rows[0].count) });
});

app.get('/api/articles/:id/likes', async (req, res) => {
    const { id } = req.params;
    const count = await pool.query('SELECT COUNT(*) FROM likes WHERE article_id = $1', [id]);
    const token = req.headers['authorization']?.split(' ')[1];
    let liked = false;
    if (token) {
        try {
            const user = jwt.verify(token, process.env.JWT_SECRET);
            const existing = await pool.query('SELECT * FROM likes WHERE article_id = $1 AND username = $2', [id, user.username]);
            liked = existing.rows.length > 0;
        } catch {}
    }
    res.json({ count: parseInt(count.rows[0].count), liked });
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

    const comments = await pool.query(
        'SELECT c.*, u.avatar_url FROM comments c LEFT JOIN users u ON u.username = c.author WHERE c.article_id = $1 AND c.deleted_at IS NULL ORDER BY c.created_at ASC',
        [req.params.id]
    );

    // Real-time broadcast komentar baru
    broadcastToAll('new-comment', {
        articleId: parseInt(req.params.id),
        comment: comments.rows[comments.rows.length - 1],
        allComments: comments.rows
    });

    // Notif ke penulis artikel
    if (article.rows[0].author !== req.user.username) {
        sendPushToUser(article.rows[0].author, {
            title: '💬 Komentar Baru!',
            body: `${req.user.username} komen di "${article.rows[0].title}"`,
            url: `/artikel.html?id=${req.params.id}`
        });
    }

    res.json({ message: 'Komentar ditambahkan!', comments: comments.rows });
});

// =================== TODAY I LEARNED ===================
app.get('/api/til', async (req, res) => {
    const result = await pool.query(`
        SELECT t.*, u.avatar_url 
        FROM til t
        LEFT JOIN users u ON u.username = t.username
        WHERE t.deleted_at IS NULL 
        ORDER BY t.created_at DESC
    `);
    res.json(result.rows);
});

app.post('/api/til', authMiddleware, async (req, res) => {
    const { content } = req.body;
    if (!content) return res.status(400).json({ message: 'Isi tidak boleh kosong' });
    const date = new Date().toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    const result = await pool.query(
        'INSERT INTO til (username, content, date) VALUES ($1, $2, $3) RETURNING *',
        [req.user.username, content, date]
    );

    // Ambil avatar_url user
    const user = await pool.query('SELECT avatar_url FROM users WHERE username = $1', [req.user.username]);

    // Real-time broadcast TIL baru
    broadcastToContent('til', 'new-til', { 
        til: {
            ...result.rows[0],
            avatar_url: user.rows[0]?.avatar_url
        }
    });

    // Notif ke semua user
    sendPushToAll({
        title: '📓 TIL Baru!',
        body: `${req.user.username}: "${content.substring(0, 60)}..."`,
        url: '/til.html'
    }, req.user.username);

    res.json({ message: 'TIL ditambahkan!', til: result.rows[0] });
});

app.delete('/api/til/:id', authMiddleware, async (req, res) => {
    const til = await pool.query('SELECT * FROM til WHERE id = $1', [req.params.id]);
    if (til.rows.length === 0) return res.status(404).json({ message: 'Tidak ditemukan' });
    if (til.rows[0].username !== req.user.username) return res.status(403).json({ message: 'Tidak punya izin' });
    await pool.query('UPDATE til SET deleted_at = NOW(), deleted_by = $1 WHERE id = $2', [req.user.username, req.params.id]);

    // Real-time broadcast TIL dihapus
    broadcastToContent('til', 'til-deleted', { id: parseInt(req.params.id) });

    res.json({ message: 'Berhasil dihapus!' });
});

// =================== QUOTES ===================
app.get('/api/quotes', async (req, res) => {
    const result = await pool.query(`
        SELECT q.*, u.avatar_url 
        FROM quotes q
        LEFT JOIN users u ON u.username = q.username
        WHERE q.deleted_at IS NULL 
        ORDER BY q.created_at DESC LIMIT 20
    `);
    res.json(result.rows);
});

app.post('/api/quotes', authMiddleware, async (req, res) => {
    const { content, author } = req.body;
    if (!content) return res.status(400).json({ message: 'Quote tidak boleh kosong' });
    const result = await pool.query(
        'INSERT INTO quotes (username, content, author) VALUES ($1, $2, $3) RETURNING *',
        [req.user.username, content, author || null]
    );

    // Ambil avatar_url user
    const user = await pool.query('SELECT avatar_url FROM users WHERE username = $1', [req.user.username]);

    // Real-time broadcast Quote baru
    broadcastToContent('quotes', 'new-quote', { 
        quote: {
            ...result.rows[0],
            avatar_url: user.rows[0]?.avatar_url
        }
    });

    // Notif ke semua user
    sendPushToAll({
        title: '💬 Quote Baru!',
        body: `${req.user.username}: "${content.substring(0, 60)}"`,
        url: '/quotes.html'
    }, req.user.username);

    res.json({ message: 'Quote ditambahkan!', quote: result.rows[0] });
});

app.delete('/api/quotes/:id', authMiddleware, async (req, res) => {
    const quote = await pool.query('SELECT * FROM quotes WHERE id = $1', [req.params.id]);
    if (quote.rows.length === 0) return res.status(404).json({ message: 'Tidak ditemukan' });
    const isAdmin = req.user.username === process.env.ADMIN;
    if (quote.rows[0].username !== req.user.username && !isAdmin) return res.status(403).json({ message: 'Tidak punya izin' });
    await pool.query('UPDATE quotes SET deleted_at = NOW(), deleted_by = $1 WHERE id = $2', [req.user.username, req.params.id]);

    // Real-time broadcast Quote dihapus
    broadcastToContent('quotes', 'quote-deleted', { id: parseInt(req.params.id) });

    res.json({ message: 'Berhasil dihapus!' });
});

// =================== VOICE NOTES ===================
app.get('/api/voicenotes', async (req, res) => {
    const result = await pool.query(`
        SELECT v.*, u.avatar_url 
        FROM voice_notes v
        LEFT JOIN users u ON u.username = v.username
        WHERE v.deleted_at IS NULL 
        ORDER BY v.created_at DESC
    `);
    res.json(result.rows);
});

app.post('/api/voicenotes', authMiddleware, async (req, res) => {
    const { title, url } = req.body;
    if (!url) return res.status(400).json({ message: 'URL tidak boleh kosong' });
    const date = new Date().toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    const result = await pool.query(
        'INSERT INTO voice_notes (username, title, url, date) VALUES ($1, $2, $3, $4) RETURNING *',
        [req.user.username, title || 'Voice Note', url, date]
    );

    // Ambil avatar_url user
    const user = await pool.query('SELECT avatar_url FROM users WHERE username = $1', [req.user.username]);

    // Real-time broadcast Voice Note baru
    broadcastToContent('voicenotes', 'new-voicenote', { 
        voiceNote: {
            ...result.rows[0],
            avatar_url: user.rows[0]?.avatar_url
        }
    });

    // Notif ke semua user
    sendPushToAll({
        title: '🎙️ Voice Note Baru!',
        body: `${req.user.username} upload voice note: "${title || 'Voice Note'}"`,
        url: '/voicenote.html'
    }, req.user.username);

    res.json({ message: 'Voice note disimpan!', voiceNote: result.rows[0] });
});

app.delete('/api/voicenotes/:id', authMiddleware, async (req, res) => {
    const vn = await pool.query('SELECT * FROM voice_notes WHERE id = $1', [req.params.id]);
    if (vn.rows.length === 0) return res.status(404).json({ message: 'Tidak ditemukan' });
    if (vn.rows[0].username !== req.user.username) return res.status(403).json({ message: 'Tidak punya izin' });
    await pool.query('UPDATE voice_notes SET deleted_at = NOW(), deleted_by = $1 WHERE id = $2', [req.user.username, req.params.id]);

    // Real-time broadcast Voice Note dihapus
    broadcastToContent('voicenotes', 'voicenote-deleted', { id: parseInt(req.params.id) });

    res.json({ message: 'Berhasil dihapus!' });
});

// =================== ADMIN ===================
app.get('/api/admin/users', adminMiddleware, async (req, res) => {
    const users = await pool.query('SELECT id, username, created_at FROM users ORDER BY created_at DESC');
    res.json(users.rows);
});

app.delete('/api/admin/users/:id', adminMiddleware, async (req, res) => {
    const user = await pool.query('SELECT * FROM users WHERE id = $1', [req.params.id]);
    if (user.rows.length === 0) return res.status(404).json({ message: 'User tidak ditemukan' });
    if (user.rows[0].username === process.env.ADMIN) return res.status(403).json({ message: 'Tidak bisa hapus admin' });
    await pool.query('DELETE FROM comments WHERE author = $1', [user.rows[0].username]);
    await pool.query('DELETE FROM likes WHERE username = $1', [user.rows[0].username]);
    await pool.query('DELETE FROM articles WHERE author = $1', [user.rows[0].username]);
    await pool.query('DELETE FROM push_subscriptions WHERE username = $1', [user.rows[0].username]);
    await pool.query('DELETE FROM users WHERE id = $1', [req.params.id]);
    res.json({ message: 'User berhasil dihapus!' });
});

app.get('/api/admin/articles', adminMiddleware, async (req, res) => {
    const articles = await pool.query('SELECT * FROM articles ORDER BY created_at DESC');
    res.json(articles.rows);
});

app.delete('/api/admin/articles/:id', adminMiddleware, async (req, res) => {
    const article = await pool.query('SELECT * FROM articles WHERE id = $1', [req.params.id]);
    if (article.rows.length === 0) return res.status(404).json({ message: 'Artikel tidak ditemukan' });
    await pool.query(
        'UPDATE articles SET deleted_at = NOW(), deleted_by = $1 WHERE id = $2',
        [req.user.username, req.params.id]
    );

    // Real-time broadcast artikel dihapus
    broadcastToAll('article-deleted', { articleId: parseInt(req.params.id) });

    res.json({ message: 'Artikel berhasil dihapus!' });
});

app.delete('/api/admin/quotes/:id', adminMiddleware, async (req, res) => {
    await pool.query('UPDATE quotes SET deleted_at = NOW(), deleted_by = $1 WHERE id = $2', [req.user.username, req.params.id]);

    // Real-time broadcast quote dihapus
    broadcastToContent('quotes', 'quote-deleted', { id: parseInt(req.params.id) });

    res.json({ message: 'Quote dihapus!' });
});

app.delete('/api/admin/til/:id', adminMiddleware, async (req, res) => {
    await pool.query('UPDATE til SET deleted_at = NOW(), deleted_by = $1 WHERE id = $2', [req.user.username, req.params.id]);

    // Real-time broadcast TIL dihapus
    broadcastToContent('til', 'til-deleted', { id: parseInt(req.params.id) });

    res.json({ message: 'TIL dihapus!' });
});

app.delete('/api/admin/voicenotes/:id', adminMiddleware, async (req, res) => {
    await pool.query('UPDATE voice_notes SET deleted_at = NOW(), deleted_by = $1 WHERE id = $2', [req.user.username, req.params.id]);

    // Real-time broadcast Voice Note dihapus
    broadcastToContent('voicenotes', 'voicenote-deleted', { id: parseInt(req.params.id) });

    res.json({ message: 'Voice note dihapus!' });
});

app.get('/api/admin/all', adminMiddleware, async (req, res) => {
    const users = await pool.query('SELECT id, username, created_at FROM users ORDER BY created_at DESC');
    const articles = await pool.query(`
        SELECT a.*, u.avatar_url 
        FROM articles a
        LEFT JOIN users u ON u.username = a.author
        WHERE a.deleted_at IS NULL 
     ORDER BY a.created_at DESC
    `);
    const comments = await pool.query('SELECT * FROM comments WHERE deleted_at IS NULL ORDER BY created_at DESC');
    const quotes = await pool.query('SELECT * FROM quotes WHERE deleted_at IS NULL ORDER BY created_at DESC');
    const til = await pool.query('SELECT * FROM til WHERE deleted_at IS NULL ORDER BY created_at DESC');
    const voiceNotes = await pool.query('SELECT * FROM voice_notes WHERE deleted_at IS NULL ORDER BY created_at DESC');
    const deleted = await pool.query(`
        SELECT 'artikel' as type, id, title as preview, content, author as username, deleted_at, deleted_by FROM articles WHERE deleted_at IS NOT NULL
        UNION ALL
        SELECT 'quote' as type, id, content as preview, content, username, deleted_at, deleted_by FROM quotes WHERE deleted_at IS NOT NULL
        UNION ALL
        SELECT 'til' as type, id, content as preview, content, username, deleted_at, deleted_by FROM til WHERE deleted_at IS NOT NULL
        UNION ALL
         SELECT 'voicenote' as type, id, title as preview, url as content, username, deleted_at, deleted_by FROM voice_notes WHERE deleted_at IS NOT NULL
        UNION ALL
        SELECT 'komentar' as type, id, COALESCE(text, '(foto/audio)') as preview, COALESCE(text, '') as content, author as username, deleted_at, deleted_by FROM comments WHERE deleted_at IS NOT NULL
        ORDER BY deleted_at DESC
    `);
    res.json({
        users: users.rows,
        articles: articles.rows,
        comments: comments.rows,
        quotes: quotes.rows,
        til: til.rows,
        voiceNotes: voiceNotes.rows,
        deleted: deleted.rows
    });
});

app.get('/api/admin/deleted/:type/:id', adminMiddleware, async (req, res) => {
    const { type, id } = req.params;
    let result;
    if (type === 'artikel') result = await pool.query('SELECT * FROM articles WHERE id = $1', [id]);
    else if (type === 'quote') result = await pool.query('SELECT * FROM quotes WHERE id = $1', [id]);
    else if (type === 'til') result = await pool.query('SELECT * FROM til WHERE id = $1', [id]);
    else if (type === 'voicenote') result = await pool.query('SELECT * FROM voice_notes WHERE id = $1', [id]);
    else if (type === 'komentar') result = await pool.query('SELECT * FROM comments WHERE id = $1', [id]);
    else return res.status(400).json({ message: 'Tipe tidak valid' });
    if (!result.rows.length) return res.status(404).json({ message: 'Tidak ditemukan' });
    res.json(result.rows[0]);
});

// =================== UNIVERSAL COMMENTS ===================
app.get('/api/comments/:type/:id', async (req, res) => {
    const { type, id } = req.params;
    const result = await pool.query(`
    SELECT c.*, u.avatar_url 
    FROM comments c
    LEFT JOIN users u ON u.username = c.author
    WHERE c.target_type = $1 AND c.target_id = $2 AND c.deleted_at IS NULL 
    ORDER BY c.created_at ASC
`, [type, id]);
    res.json(result.rows);
});

app.post('/api/comments/:type/:id', authMiddleware, upload.fields([
    { name: 'image', maxCount: 1 },
    { name: 'audio', maxCount: 1 }
]), async (req, res) => {
    const { type, id } = req.params;
    const date = new Date().toLocaleDateString('id-ID');
    let imageUrl = null;
    let audioUrl = null;

    if (req.files?.image) {
        const result = await new Promise((resolve, reject) => {
            cloudinary.uploader.upload_stream({ folder: 'blog', resource_type: 'auto' }, (error, result) => {
                if (error) reject(error);
                else resolve(result);
            }).end(req.files.image[0].buffer);
        });
        imageUrl = result.secure_url;
    }

    if (req.files?.audio) {
        const result = await new Promise((resolve, reject) => {
            cloudinary.uploader.upload_stream({ folder: 'blog', resource_type: 'auto' }, (error, result) => {
                if (error) reject(error);
                else resolve(result);
            }).end(req.files.audio[0].buffer);
        });
        audioUrl = result.secure_url;
    }

    const text = req.body.text || '';
    if (!text && !imageUrl && !audioUrl) return res.status(400).json({ message: 'Komentar tidak boleh kosong!' });

    await pool.query(
        'INSERT INTO comments (target_type, target_id, article_id, author, text, image_url, audio_url, date) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
        [type, id, type === 'article' ? id : null, req.user.username, text, imageUrl, audioUrl, date]
    );

    const comments = await pool.query(
        'SELECT c.*, u.avatar_url FROM comments c LEFT JOIN users u ON u.username = c.author WHERE c.target_type = $1 AND c.target_id = $2 AND c.deleted_at IS NULL ORDER BY c.created_at ASC',
        [type, id]
    );

    // Real-time broadcast komentar baru
    broadcastToContent(type, 'new-content-comment', {
        type,
        id: parseInt(id),
        comment: comments.rows[comments.rows.length - 1],
        allComments: comments.rows
    });

    // Notif ke pemilik konten yang dikomentari
    let ownerUsername = null;
    let contentTitle = '';
    let contentUrl = '';
    if (type === 'article') {
        const r = await pool.query('SELECT author, title FROM articles WHERE id = $1', [id]);
        if (r.rows.length) { ownerUsername = r.rows[0].author; contentTitle = r.rows[0].title; contentUrl = `/artikel.html?id=${id}`; }
    } else if (type === 'til') {
        const r = await pool.query('SELECT username, content FROM til WHERE id = $1', [id]);
        if (r.rows.length) { ownerUsername = r.rows[0].username; contentTitle = r.rows[0].content.substring(0, 40); contentUrl = '/til.html'; }
    } else if (type === 'quote') {
        const r = await pool.query('SELECT username, content FROM quotes WHERE id = $1', [id]);
        if (r.rows.length) { ownerUsername = r.rows[0].username; contentTitle = r.rows[0].content.substring(0, 40); contentUrl = '/quotes.html'; }
    }

    if (ownerUsername && ownerUsername !== req.user.username) {
        sendPushToUser(ownerUsername, {
            title: '💬 Komentar Baru!',
            body: `${req.user.username} komen: "${text.substring(0, 60)}"`,
            url: contentUrl
        });
    }

    res.json({ message: 'Komentar ditambahkan!', comments: comments.rows });
});

// Hapus komentar (soft delete) - oleh author atau admin
app.delete('/api/comments/:id', authMiddleware, async (req, res) => {
    const comment = await pool.query('SELECT * FROM comments WHERE id = $1', [req.params.id]);
    if (comment.rows.length === 0) return res.status(404).json({ message: 'Komentar tidak ditemukan' });
    const isAdmin = req.user.username === process.env.ADMIN;
    if (comment.rows[0].author !== req.user.username && !isAdmin) {
        return res.status(403).json({ message: 'Tidak punya izin' });
    }
    await pool.query(
        'UPDATE comments SET deleted_at = NOW(), deleted_by = $1 WHERE id = $2',
        [req.user.username, req.params.id]
    );

    // Real-time broadcast komentar dihapus
    const deletedComment = comment.rows[0];
    if (deletedComment.article_id) {
        broadcastToArticle(deletedComment.article_id, 'comment-deleted', {
            commentId: parseInt(req.params.id)
        });
    } else if (deletedComment.target_type && deletedComment.target_id) {
        broadcastToContent(deletedComment.target_type, 'comment-deleted', {
            commentId: parseInt(req.params.id)
        });
    }

    res.json({ message: 'Komentar berhasil dihapus!' });
});

// =================== PIN GATE ===================
const WEB_PIN = process.env.WEB_PIN || '03052026';

app.post('/api/verify-pin', (req, res) => {
    const { pin } = req.body;
    if (pin === WEB_PIN) {
        res.json({ success: true });
    } else {
        res.status(401).json({ success: false });
    }
});

// =================== START ===================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Server real-time jalan di http://localhost:${PORT}`);
});