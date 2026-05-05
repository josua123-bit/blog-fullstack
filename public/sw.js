// sw.js — taruh di folder public/
self.addEventListener('push', function(event) {
    const data = event.data ? event.data.json() : {};
    const title = data.title || 'for heal';
    const options = {
        body: data.body || '',
        icon: '/icon.png', // opsional, bisa dihapus kalau ga ada icon
        badge: '/icon.png',
        data: { url: data.url || '/' }
    };
    event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', function(event) {
    event.notification.close();
    const url = event.notification.data?.url || '/';
    event.waitUntil(clients.openWindow(url));
});