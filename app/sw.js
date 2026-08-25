/* untraveld service worker */
const CACHE='untraveld-v3';
const SHELL=['./','./index.html','./manifest.webmanifest','./icon-192.png','./icon-512.png'];
self.addEventListener('install', e=>{ e.waitUntil(caches.open(CACHE).then(c=>c.addAll(SHELL)).catch(()=>{})); self.skipWaiting(); });
self.addEventListener('activate', e=>{ e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==CACHE).map(k=>caches.delete(k))))); self.clients.claim(); });
self.addEventListener('message', e=>{ if(e.data==='skipWaiting') self.skipWaiting(); });
self.addEventListener('fetch', e=>{
  const req=e.request; if(req.method!=='GET') return;
  const url=new URL(req.url);
  if(url.origin===location.origin){
    // El documento HTML (navegación) SIEMPRE fresco de la red, sin caché HTTP,
    // para que un despliegue nuevo se vea sin trucos. Cae a caché solo sin conexión.
    const isDoc = req.mode==='navigate' || (req.headers.get('accept')||'').indexOf('text/html')>=0;
    if(isDoc){
      e.respondWith(
        fetch(new Request(req, {cache:'no-store'}))
          .then(res=>{ const cp=res.clone(); caches.open(CACHE).then(c=>c.put(req,cp)).catch(()=>{}); return res; })
          .catch(()=>caches.match(req).then(r=> r || caches.match('./index.html')))
      );
      return;
    }
    // Resto de recursos propios: red primero, caché de respaldo.
    e.respondWith(
      fetch(req).then(res=>{ const cp=res.clone(); caches.open(CACHE).then(c=>c.put(req,cp)).catch(()=>{}); return res; })
        .catch(()=>caches.match(req).then(r=> r || caches.match('./index.html')))
    );
  }
  /* cross-origin (mapas, Firebase): a la red directamente */
});
