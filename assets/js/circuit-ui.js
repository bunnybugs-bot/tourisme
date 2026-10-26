/* ============================================================
   MON CIRCUIT — liste d'étapes, optimisation de l'ordre, tracé, export
   Dépend de : circuit.js (algorithme) et, au moment des appels, de carte.js
   (map, state, showToast, escapeHtml, fmtDistFr, getUserLocation, API_BASE, fetchJsonTimeout).
   À charger AVANT carte.js (carte.js appelle itinerary.init()).
   ============================================================ */

   const OSRM_URL = 'https://router.project-osrm.org/route/v1/driving/';
   const CIRCUIT_STORAGE_KEY = 'geoportail-thies-circuit-v1';
   
   function fmtDuree(s) {
     const min = Math.round(s / 60);
     if (min < 60) return `${Math.max(1, min)} min`;
     const h = Math.floor(min / 60), m = min % 60;
     return m ? `${h} h ${String(m).padStart(2, '0')}` : `${h} h`;
   }
   
   const itinerary = {
     depart: null,        // { lat, lon, nom }  — facultatif
     steps: [],           // { lat, lon, nom, commune, cat, type, adresse, telephone, horaires, jour? }
     boucle: false,       // revenir au point de départ
     legs: null,          // [{ distance_m, duree_s }] pour chaque trajet (même ordre que tous())
     info: null,          // { distance_m, duree_s, source }
     geometrie: null,     // [[lat, lon], …] tracé routier (OSRM) ou null
     layer: null,
     seq: 0,
   
     // ---------- initialisation ----------
     init() {
       this.layer = L.layerGroup().addTo(map);
       this.badgeEl = document.getElementById('gpItinBadge');
       this.listEl = document.getElementById('gpItinList');
       this.emptyEl = document.getElementById('gpItinEmpty');
       this.actionsEl = document.getElementById('gpItinActions');
       this.summaryEl = document.getElementById('gpItinSummary');
       this.departEl = document.getElementById('gpItinDepart');
       this.loopEl = document.getElementById('gpItinLoop');
   
       document.getElementById('gpItinOptimize').addEventListener('click', () => this.optimiser());
       document.getElementById('gpItinExport').addEventListener('click', () => this.exporter());
       document.getElementById('gpItinClear').addEventListener('click', () => this.clear());
       document.getElementById('gpItinUseLoc').addEventListener('click', () => {
         if (state.userLocation) this.setDepart(state.userLocation, 'Ma position');
         else getUserLocation(ll => this.setDepart(ll, 'Ma position'), true);
       });
       this.loopEl.addEventListener('change', () => { this.boucle = this.loopEl.checked; this.changed(); });
       document.getElementById('gpItineraryBtn').addEventListener('click', () => {
         document.querySelector('.gp-tab[data-tab="itineraire"]').click();
         document.getElementById('gpSidebar').classList.add('open');
       });
       this.restore();
       this.render();
       if (this.steps.length) this.tracer();
     },
   
     // ---------- modifications ----------
     tous() { return this.depart ? [this.depart, ...this.steps] : this.steps.slice(); },
   
     add(props, opts = {}) {
       const lat = props._lat ?? props.lat, lon = props._lon ?? props.lon;
       if (this.steps.some(s => s.nom === props.nom && Math.abs(s.lat - lat) < 1e-6 && Math.abs(s.lon - lon) < 1e-6)) {
         if (!opts.silent) showToast('Étape déjà dans le circuit');
         return false;
       }
       this.steps.push({
         lat, lon, nom: props.nom, commune: props.commune || props.departement || '',
         cat: props.categorie || props.cat || '', type: props.type || '',
         adresse: props.adresse || '', telephone: props.telephone || '', horaires: props.horaires || '',
         jour: props.jour,
       });
       if (!opts.silent) { showToast(`« ${props.nom} » ajouté au circuit`); this.changed(); }
       return true;
     },
     remove(i) { this.steps.splice(i, 1); this.changed(); },
     move(i, dir) {
       const j = i + dir;
       if (j < 0 || j >= this.steps.length) return;
       [this.steps[i], this.steps[j]] = [this.steps[j], this.steps[i]];
       this.steps.forEach(s => { delete s.jour; });   // l'ordre manuel remplace le découpage en jours
       this.changed();
     },
     setDepart(latlng, nom) {
       this.depart = { lat: latlng.lat, lon: latlng.lng ?? latlng.lon, nom: nom || 'Départ' };
       this.changed();
       showToast(`Départ : ${this.depart.nom}`);
     },
     clearDepart() { this.depart = null; this.changed(); },
     clear() {
       this.steps = []; this.depart = null; this.boucle = false; this.loopEl.checked = false;
       this.changed(); showToast('Circuit vidé');
     },
     /** Remplace tout le circuit (utilisé par l'assistant « Préparer mon séjour »). */
     setPlan({ depart, steps, boucle }) {
       this.depart = depart || null;
       this.steps = [];
       steps.forEach(s => this.add(s, { silent: true }));
       this.boucle = !!boucle; this.loopEl.checked = this.boucle;
       this.changed();
     },
     changed() { this.legs = null; this.info = null; this.geometrie = null; this.render(); this.tracer(); this.save(); },
   
     // ---------- optimisation de l'ordre ----------
     /** Calcule l'ordre optimal de `pts` (pts[0] = départ fixe) : API PostGIS, sinon calcul local. */
     async calculerOrdre(pts, boucle) {
       try {
         const r = await fetch(`${API_BASE}/api/circuit`, {
           method: 'POST', headers: { 'Content-Type': 'application/json' },
           body: JSON.stringify({ points: pts.map(p => ({ lat: p.lat, lon: p.lon })), boucle }),
           signal: AbortSignal.timeout(5000),
         });
         if (!r.ok) throw new Error(`HTTP ${r.status}`);
         return { res: await r.json(), source: 'PostGIS' };
       } catch (e) {
         return { res: Circuit.optimiser(pts, { boucle }), source: 'navigateur' };
       }
     },
   
     async optimiser() {
       const pts = this.tous();
       if (pts.length < 3) { showToast('Ajoutez au moins 3 points (départ + 2 étapes) pour optimiser'); return; }
       const { res, source } = await this.calculerOrdre(pts, this.boucle);
       const ordre = this.depart ? res.ordre.slice(1).map(i => i - 1) : res.ordre;
       this.steps = ordre.map(i => this.steps[i]);
       this.steps.forEach(s => { delete s.jour; });
       const gain = res.distance_initiale_m - res.distance_m;
       this.changed();
       showToast(gain > 100
         ? `Ordre optimisé (${source}) : ${fmtDistFr(gain)} économisés à vol d'oiseau`
         : `Ordre déjà optimal (${source})`);
     },
   
     // ---------- tracé sur la carte ----------
     async tracer() {
       const seq = ++this.seq;
       this.layer.clearLayers();
       const pts = this.tous();
       if (!pts.length) return;
       const numIcon = (txt, couleur) => L.divIcon({
         className: '', iconSize: [28, 28], iconAnchor: [14, 14],
         html: `<div class="gp-circ-pin" style="background:${couleur}">${txt}</div>`,
       });
       pts.forEach((p, i) => {
         const estDepart = this.depart && i === 0;
         L.marker([p.lat, p.lon], { icon: numIcon(estDepart ? '<i class="fa-solid fa-flag"></i>' : (this.depart ? i : i + 1), estDepart ? '#4D5E43' : '#A16D32'), zIndexOffset: 900 })
           .bindTooltip(escapeHtml(p.nom), { direction: 'top', offset: [0, -12] }).addTo(this.layer);
       });
       if (pts.length < 2) return;
   
       const chemin = pts.slice();
       if (this.boucle && this.depart) chemin.push(this.depart);
       else if (this.boucle) chemin.push(pts[0]);
   
       let ligne, info, legs;
       try {
         const coords = chemin.map(p => `${p.lon},${p.lat}`).join(';');
         const rep = await fetchJsonTimeout(`${OSRM_URL}${coords}?overview=full&geometries=geojson&steps=false`, 6000);
         const route = rep.routes && rep.routes[0];
         if (!route) throw new Error('aucune route');
         ligne = route.geometry.coordinates.map(([lo, la]) => [la, lo]);
         legs = route.legs.map(l => ({ distance_m: l.distance, duree_s: l.duration }));
         info = { distance_m: route.distance, duree_s: route.duration, source: 'routier' };
         this.geometrie = ligne;
       } catch (e) {
         ligne = chemin.map(p => [p.lat, p.lon]);
         legs = [];
         for (let i = 1; i < chemin.length; i++) {
           const d = Circuit.haversine(chemin[i - 1], chemin[i]);
           legs.push({ distance_m: d, duree_s: Circuit.dureeEstimee(d) });
         }
         info = {
           distance_m: legs.reduce((a, l) => a + l.distance_m, 0),
           duree_s: legs.reduce((a, l) => a + l.duree_s, 0), source: 'estimation',
         };
         this.geometrie = null;
       }
       if (seq !== this.seq) return;                      // le circuit a changé entre-temps
       this.legs = legs; this.info = info;
       L.polyline(ligne, {
         color: '#D62828', weight: 5, opacity: 0.85, dashArray: info.source === 'routier' ? null : '8 8',
       }).addTo(this.layer).bringToBack();
       this.render();
     },
     voirSurCarte() {
       const pts = this.tous();
       if (pts.length) map.fitBounds(L.latLngBounds(pts.map(p => [p.lat, p.lon])), { padding: [60, 60] });
     },
   
     // ---------- affichage du panneau ----------
     render() {
       const n = this.steps.length;
       this.badgeEl.style.display = n > 0 ? 'inline-flex' : 'none';
       this.badgeEl.textContent = n;
       this.loopEl.checked = this.boucle;
   
       this.departEl.style.display = this.depart ? 'flex' : 'none';
       if (this.depart) {
         this.departEl.innerHTML = `<i class="fa-solid fa-flag"></i><span><b>Départ</b><small>${escapeHtml(this.depart.nom)}</small></span>
           <button class="gp-itin-remove" title="Retirer le départ"><i class="fa-solid fa-xmark"></i></button>`;
         this.departEl.querySelector('button').addEventListener('click', () => this.clearDepart());
       }
   
       if (n === 0) {
         this.emptyEl.style.display = 'block';
         this.listEl.innerHTML = '';
         this.actionsEl.style.display = 'none';
         return;
       }
       this.emptyEl.style.display = 'none';
       this.actionsEl.style.display = 'block';
   
       const offset = this.depart ? 1 : 0;           // legs[k] = trajet pour atteindre le point k
       let jourCourant = null, html = '';
       this.steps.forEach((s, i) => {
         if (s.jour && s.jour !== jourCourant) {
           jourCourant = s.jour;
           html += `<li class="gp-itin-day"><i class="fa-regular fa-calendar"></i> Jour ${s.jour}</li>`;
         }
         const leg = this.legs && this.legs[i + offset - 1];
         const trajet = leg ? `<small class="gp-itin-leg"><i class="fa-solid fa-arrow-down"></i> ${fmtDistFr(leg.distance_m)} · ${fmtDuree(leg.duree_s)}</small>` : '';
         html += `<li>
           <span class="gp-itin-step-name">${escapeHtml(s.nom)}<small>${escapeHtml([s.type, s.commune].filter(Boolean).join(' · '))}</small>${trajet}</span>
           <span class="gp-itin-move">
             <button data-act="up" data-i="${i}" title="Monter" ${i === 0 ? 'disabled' : ''}><i class="fa-solid fa-chevron-up"></i></button>
             <button data-act="down" data-i="${i}" title="Descendre" ${i === n - 1 ? 'disabled' : ''}><i class="fa-solid fa-chevron-down"></i></button>
           </span>
           <button class="gp-itin-remove" data-act="rm" data-i="${i}" title="Retirer"><i class="fa-solid fa-xmark"></i></button>
         </li>`;
       });
       this.listEl.innerHTML = html;
       this.listEl.querySelectorAll('button[data-act]').forEach(b => b.addEventListener('click', () => {
         const i = +b.dataset.i;
         if (b.dataset.act === 'rm') this.remove(i); else this.move(i, b.dataset.act === 'up' ? -1 : 1);
       }));
   
       if (this.info) {
         const src = this.info.source === 'routier'
           ? 'par la route (OSRM / OpenStreetMap)'
           : 'estimation à vol d\'oiseau × 1,3 à 40 km/h — réseau routier indisponible';
         this.summaryEl.innerHTML = `<strong>${n}</strong> étape${n > 1 ? 's' : ''} · <strong>${fmtDistFr(this.info.distance_m)}</strong> · <strong>${fmtDuree(this.info.duree_s)}</strong> de route<br><small>${src}</small>`;
       } else {
         this.summaryEl.innerHTML = `<strong>${n}</strong> étape${n > 1 ? 's' : ''} · calcul du trajet…`;
       }
       if (typeof gpRenderCircuitTransport === 'function') gpRenderCircuitTransport(this);
     },
   
     // ---------- sauvegarde locale (facultative) ----------
     save() {
       try { localStorage.setItem(CIRCUIT_STORAGE_KEY, JSON.stringify({ depart: this.depart, steps: this.steps, boucle: this.boucle })); }
       catch (e) { /* stockage indisponible : le circuit reste en mémoire */ }
     },
     restore() {
       try {
         const d = JSON.parse(localStorage.getItem(CIRCUIT_STORAGE_KEY) || 'null');
         if (d && Array.isArray(d.steps)) { this.depart = d.depart || null; this.steps = d.steps; this.boucle = !!d.boucle; }
       } catch (e) { /* ignoré */ }
     },
   
     // ---------- export : page imprimable (« Enregistrer au format PDF » dans la boîte d'impression) ----------
     schemaSvg() {
       const pts = this.tous();
       const W = 680, H = 340, M = 34;
       const lat0 = pts.reduce((a, p) => a + p.lat, 0) / pts.length;
       const kx = Math.cos(lat0 * Math.PI / 180);
       const proj = pts.map(p => [p.lon * kx, -p.lat]);
       const geo = this.geometrie ? this.geometrie.map(([la, lo]) => [lo * kx, -la]) : null;
       const tout = proj.concat(geo || []);
       const xs = tout.map(p => p[0]), ys = tout.map(p => p[1]);
       const minx = Math.min(...xs), maxx = Math.max(...xs), miny = Math.min(...ys), maxy = Math.max(...ys);
       const sc = Math.min((W - 2 * M) / ((maxx - minx) || 1e-6), (H - 2 * M) / ((maxy - miny) || 1e-6));
       const ox = (W - sc * (maxx - minx)) / 2, oy = (H - sc * (maxy - miny)) / 2;
       const xy = p => [(ox + sc * (p[0] - minx)).toFixed(1), (oy + sc * (p[1] - miny)).toFixed(1)];
       let chemin = (geo || proj).map(xy);
       if (!geo && this.boucle) chemin.push(xy(proj[0]));
       const pl = chemin.map(c => c.join(',')).join(' ');
       const pastilles = proj.map((p, i) => {
         const [x, y] = xy(p);
         const depart = this.depart && i === 0;
         return `<circle cx="${x}" cy="${y}" r="11" fill="${depart ? '#4D5E43' : '#A16D32'}" stroke="#fff" stroke-width="2"/>
           <text x="${x}" y="${(+y + 4).toFixed(1)}" text-anchor="middle" font-size="11" font-weight="700" fill="#fff">${depart ? 'D' : (this.depart ? i : i + 1)}</text>`;
       }).join('');
       return `<svg viewBox="0 0 ${W} ${H}" width="100%" style="background:#F5F3EE;border-radius:8px;border:1px solid #ddd">
         <polyline points="${pl}" fill="none" stroke="#A16D32" stroke-width="3" ${geo ? '' : 'stroke-dasharray="7 6"'} stroke-linejoin="round"/>${pastilles}</svg>`;
     },
     exporter() {
       if (!this.steps.length) { showToast('Le circuit est vide'); return; }
       const offset = this.depart ? 1 : 0;
       let jourCourant = null, lignes = '';
       this.steps.forEach((s, i) => {
         if (s.jour && s.jour !== jourCourant) { jourCourant = s.jour; lignes += `<h3>Jour ${s.jour}</h3>`; }
         const leg = this.legs && this.legs[i + offset - 1];
         const num = this.depart ? i + 1 : i + 1;
         lignes += `<div class="etape">
           <div class="num">${num}</div>
           <div class="txt"><b>${escapeHtml(s.nom)}</b> <span class="t">${escapeHtml([s.type, s.commune].filter(Boolean).join(' · '))}</span>
             ${s.adresse ? `<div>📍 ${escapeHtml(s.adresse)}</div>` : ''}
             ${s.telephone ? `<div>📞 ${escapeHtml(formatPhone(s.telephone))}</div>` : ''}
             ${s.horaires ? `<div>🕒 ${escapeHtml(s.horaires)}</div>` : ''}
             ${leg ? `<div class="leg">↳ depuis l'étape précédente : ${fmtDistFr(leg.distance_m)} · ${fmtDuree(leg.duree_s)}</div>` : ''}
           </div></div>`;
       });
       const resume = this.info
         ? `${this.steps.length} étape(s) · ${fmtDistFr(this.info.distance_m)} · ${fmtDuree(this.info.duree_s)} de route`
           + (this.info.source === 'routier' ? '' : ' (estimation à vol d\'oiseau)')
         : `${this.steps.length} étape(s)`;
       const html = `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Mon circuit — Région de Thiès</title>
         <style>
           body{font-family:Montserrat,Arial,sans-serif;color:#172431;max-width:760px;margin:24px auto;padding:0 18px}
           h1{font-family:'Playfair Display',Georgia,serif;margin:0 0 4px} .sub{color:#667;margin-bottom:14px}
           h3{margin:18px 0 6px;color:#A16D32;border-bottom:2px solid #A16D32;padding-bottom:3px}
           .etape{display:flex;gap:10px;padding:8px 0;border-bottom:1px solid #eee;break-inside:avoid}
           .num{flex:0 0 26px;height:26px;border-radius:50%;background:#A16D32;color:#fff;font-weight:700;display:flex;align-items:center;justify-content:center;font-size:13px}
           .txt{font-size:13px;line-height:1.5} .t{color:#889;font-size:12px} .leg{color:#4D5E43;font-size:12px}
           .depart{background:#eaf4ee;border-radius:8px;padding:8px 12px;margin:10px 0;font-size:13px}
           .note{font-size:11px;color:#889;margin-top:18px}
           @media print{.noprint{display:none}}
         </style></head><body>
         <button class="noprint" onclick="window.print()" style="float:right;padding:8px 14px">Imprimer / PDF</button>
         <h1>Mon circuit — Région de Thiès</h1>
         <div class="sub">${escapeHtml(resume)} · établi le ${new Date().toLocaleDateString('fr-FR')}</div>
         ${this.schemaSvg()}
         ${this.depart ? `<div class="depart">🚩 <b>Départ :</b> ${escapeHtml(this.depart.nom)}${this.boucle ? ' — retour au point de départ' : ''}</div>` : ''}
         ${lignes}
         <p class="note">Horaires et téléphones : à vérifier avant le déplacement (données du géoportail, certaines non vérifiées).
         Schéma sans fond de carte. Géoportail touristique — Région de Thiès.</p>
         <script>setTimeout(function(){window.print()},400)<\/script></body></html>`;
       const w = window.open('', '_blank');
       if (!w) { showToast('Autorisez les fenêtres pop-up pour exporter le circuit'); return; }
       w.document.write(html); w.document.close();
     },
   };