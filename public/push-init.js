// push-init.js — taruh di folder public/, include di semua halaman HTML
// <script src="push-init.js"></script>

async function initPushNotification() {
    const token = localStorage.getItem('token');
    if (!token) return; // hanya untuk user yang login
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return; // browser tidak support

    try {
        // Register service worker
        const reg = await navigator.serviceWorker.register('/sw.js');

        // Cek permission
        const permission = await Notification.requestPermission();
        if (permission !== 'granted') return;

        // Ambil VAPID public key dari server
        const keyRes = await fetch('/api/push/vapid-key');
        const { publicKey } = await keyRes.json();

        // Subscribe
        const subscription = await reg.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlBase64ToUint8Array(publicKey)
        });

        // Kirim subscription ke server
        await fetch('/api/push/subscribe', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + token
            },
            body: JSON.stringify({ subscription })
        });

    } catch (err) {
        console.log('Push notification tidak aktif:', err);
    }
}

function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const rawData = window.atob(base64);
    const outputArray = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; ++i) {
        outputArray[i] = rawData.charCodeAt(i);
    }
    return outputArray;
}

// Jalankan otomatis
initPushNotification();