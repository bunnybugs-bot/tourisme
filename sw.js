/* ============================================================
   SERVICE WORKER — Géoportail Thiès
   Stratégies :
   - App shell (HTML, CSS, JS) : réseau d'abord (revalidation), cache en secours
   - GeoJSON : network-first avec fallback cache
   - Tuiles OSM/Esri : cache-first avec limite
   ============================================================ */
   const VERSION = 'v1.5.7';
   const APP_CACHE = `geo-app-${VERSION}`;
   const TILE_CACHE = `geo-tiles-${VERSION}`;
   const DATA_CACHE = `geo-data-${VERSION}`;
   
   const APP_SHELL = [
     './',
     './carte.html',
     './catalogue.html',
     './assets/css/carte.css',
     './assets/css/circuits-themes.css',
     './assets/js/carte.js',
     './assets/js/circuit.js',
     './assets/js/circuit-ui.js',
     './assets/js/sejour.js',
     './assets/js/circuits-themes.js',
     './assets/js/catalogue.js',
     './excursions.html',
     './statistiques.html',
     './contact.html',
     './hebergements.geojson',
     './restaurants.geojson',
     './sites.json',
     './sites_alentours.json',
     './data/prestataires.json',
     './data/limites_communes.geojson',
     './data/frequentation.json',
     './manifest.json',
     'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
     'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
     'https://unpkg.com/leaflet.markercluster@1.5.3/dist/MarkerCluster.css',
     'https://unpkg.com/leaflet.markercluster@1.5.3/dist/MarkerCluster.Default.css',
     'https://unpkg.com/leaflet.markercluster@1.5.3/dist/leaflet.markercluster.js',
   ];
   
   self.addEventListener('install', (event) => {
     event.waitUntil(
       caches.open(APP_CACHE)
         .then(cache => Promise.allSettled(APP_SHELL.map(u => cache.add(u))))
         .then(() => self.skipWaiting())
         .catch(err => console.error('SW install error:', err))
     );
   });
   
   self.addEventListener('activate', (event) => {
     event.waitUntil(
       caches.keys().then(keys => Promise.all(
         keys.filter(k => !k.endsWith(VERSION)).map(k => caches.delete(k))
       )).then(() => self.clients.claim())
     );
   });
   
   self.addEventListener('fetch', (event) => {
     const url = new URL(event.request.url);
   
     // API : toujours le réseau (jamais de cache, le front sait gérer l'échec)
     if (url.pathname.startsWith('/api/')) return;
   
     // Tuiles cartographiques (OSM, Esri, OpenTopoMap, Stamen)
     if (/tile|arcgisonline|opentopomap|stamen/.test(url.hostname)) {
       event.respondWith(
         caches.open(TILE_CACHE).then(cache =>
           cache.match(event.request).then(cached => {
             const fetchPromise = fetch(event.request).then(response => {
               if (response.ok) cache.put(event.request, response.clone());
               return response;
             }).catch(() => cached);
             return cached || fetchPromise;
           })
         )
       );
       return;
     }
   
     // Données GeoJSON
     if (url.pathname.endsWith('.geojson')) {
       event.respondWith(
         fetch(event.request, { cache: 'no-cache' })
           .then(response => {
             if (response.ok) {
               const clone = response.clone();
               caches.open(DATA_CACHE).then(cache => cache.put(event.request, clone));
             }
             return response;
           })
           .catch(() => caches.match(event.request))
       );
       return;
     }
   
     // App shell (HTML/CSS/JS/JSON locaux) : réseau d'abord, cache en secours.
     // Ainsi chaque modification du site est visible immédiatement quand on est en ligne,
     // et l'application reste utilisable hors-ligne.
     if (url.origin === self.location.origin) {
       event.respondWith(
         fetch(event.request, { cache: 'no-cache' })
           .then(response => {
             if (response.ok) {
               const clone = response.clone();
               caches.open(APP_CACHE).then(cache => cache.put(event.request, clone));
             }
             return response;
           })
           .catch(() => caches.match(event.request))
       );
       return;
     }
   
     // Ressources externes (Leaflet, polices…) : cache d'abord
     event.respondWith(
       caches.match(event.request).then(cached => cached || fetch(event.request))
     );
   });