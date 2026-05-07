async function loadComments(type, id) {
    const token = localStorage.getItem('token');
    const res = await fetch(`/api/comments/${type}/${id}`, {
        headers: token ? { 'Authorization': 'Bearer ' + token } : {}
    });
    const comments = await res.json();
    renderComments(comments, type, id);
}

function renderComments(comments, type, id) {
    const token = localStorage.getItem('token');
    const currentUser = localStorage.getItem('username');
    const isAdmin = currentUser === 'arekujo001';
    const container = document.getElementById('commentSection');
    if (!container) return;

    container.innerHTML = `
        <div class="comments-box">
            <h3 style="color:#fff; font-size:16px; margin-bottom:20px;">💬 Komentar (${comments.length})</h3>
            <div id="commentList">
                ${comments.length === 0 
                    ? '<p style="color:#444; font-size:14px; padding:20px 0;">Belum ada komentar.</p>'
                    : comments.map(c => {
                        const canDelete = currentUser && (c.author === currentUser || isAdmin);
                        return `
                        <div class="comment-card" id="comment-${c.id}">
                            <div style="display:flex; justify-content:space-between; align-items:flex-start;">
                                <p class="comment-author"><span>${c.author}</span> · ${c.date}</p>
                                ${canDelete ? `<button onclick="deleteComment(${c.id}, '${type}', '${id}')" style="background:transparent; border:none; color:#555; font-size:13px; cursor:pointer; padding:2px 6px; transition:color 0.2s;" onmouseover="this.style.color='#ff6b6b'" onmouseout="this.style.color='#555'">🗑</button>` : ''}
                            </div>
                            ${c.text ? `<p class="comment-text">${c.text}</p>` : ''}
                            ${c.image_url ? `<img src="${c.image_url}" style="width:100%; max-height:300px; object-fit:cover; border-radius:8px; margin-top:10px;" />` : ''}
                            ${c.audio_url ? `<audio controls src="${c.audio_url}" style="width:100%; margin-top:10px;"></audio>` : ''}
                        </div>
                    `}).join('')
                }
            </div>
            ${token ? `
                <div class="comment-form" style="margin-top:24px;">
                    <textarea id="commentText" placeholder="Tulis komentarmu..." style="width:100%; background:#161616; border:1px solid #2a2a2a; border-radius:8px; padding:12px 14px; color:#fff; font-size:15px; outline:none; resize:vertical; min-height:80px; font-family:'Segoe UI',sans-serif;"></textarea>
                    <div style="display:flex; gap:8px; margin-top:10px; flex-wrap:wrap; align-items:center;">
                        <label style="color:#555; font-size:13px; cursor:pointer; display:flex; align-items:center; gap:6px;">
                            📷 <input type="file" id="commentImage" accept="image/*" style="display:none;" onchange="previewFile(this, 'imagePreview')" />
                            Foto
                        </label>
                        <label style="color:#555; font-size:13px; cursor:pointer; display:flex; align-items:center; gap:6px;">
                            🎙️ <input type="file" id="commentAudio" accept="audio/*" style="display:none;" onchange="previewFile(this, 'audioPreview')" />
                            Voice
                        </label>
                        <button onclick="recordVoiceComment()" id="recordCommentBtn" style="background:transparent; border:1px solid #333; border-radius:6px; padding:5px 12px; color:#aaa; font-size:13px; cursor:pointer;">🎙️ Rekam</button>
                        <button onclick="submitComment('${type}', '${id}')" style="background:#fff; color:#000; border:none; border-radius:8px; padding:8px 20px; font-size:14px; font-weight:600; cursor:pointer; margin-left:auto;">Kirim</button>
                    </div>
                    <img id="imagePreview" style="display:none; width:100%; max-height:150px; object-fit:cover; border-radius:8px; margin-top:8px;" />
                    <audio id="audioPreview" style="display:none; width:100%; margin-top:8px;" controls></audio>
                    <p id="commentError" style="color:#ff6b6b; font-size:13px; margin-top:8px; display:none;"></p>
                    <p id="commentSuccess" style="color:#6bffb8; font-size:13px; margin-top:8px; display:none;"></p>
                </div>
            ` : '<p style="color:#555; font-size:14px; margin-top:20px;"><a href="login.html" style="color:#aaa;">Masuk</a> untuk berkomentar.</p>'}
        </div>
    `;
}

async function deleteComment(commentId, type, id) {
    const token = localStorage.getItem('token');
    if (!token) return;
    if (!confirm('Hapus komentar ini?')) return;
    try {
        const res = await fetch(`/api/comments/${commentId}`, {
            method: 'DELETE',
            headers: { 'Authorization': 'Bearer ' + token }
        });
        if (res.ok) {
            // UI diupdate via Socket.IO, jadi ga perlu loadComments lagi
            // Tapi kalau Socket.IO ga connect, fallback ke reload
            if (typeof socket === 'undefined' || !socket.connected) {
                loadComments(type, id);
            }
        } else {
            const data = await res.json();
            alert(data.message || 'Gagal menghapus.');
        }
    } catch {
        alert('Gagal terhubung ke server.');
    }
}

function previewFile(input, previewId) {
    const file = input.files[0];
    if (!file) return;
    const preview = document.getElementById(previewId);
    preview.src = URL.createObjectURL(file);
    preview.style.display = 'block';
}

let recordedAudioBlob = null;
let mediaRecorderComment = null;

async function recordVoiceComment() {
    const btn = document.getElementById('recordCommentBtn');
    if (!mediaRecorderComment || mediaRecorderComment.state === 'inactive') {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        mediaRecorderComment = new MediaRecorder(stream);
        const chunks = [];
        mediaRecorderComment.ondataavailable = e => chunks.push(e.data);
        mediaRecorderComment.onstop = () => {
            recordedAudioBlob = new Blob(chunks, { type: 'audio/webm' });
            const preview = document.getElementById('audioPreview');
            preview.src = URL.createObjectURL(recordedAudioBlob);
            preview.style.display = 'block';
            stream.getTracks().forEach(t => t.stop());
        };
        mediaRecorderComment.start();
        btn.textContent = '⏹️ Stop';
        btn.style.color = '#ff6b6b';
    } else {
        mediaRecorderComment.stop();
        btn.textContent = '🎙️ Rekam';
        btn.style.color = '#aaa';
    }
}

async function submitComment(type, id) {
    const token = localStorage.getItem('token');
    const text = document.getElementById('commentText')?.value.trim();
    const imageFile = document.getElementById('commentImage')?.files[0];
    const audioFile = document.getElementById('commentAudio')?.files[0];
    const errorEl = document.getElementById('commentError');
    const successEl = document.getElementById('commentSuccess');

    errorEl.style.display = 'none';
    successEl.style.display = 'none';

    if (!text && !imageFile && !audioFile && !recordedAudioBlob) {
        errorEl.textContent = 'Komentar tidak boleh kosong!';
        errorEl.style.display = 'block';
        return;
    }

    const formData = new FormData();
    if (text) formData.append('text', text);
    if (imageFile) formData.append('image', imageFile);
    if (audioFile) formData.append('audio', audioFile);
    if (recordedAudioBlob) formData.append('audio', recordedAudioBlob, 'voice.webm');

    try {
        const res = await fetch(`/api/comments/${type}/${id}`, {
            method: 'POST',
            headers: { 'Authorization': 'Bearer ' + token },
            body: formData
        });
        const data = await res.json();
        if (!res.ok) {
            errorEl.textContent = data.message;
            errorEl.style.display = 'block';
            return;
        }
        successEl.textContent = 'Komentar terkirim!';
        successEl.style.display = 'block';
        recordedAudioBlob = null;
        
        // Render ulang komentar
        renderComments(data.comments, type, id);
    } catch {
        errorEl.textContent = 'Gagal terhubung ke server.';
        errorEl.style.display = 'block';
    }
}