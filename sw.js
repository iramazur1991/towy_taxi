/* TOWY TAXI service worker: offline cache + push notifications */
try {
  importScripts('https://www.gstatic.com/firebasejs/10.14.1/firebase-app-compat.js',
                'https://www.gstatic.com/firebasejs/10.14.1/firebase-messaging-compat.js');
  firebase.initializeApp({ apiKey: "AIzaSyCymQ-rMRexbui_M6UiFvA9NX2fr9wM34M", authDomain: "towy-taxi.firebaseapp.com",
    projectId: "towy-taxi", messagingSenderId: "545252559547", appId: "1:545252559547:web:c370e91c47fa02ff63b79e" });
  firebase.messaging();
} catch (e) {}
const CACHE='towy-v9';
const ASSETS=['./','./index.html','./driver.html','./core.js','./style.css','./manifest.json','./driver-manifest.json','./icon-192.png','./icon-512.png','./driver-icon-192.png','./driver-icon-512.png'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS)).catch(()=>{}));self.skipWaiting()});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(x=>x!==CACHE).map(x=>caches.delete(x)))));self.clients.claim()});
self.addEventListener('fetch',e=>{
  if(e.request.method!=='GET'||new URL(e.request.url).origin!==location.origin)return;
  e.respondWith(fetch(e.request).then(r=>{const c=r.clone();caches.open(CACHE).then(x=>x.put(e.request,c));return r}).catch(()=>caches.match(e.request)));
});
