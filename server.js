const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const multer = require('multer');
const { Pool } = require('pg');
const cloudinary = require('cloudinary').v2;

cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

const app = express();

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// ================= UPLOAD =================
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const allowed = [
            'image/jpeg','image/png','image/webp','image/gif',
            'audio/mpeg','audio/wav','audio/ogg','audio/webm'
        ];
        cb(null, allowed.includes(file.mimetype));
    }
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ================= DB =================
async function setupDB() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS users (
            id SERIAL PRIMARY KEY,
            username TEXT UNIQUE,
            password TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS articles (
            id SERIAL PRIMARY KEY,
            title TEXT,
            tag TEXT,
            content TEXT,
            author TEXT,
            date TEXT,
            image_url TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            deleted_at TIMESTAMP,
            deleted_by TEXT
        );

        CREATE TABLE IF NOT EXISTS comments (
            id SERIAL PRIMARY KEY,
            article_id INT,
            author TEXT,
            text TEXT,
            image_url TEXT,
            date TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            deleted_at TIMESTAMP,
            deleted_by TEXT
        );

        CREATE TABLE IF NOT EXISTS likes (
            id SERIAL PRIMARY KEY,
            article_id INT,
            username TEXT,
            UNIQUE(article_id, username)
        );

        CREATE TABLE IF NOT EXISTS til (
            id SERIAL PRIMARY KEY,
            username TEXT,
            content TEXT,
            date TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            deleted_at TIMESTAMP,
            deleted_by TEXT
        );

        CREATE TABLE IF NOT EXISTS quotes (
            id SERIAL PRIMARY KEY,
            username TEXT,
            content TEXT,
            author TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            deleted_at TIMESTAMP,
            deleted_by TEXT
        );

        CREATE TABLE IF NOT EXISTS voice_notes (
            id SERIAL PRIMARY KEY,
            username TEXT,
            title TEXT,
            url TEXT,
            date TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            deleted_at TIMESTAMP,
            deleted_by TEXT
        );
    `);

    console.log("DB siap");
}
setupDB();


// ================= AUTH =================
app.post('/api/register', async (req, res) => {
    const { username, password } = req.body;

    const exist = await pool.query('SELECT * FROM users WHERE username=$1', [username]);
    if (exist.rows.length) return res.status(400).json({ message: 'Username sudah ada' });

    const hash = await bcrypt.hash(password, 10);
    await pool.query('INSERT INTO users(username,password) VALUES($1,$2)', [username, hash]);

    res.json({ message: 'Register berhasil' });
});

app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;

    const user = (await pool.query('SELECT * FROM users WHERE username=$1',[username])).rows[0];
    if (!user) return res.status(400).json({ message: 'User tidak ada' });

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(400).json({ message: 'Password salah' });

    const token = jwt.sign({ username }, process.env.JWT_SECRET, { expiresIn:'7d' });
    res.json({ token, username });
});

function auth(req,res,next){
    const token = req.headers.authorization?.split(' ')[1];
    if(!token) return res.status(401).json({message:'No token'});
    try{
        req.user = jwt.verify(token, process.env.JWT_SECRET);
        next();
    }catch{
        res.status(401).json({message:'Invalid token'});
    }
}

function admin(req,res,next){
    const token = req.headers.authorization?.split(' ')[1];
    if(!token) return res.status(401).json({message:'No token'});
    const user = jwt.verify(token, process.env.JWT_SECRET);
    if(user.username !== process.env.ADMIN) return res.status(403).json({message:'Not admin'});
    req.user = user;
    next();
}


// ================= UPLOAD =================
app.post('/api/upload', auth, upload.single('file'), async (req,res)=>{
    if(!req.file) return res.status(400).json({message:'No file'});

    const result = await new Promise((resolve,reject)=>{
        cloudinary.uploader.upload_stream(
            {resource_type:'auto'},
            (err,result)=> err ? reject(err) : resolve(result)
        ).end(req.file.buffer);
    });

    res.json({url: result.secure_url});
});


// ================= ARTICLES =================
app.get('/api/articles', async (req,res)=>{
    const data = await pool.query(`
        SELECT * FROM articles 
        WHERE deleted_at IS NULL 
        ORDER BY created_at DESC
    `);
    res.json(data.rows);
});

app.post('/api/articles', auth, async (req,res)=>{
    const {title,tag,content,imageUrl} = req.body;
    const date = new Date().toLocaleDateString('id-ID');

    const result = await pool.query(
        `INSERT INTO articles(title,tag,content,author,date,image_url)
         VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,
        [title,tag,content,req.user.username,date,imageUrl]
    );

    res.json(result.rows[0]);
});

// SOFT DELETE
app.delete('/api/articles/:id', auth, async (req,res)=>{
    const data = await pool.query('SELECT * FROM articles WHERE id=$1',[req.params.id]);
    if(!data.rows.length) return res.status(404).json({message:'Not found'});

    const isAdmin = req.user.username === process.env.ADMIN;

    if(data.rows[0].author !== req.user.username && !isAdmin){
        return res.status(403).json({message:'No access'});
    }

    await pool.query(
        `UPDATE articles SET deleted_at=NOW(), deleted_by=$1 WHERE id=$2`,
        [req.user.username, req.params.id]
    );

    res.json({message:'Artikel dihapus (soft delete)'});
});


// ================= COMMENTS =================
app.get('/api/articles/:id/comments', async (req,res)=>{
    const data = await pool.query(`
        SELECT * FROM comments 
        WHERE article_id=$1 AND deleted_at IS NULL
        ORDER BY created_at DESC
    `,[req.params.id]);

    res.json(data.rows);
});

app.post('/api/articles/:id/comments', auth, async (req,res)=>{
    const {text,imageUrl} = req.body;
    const date = new Date().toLocaleDateString('id-ID');

    await pool.query(
        `INSERT INTO comments(article_id,author,text,image_url,date)
         VALUES($1,$2,$3,$4,$5)`,
        [req.params.id, req.user.username, text, imageUrl, date]
    );

    res.json({message:'Komentar masuk'});
});


// ================= TIL =================
app.get('/api/til', auth, async (req,res)=>{
    const data = await pool.query(`
        SELECT * FROM til 
        WHERE username=$1 AND deleted_at IS NULL
        ORDER BY created_at DESC
    `,[req.user.username]);

    res.json(data.rows);
});

app.delete('/api/til/:id', auth, async (req,res)=>{
    await pool.query(
        `UPDATE til SET deleted_at=NOW(), deleted_by=$1 WHERE id=$2`,
        [req.user.username, req.params.id]
    );
    res.json({message:'TIL dihapus'});
});


// ================= QUOTES =================
app.get('/api/quotes', async (req,res)=>{
    const data = await pool.query(`
        SELECT * FROM quotes 
        WHERE deleted_at IS NULL
        ORDER BY created_at DESC
    `);
    res.json(data.rows);
});

app.delete('/api/quotes/:id', auth, async (req,res)=>{
    await pool.query(
        `UPDATE quotes SET deleted_at=NOW(), deleted_by=$1 WHERE id=$2`,
        [req.user.username, req.params.id]
    );
    res.json({message:'Quote dihapus'});
});


// ================= VOICE =================
app.get('/api/voicenotes', auth, async (req,res)=>{
    const data = await pool.query(`
        SELECT * FROM voice_notes 
        WHERE username=$1 AND deleted_at IS NULL
        ORDER BY created_at DESC
    `,[req.user.username]);

    res.json(data.rows);
});

app.delete('/api/voicenotes/:id', auth, async (req,res)=>{
    await pool.query(
        `UPDATE voice_notes SET deleted_at=NOW(), deleted_by=$1 WHERE id=$2`,
        [req.user.username, req.params.id]
    );
    res.json({message:'VN dihapus'});
});


// ================= ADMIN =================
app.get('/api/admin/all', admin, async (req,res)=>{
    const deleted = await pool.query(`
        SELECT 'artikel' type, title content, author username, deleted_at FROM articles WHERE deleted_at IS NOT NULL
        UNION ALL
        SELECT 'quote', content, username, deleted_at FROM quotes WHERE deleted_at IS NOT NULL
        UNION ALL
        SELECT 'til', content, username, deleted_at FROM til WHERE deleted_at IS NOT NULL
        UNION ALL
        SELECT 'vn', title, username, deleted_at FROM voice_notes WHERE deleted_at IS NOT NULL
        ORDER BY deleted_at DESC
    `);

    res.json({deleted: deleted.rows});
});


const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=>console.log('Server jalan di port', PORT));