// public/sw.js — minimal service worker: Android Chrome only shows
// notifications through a registration (turn-alert.js). Tapping the
// "É a sua vez!" notification brings the player's controller tab forward.

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  event.waitUntil((async () => {
    const tabs = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    const tab = tabs.find(c => c.url.includes('/play/')) ?? tabs[0]
    if (tab) return tab.focus()
    return self.clients.openWindow('/')
  })())
})
