/* ============================================================
   GÉOPORTAIL — Logique principale (version complète)
   ============================================================ */

// ============================================================
// 1. CONFIGURATION
// ============================================================
const GEOJSON_URLS = {
  hebergement: 'hebergements.geojson',
  restaurant:  'restaurants.geojson',
  site:        'sites.json',
  alentour:    'sites_alentours.json',       // sites hors région : fichier séparé
};

const DEPT_COLORS = { THIES: '#A16D32', MBOUR: '#286D73', TIVAOUANE: '#64748B' };   // limites des départements
// Couleur des repères = type de lieu (tons sombres, sobres)
const CAT_COLORS = { hebergement: '#172431', restaurant: '#A16D32', site: '#286D73', presta: '#64748B' };
const CAT_ICONS = { hebergement: 'fa-hotel', restaurant: 'fa-utensils', site: 'fa-mountain-sun', presta: 'fa-route' };
const CAT_LABELS = { hebergement: 'Hébergements', restaurant: 'Restaurants', site: 'Sites touristiques' };
// Période idéale par défaut pour la région de Thiès (Petite Côte et alentours) : saison sèche, climat agréable.
// Un lieu peut avoir la sienne via la propriété « periode_ideale » de son fichier.
const PERIODE_REGION = 'novembre à mars, en saison sèche';
const PERIODE_SOURCE = 'Indication générale pour la Petite Côte — source : Selectour, « Quand partir au Sénégal ». À confirmer selon l\'activité.';
const DEPT_NAMES = { THIES: 'Thiès', MBOUR: 'Mbour', TIVAOUANE: 'Tivaouane' };
// Couches affichées dans « Couches et filtres » (la 4e, « presta », vient de data/prestataires.json)
const LAYERS = [
  { cat: 'hebergement', label: 'Hébergements',           icon: 'fa-hotel' },
  { cat: 'restaurant',  label: 'Restaurants',            icon: 'fa-utensils' },
  { cat: 'site',        label: 'Sites touristiques',     icon: 'fa-mountain-sun' },
  { cat: 'presta',      label: 'Excursions & activités', icon: 'fa-person-hiking' },
];
const SITE_TYPE_LABELS = { naturel: 'Naturel', culturel: 'Culturel', loisir: 'Loisir' };
// Sites « des alentours » : sites touristiques situés HORS des trois départements de la région (aucun département renseigné).
// Ils restent dans la catégorie « site » (recherche, circuit, autour…) mais ont leur propre couleur, leur libellé et leur filtre « Zone ».
const CAT_ALENTOUR = { color: '#8C4A5A', icon: 'fa-compass', label: 'Sites des alentours', un: 'Site des alentours' };
function isAlentour(p) { return !!p && p.categorie === 'site' && !p.departement; }

const BASEMAPS = {
  plan:      { url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', attribution: '&copy; OpenStreetMap', maxZoom: 19 },
  satellite: { url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', attribution: 'Tiles &copy; Esri', maxZoom: 19 },
  relief:    { url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', attribution: '&copy; OpenTopoMap', maxZoom: 17 },
  hybride:   { url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', attribution: 'Tiles &copy; Esri', maxZoom: 19 },
};

// ============================================================
// 2. ÉTAT
// ============================================================
const state = {
  allFeatures: [],
  visibleLayers: {
    hebergement: { visible: true, opacity: 1.0, cluster: null },
    restaurant:  { visible: true, opacity: 1.0, cluster: null },
    site:        { visible: true, opacity: 1.0, cluster: null },
  },
  userLocation: null,
  userLocationMarker: null,
  userAccuracy: null,          // précision de la mesure, en mètres (null = point choisi ou corrigé à la main)
  userAccuracyCircle: null,
  userLocationAt: 0,           // horodatage de la dernière mesure
  userLocationManual: false,   // true : position placée ou corrigée par l'utilisateur lui-même
  rangeCircle: null,
  autourKm: 5,
  dataSource: "",
  measureMode: null,
  measureLayers: [],
};

// ============================================================
// 3. CARTE
// ============================================================
const map = L.map('gpMap', { zoomControl: false }).setView([14.6, -16.95], 10);
L.control.scale({ position: 'bottomleft', metric: true, imperial: false }).addTo(map);

let currentBasemap = null;
let currentBasemapLabels = null;
function setBasemap(key) {
  if (currentBasemap) map.removeLayer(currentBasemap);
  if (currentBasemapLabels) { map.removeLayer(currentBasemapLabels); currentBasemapLabels = null; }
  const cfg = BASEMAPS[key];
  currentBasemap = L.tileLayer(cfg.url, { attribution: cfg.attribution, maxZoom: cfg.maxZoom }).addTo(map);
  currentBasemap.bringToBack();
  if (key === 'hybride') {
    currentBasemapLabels = L.tileLayer(
      'https://stamen-tiles-{s}.a.ssl.fastly.net/toner-labels/{z}/{x}/{y}.png',
      { maxZoom: 18, opacity: 0.9 }
    ).addTo(map);
  }
}
setBasemap('plan');

// ============================================================
// 4. CLUSTERS ADAPTATIFS (Étape 6)
// ============================================================
function createAdaptiveCluster() {
  return L.markerClusterGroup({
    maxClusterRadius: (zoom) => {
      if (zoom <= 8) return 80;
      if (zoom <= 10) return 60;
      if (zoom <= 12) return 45;
      if (zoom <= 14) return 30;
      return 20;
    },
    disableClusteringAtZoom: 16,
    spiderfyOnMaxZoom: true,
    showCoverageOnHover: false,
    zoomToBoundsOnClick: true,
    animate: true,
    animateAddingMarkers: false,
  });
}
// UN SEUL groupe de regroupement pour tous les lieux (hébergements, restaurants, sites, excursions) :
// avec un groupe par catégorie, les bulles se superposaient et chacune ne comptait que sa catégorie
// (« 2 » à l'écran alors qu'une dizaine de lieux se trouvaient dessous).
const gpCluster = createAdaptiveCluster();
function catLayer() {                      // vue d'une catégorie sur le groupe commun (mêmes méthodes qu'avant)
  const list = new Set();
  return {
    addLayer(m) { list.add(m); gpCluster.addLayer(m); return this; },
    clearLayers() { gpCluster.removeLayers([...list]); list.clear(); return this; },
    eachLayer(fn) { list.forEach(fn); },
    hasLayer(m) { return list.has(m); },
    zoomToShowLayer(m, cb) { gpCluster.zoomToShowLayer(m, cb); },
  };
}
state.visibleLayers.hebergement.cluster = catLayer();
state.visibleLayers.restaurant.cluster  = catLayer();
state.visibleLayers.site.cluster        = catLayer();
map.addLayer(gpCluster);

// ============================================================
// 5. ICÔNES
// ============================================================
function makeDivIcon(dept, cat) {
  const alentour = cat === 'site' && !dept;                // site des alentours : couleur et icône propres
  const color = alentour ? CAT_ALENTOUR.color : (CAT_COLORS[cat] || '#64748B');
  const icon = alentour ? CAT_ALENTOUR.icon : (CAT_ICONS[cat] || 'fa-location-dot');
  return L.divIcon({
    className: '',
    html: `<div style="background:${color};width:30px;height:30px;border-radius:50% 50% 50% 0;
           transform:rotate(-45deg);display:flex;align-items:center;justify-content:center;
           box-shadow:0 3px 10px rgba(0,0,0,0.35);border:2px solid #fff;">
           <i class="fa-solid ${icon}" style="transform:rotate(45deg);color:#fff;font-size:13px;"></i></div>`,
    iconSize: [30, 30], iconAnchor: [15, 30], popupAnchor: [0, -28], tooltipAnchor: [16, -16],
  });
}

// ============================================================
// 6. UTILITAIRES
// ============================================================
function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function formatPhone(tel) {
  if (!tel) return '';
  const d = String(tel).replace(/\D/g, '');
  if (d.length === 12 && d.startsWith('221')) return `+221 ${d.slice(3,5)} ${d.slice(5,8)} ${d.slice(8,10)} ${d.slice(10)}`;
  if (d.length === 9) return `+221 ${d.slice(0,2)} ${d.slice(2,5)} ${d.slice(5,7)} ${d.slice(7)}`;
  return tel;
}
// Noms de communes : corrige les doublons/fautes de saisie des fichiers sources
const COMMUNE_ALIAS = { 'KEUR MOUSSEU (KEUR MOUSSA)': 'KEUR MOUSSA', 'TIVAOUNE': 'TIVAOUANE', 'NGUEKOKH': 'NGUEKHOKH', 'NGUEKHOKH ': 'NGUEKHOKH' };
function normCommune(c) {
  if (!c) return '';
  const k = String(c).trim().toUpperCase();
  return COMMUNE_ALIAS[k] || k;
}
function communeLabel(c) {
  return String(c).toLowerCase().replace(/(^|[\s-])\S/g, m => m.toUpperCase()).replace('Thies', 'Thiès');
}
function normaliseHebType(type) {
  const t = (type || '').toLowerCase();
  if (t.includes('hôtes') || t.includes('hotes')) return "Maison / chambre d'hôtes";
  if (t.includes('hôtel') || t.includes('hotel')) return 'Hôtel';
  if (t.includes('auberge')) return 'Auberge';
  if (t.includes('lodge') || t.includes('campement')) return 'Lodge & campement';
  if (t.includes('villa') || t.includes('location') || t.includes('vacances') || t.includes('cottage')) return 'Villa & location de vacances';
  return 'Autre';
}
// Sous-type utilisé par le filtre de chaque couche
function subType(p) {
  if (p.categorie === 'hebergement') return normaliseHebType(p.type);
  if (p.categorie === 'restaurant') return normaliseRestoType(p.type);
  return p.type || 'Autre';
}
function normaliseRestoType(type) {
  const t = (type || '').toLowerCase();
  if (t.includes('bar') && !t.includes('restaurant')) return 'Bar';
  if (t.includes('café') || t.includes('cafe')) return 'Café';
  if (t.includes('glacier')) return 'Glacier';
  if (t.includes('restaurant')) return 'Restaurant';
  return 'Autre';
}

// ============================================================
// 7. POPUPS
// ============================================================
// Aperçu au survol d'un repère (comme Google Maps) : catégorie, nom, commune. Le clic ouvre la fiche complète à droite.
const POPUP_CAT = { hebergement: 'Hébergement', restaurant: 'Restaurant', site: 'Site touristique' };
function buildHoverHtml(p) {
  const type = p.type && String(p.type).toLowerCase() !== (POPUP_CAT[p.categorie] || '').toLowerCase()
    ? ` · ${escapeHtml(SITE_TYPE_LABELS[p.type] || p.type)}` : '';
  const lieu = p.commune ? communeLabel(p.commune) : (p.departement ? `Département de ${DEPT_NAMES[p.departement] || p.departement}` : 'Hors région de Thiès');
  return `<div class="gp-popup-type">${escapeHtml(isAlentour(p) ? CAT_ALENTOUR.un : (POPUP_CAT[p.categorie] || ''))}${type}</div>
    <h4>${escapeHtml(p.nom)}</h4>
    <div class="gp-popup-row"><i class="fa-solid fa-location-dot"></i><span>${escapeHtml(lieu)}</span></div>
    <div class="gp-hover-hint">Cliquez pour voir la fiche complète</div>`;
}
let hoverCard = null;
function hideHoverCard() { if (hoverCard) hoverCard.hidden = true; }
function showHoverCard(marker, props) {
  if (!hoverCard) {
    hoverCard = document.createElement('div');
    hoverCard.className = 'gp-hover-card'; hoverCard.hidden = true;
    map.getContainer().appendChild(hoverCard);
    map.on('movestart zoomstart', hideHoverCard);
  }
  hoverCard.innerHTML = buildHoverHtml(props);
  hoverCard.hidden = false;
  const pt = map.latLngToContainerPoint(marker.getLatLng()), size = map.getSize();
  const w = hoverCard.offsetWidth, h = hoverCard.offsetHeight;
  let x = pt.x - w / 2, y = pt.y - 38 - h;                 // au-dessus du repère, sinon en dessous
  if (y < 8) y = pt.y + 14;
  x = Math.max(8, Math.min(size.x - w - 8, x));
  hoverCard.style.transform = `translate(${x}px, ${y}px)`;
}

// ============================================================
// 8. FILTRES
// ============================================================
function currentFilters() {
  const checked = sel => [...document.querySelectorAll(sel)].map(el => el.value);
  const types = {};
  document.querySelectorAll('.gp-sub-type:checked').forEach(el => { (types[el.dataset.cat] = types[el.dataset.cat] || []).push(el.value); });
  // une couche dont le panneau de filtres existe mais dont rien n'est coché → liste vide (rien d'affiché)
  document.querySelectorAll('.gp-sub-type').forEach(el => { if (!types[el.dataset.cat]) types[el.dataset.cat] = []; });
  const deptEl = document.getElementById('gpDeptSelect'), comEl = document.getElementById('gpCommuneSelect');
  return {
    cats: checked('.gp-cat-filter:checked'),
    dept: deptEl ? deptEl.value : '',
    commune: comEl ? comEl.value : '',
    types,
    milieux: checked('.gp-milieu-filter:checked'),
    zones: checked('.gp-zone-filter:checked'),
    amenities: checked('.gp-amenity-filter:checked'),
    prestaFam: checked('.gp-presta-fam:checked'),
  };
}
// ignoreCat = true : sert à compter ce qui correspond aux filtres même si la couche est décochée
function featureMatches(f, filters, ignoreCat = false) {
  const p = f.properties;
  if (!ignoreCat && !filters.cats.includes(p.categorie)) return false;
  if (filters.dept && p.departement !== filters.dept) return false;
  // Concordance : une commune choisie ne montre QUE les lieux de cette commune
  // (les restaurants n'ont pas encore de commune renseignée : ils sont donc écartés)
  if (filters.commune && p.commune !== filters.commune) return false;
  const sub = filters.types[p.categorie];
  if (sub && !sub.includes(subType(p))) return false;
  if (p.categorie === 'site' && document.querySelector('.gp-zone-filter') && !filters.zones.includes(isAlentour(p) ? 'alentour' : 'region')) return false;
  if (p.categorie === 'hebergement') {
    if (p.milieu && document.querySelector('.gp-milieu-filter') && !filters.milieux.includes(p.milieu)) return false;
    for (const a of filters.amenities) if (p[a] !== true) return false;
  }
  return true;
}
function prestaMatches(p, filters) {
  if (filters.dept && p.departement !== filters.dept) return false;
  if (filters.commune && normCommune(p.commune) !== filters.commune) return false;
  if (document.querySelector('.gp-presta-fam') && !filters.prestaFam.includes(p.famille)) return false;
  return true;
}

// ============================================================
// 9. RENDU
// ============================================================
function attachMarkerHandlers(marker, props) {
  marker.bindTooltip(escapeHtml(props.nom), { permanent: true, direction: 'right', className: 'gp-name-tip' });
  marker.on('mouseover', () => showHoverCard(marker, props));
  marker.on('mouseout', hideHoverCard);
  marker.on('click', () => {
    hideHoverCard();
    drawer.open(props);                                    // clic : la fiche complète s'ouvre directement à droite
    map.panTo([props._lat, props._lon], { animate: true, duration: 0.4 });
  });
}
// Les excursions ne sont proposées que dans les départements où il y en a (données de prestataires.json).
// Hors de ces départements, la couche et le bouton « Quelles excursions ? » sont désactivés.
function syncPrestaAvailability() {
  const deptSel = document.getElementById('gpDeptSelect'), toggle = document.getElementById('gpPrestaToggle');
  if (!deptSel || !toggle) return;
  const dept = deptSel.value, avec = new Set(Object.values(prestaData).map(p => p.departement));
  const dispo = !dept || avec.has(dept) || !Object.keys(prestaData).length;
  const row = toggle.closest('.gp-lyr'), btn = document.querySelector('.gp-need[data-besoin="excursions"]');
  if (!dispo && !toggle.disabled) { toggle.dataset.was = toggle.checked ? '1' : '0'; toggle.checked = false; toggle.disabled = true; }
  else if (dispo && toggle.disabled) { toggle.disabled = false; toggle.checked = toggle.dataset.was !== '0'; }
  else if (!dispo) toggle.checked = false;               // un raccourci a pu le recocher : on le décoche
  if (row) row.classList.toggle('gp-lyr--off', !dispo);
  if (btn) { btn.disabled = !dispo; btn.title = dispo ? '' : 'Aucune excursion recensée dans ce département'; }
  let note = document.getElementById('gpPrestaNote');
  if (!note) {
    note = document.createElement('p'); note.id = 'gpPrestaNote'; note.className = 'gp-hint gp-commune-note'; note.style.display = 'none';
    const ref = document.getElementById('gpCommuneNote'); if (ref) ref.after(note);
  }
  const lieux = [...avec].filter(Boolean).map(d => DEPT_NAMES[d] || d);
  note.innerHTML = `<i class="fa-solid fa-circle-info"></i> Aucune excursion n'est encore recensée dans le département de ${escapeHtml(DEPT_NAMES[dept] || dept)}${lieux.length ? ` (recensées : ${escapeHtml(lieux.join(', '))})` : ''}.`;
  note.style.display = dispo ? 'none' : 'block';
}
(function injectOffCss() {
  const st = document.createElement('style');
  st.textContent = `.gp-lyr--off .gp-lyr-head { opacity: .45; } .gp-lyr--off .gp-lyr-main { cursor: not-allowed; }
  .gp-need:disabled { opacity: .4; cursor: not-allowed; }`;
  document.head.appendChild(st);
})();
function render() {
  syncPrestaAvailability();
  if (document.getElementById('gpCommuneSelect') && state.allFeatures.length) buildCommuneSelect();
  const filters = currentFilters();
  Object.values(state.visibleLayers).forEach(l => l.cluster.clearLayers());
  const matched = { hebergement: 0, restaurant: 0, site: 0 };
  let count = 0;
  state.allFeatures.forEach(f => {
    const cat = f.properties.categorie;
    if (!featureMatches(f, filters, true)) return;       // correspond aux filtres (couche cochée ou non)
    matched[cat] = (matched[cat] || 0) + 1;
    if (!filters.cats.includes(cat)) return;             // couche décochée : pas affichée
    const cfg = state.visibleLayers[cat];
    if (!cfg) return;
    const [lon, lat] = f.geometry.coordinates;
    const props = { ...f.properties, _lat: lat, _lon: lon };
    const marker = L.marker([lat, lon], { icon: makeDivIcon(f.properties.departement, cat), opacity: cfg.opacity });
    attachMarkerHandlers(marker, props);
    cfg.cluster.addLayer(marker);
    count++;
  });
  const pr = renderPresta(filters);
  document.getElementById('gpCount').textContent = count + pr.shown;
  updateLayersUI(filters, matched, pr.matched);
  const sel = currentSelection();
  updateStats(sel);
  applyHeat(sel);
  updateLegend(filters);
  applyNamesVisibility();
  if (typeof syncBesoins === 'function') syncBesoins();
}

// ============================================================
// REPÉRAGE D'UN LIEU : pastille rouge qui le démarque des autres (« Voir sur la carte » depuis le catalogue / les excursions)
// ============================================================
const targetState = { marker: null };
(function injectTargetCss() {
  const st = document.createElement('style');
  st.textContent = `
  .gp-target { filter: drop-shadow(0 3px 5px rgba(0,0,0,.45)); animation: gpTargetDrop .55s cubic-bezier(.3,1.6,.5,1); }
  .gp-target i { font-size: 46px; color: #D62828; -webkit-text-stroke: 2px #fff; paint-order: stroke fill; display: block; line-height: 1; text-align: center; }
  .gp-target::after { content: ''; position: absolute; left: 50%; bottom: -3px; width: 18px; height: 7px; margin-left: -9px; border-radius: 50%;
    background: rgba(214,40,40,.35); animation: gpTargetPulse 1.6s ease-out infinite; z-index: -1; }
  @keyframes gpTargetDrop { from { transform: translateY(-26px); opacity: 0; } to { transform: none; opacity: 1; } }
  @keyframes gpTargetPulse { from { transform: scale(.6); opacity: .9; } to { transform: scale(3); opacity: 0; } }
  .gp-target-lab { background: #D62828; color: #fff; border: 0; font: 700 .72rem 'Montserrat', sans-serif; padding: .15rem .5rem; border-radius: 6px; box-shadow: 0 1px 4px rgba(0,0,0,.35); }
  .gp-target-lab::before { border-top-color: #D62828 !important; }`;
  document.head.appendChild(st);
})();
function clearTarget() { if (targetState.marker) { map.removeLayer(targetState.marker); targetState.marker = null; } }
function highlightTarget(lat, lon, nom) {
  clearTarget();
  const icon = L.divIcon({ className: 'gp-target', iconSize: [46, 46], iconAnchor: [23, 44],
    html: '<i class="fa-solid fa-location-dot"></i>' });
  const m = L.marker([lat, lon], { icon, zIndexOffset: 2000, keyboard: false }).addTo(map);
  if (nom) m.bindTooltip(escapeHtml(nom), { permanent: true, direction: 'top', offset: [0, -44], className: 'gp-target-lab' });
  m.on('click', () => { const f = state.allFeatures.find(x => String(x.properties.nom).toLowerCase() === String(nom).toLowerCase());
    if (f) drawer.open({ ...f.properties, _lat: lat, _lon: lon }); });
  targetState.marker = m;
  map.once('click', clearTarget);                           // un clic sur la carte retire le repère
}

// Lien « Voir sur la carte » du catalogue : carte.html?lat=..&lon=..&z=17 (sans nom, sans filtres) :
// on repère le lieu le plus proche de ce point (≤ 40 m) et on le démarque.
function focusFromCatalogue() {
  const q = new URLSearchParams(location.search);
  if (q.get('lieu') || q.get('cat') || q.get('presta') || q.get('z') !== '17') return;
  const lat = parseFloat(q.get('lat')), lon = parseFloat(q.get('lon'));
  if (!isFinite(lat) || !isFinite(lon)) return;
  let best = null, bd = 40;
  state.allFeatures.forEach(f => { const [x, y] = f.geometry.coordinates; const d = map.distance([lat, lon], [y, x]); if (d < bd) { bd = d; best = f; } });
  if (!best) return;
  const [x, y] = best.geometry.coordinates;
  highlightTarget(y, x, best.properties.nom);
  setTimeout(() => drawer.open({ ...best.properties, _lat: y, _lon: x }), 400);
}

// Lien direct vers un lieu (utilisé par la rubrique « Excursions d'une journée » de la page Excursions) :
//   carte.html?lieu=Nom&lat=..&lon=..                          → se place sur le lieu et ouvre sa fiche
//   carte.html?lieu=Nom&lat=..&lon=..&itineraire=1&dep=lat,lon&depnom=Thiès   → trace l'itinéraire dans le portail
// Les coordonnées lat/lon servent de secours si la base n'a pas encore été rechargée avec ce lieu.
function focusLieuFromUrl() {
  const q = new URLSearchParams(location.search), nom = q.get('lieu');
  if (!nom) return;
  const lat0 = parseFloat(q.get('lat')), lon0 = parseFloat(q.get('lon'));
  const f = state.allFeatures.find(x => String(x.properties.nom).toLowerCase() === nom.toLowerCase());
  let lat, lon, props = null;
  if (f) { [lon, lat] = f.geometry.coordinates; props = { ...f.properties, _lat: lat, _lon: lon }; }
  else if (isFinite(lat0) && isFinite(lon0)) { lat = lat0; lon = lon0; showToast('Ce lieu n\'est pas encore dans la base : relancez « import_data »'); }
  else { showToast('Ce lieu est introuvable sur la carte'); return; }

  if (q.get('itineraire')) {                                   // itinéraire tracé dans le portail
    const dep = (q.get('dep') || '').split(',').map(parseFloat);
    if (dep.length === 2 && dep.every(isFinite)) {              // départ connu : on ne demande pas la position GPS
      routeState.origin = L.latLng(dep[0], dep[1]);
      routeState.originLabel = (q.get('depnom') || 'Départ') + ' (centre-ville)';
      routeState.originGps = false;
    }
    startRoute(lat, lon, f ? f.properties.nom : nom);           // sans départ : le portail mesure la position de l'utilisateur
    return;
  }
  map.flyTo([lat, lon], 16, { duration: 1.2 });
  highlightTarget(lat, lon, f ? f.properties.nom : nom);
  setTimeout(() => {
    if (props) drawer.open(props);
    else L.popup().setLatLng([lat, lon]).setContent(`<strong>${escapeHtml(nom)}</strong>`).openOn(map);
  }, 1300);
}

// ============================================================
// MODE EXCURSION : « Voir sur la carte » depuis la page Excursions
//   carte.html?excursion=lac-rose&dep=14.79,-16.93&depnom=Thiès[&site=Nom]
// Affiche les sites de l'excursion en points numérotés (dans l'ordre de visite optimisé depuis
// le point de départ), atténue le reste de la carte et trace le parcours routier complet.
// Lit directement sites_alentours.json : fonctionne même si la base n'a pas été rechargée.
// ============================================================
const exState = { layer: null, panel: null, markers: {}, req: 0 };
const EX_COLOR = '#8C4A5A';
const EX_THIES = { lat: 14.7910, lon: -16.9359 };

(function injectExcursionCss() {
  const st = document.createElement('style');
  st.textContent = `
  .gp-focus-ex .leaflet-marker-pane > *:not(.gp-ex-icon), .gp-focus-ex .leaflet-shadow-pane > * { opacity: .16 !important; pointer-events: none; }
  .gp-focus-ex .leaflet-overlay-pane svg path:not(.gp-ex-line) { opacity: .25; }
  .gp-ex-pin { width: 34px; height: 34px; border-radius: 50%; background: ${EX_COLOR}; color: #fff; border: 3px solid #fff;
    box-shadow: 0 2px 8px rgba(0,0,0,.45); display: flex; align-items: center; justify-content: center; font: 800 .95rem 'Montserrat', sans-serif; }
  .gp-ex-pin.ancre { width: 40px; height: 40px; font-size: 1.05rem; box-shadow: 0 0 0 4px rgba(140,74,90,.35), 0 2px 8px rgba(0,0,0,.45); }
  .gp-ex-pin.ile { background: #1F6F8B; border-style: dashed; }
  .gp-ex-pin.dep { background: #172431; border-radius: 8px; }
  .gp-ex-pin.port { background: #1F6F8B; border-radius: 8px; }
  .gp-ex-lab { background: #fff; color: #172431; font: 700 .72rem 'Montserrat', sans-serif; padding: .1rem .45rem; border-radius: 6px;
    box-shadow: 0 1px 4px rgba(0,0,0,.35); border: 0; }
  .gp-ex-lab::before { display: none; }
  .gp-ex-panel { position: absolute; left: 12px; bottom: 50px; z-index: 650; width: 330px; max-width: calc(100% - 24px); max-height: 56%; overflow: auto;
    background: #fff; border-radius: 14px; box-shadow: 0 8px 28px rgba(0,0,0,.3); font-size: .8rem; line-height: 1.4; }
  .gp-ex-head { background: ${EX_COLOR}; color: #fff; padding: .7rem .9rem; display: flex; gap: .6rem; align-items: flex-start; position: sticky; top: 0; z-index: 1; }
  .gp-ex-head b { display: block; font-size: .92rem; }
  .gp-ex-head small { opacity: .9; }
  .gp-ex-head button { margin-left: auto; cursor: pointer; border: 0; border-radius: 999px; padding: .35rem .7rem; background: rgba(255,255,255,.2); color: #fff; font: 700 .72rem 'Montserrat', sans-serif; white-space: nowrap; }
  .gp-ex-head button:hover { background: rgba(255,255,255,.35); }
  .gp-ex-sum { padding: .6rem .9rem; border-bottom: 1px solid #eee; color: #444; }
  .gp-ex-sum strong { font-size: 1.15rem; color: #172431; }
  .gp-ex-list { list-style: none; margin: 0; padding: .3rem 0; }
  .gp-ex-list li { display: flex; gap: .6rem; padding: .45rem .9rem; cursor: pointer; align-items: flex-start; }
  .gp-ex-list li:hover { background: #f6f1f2; }
  .gp-ex-list .n { flex: none; width: 24px; height: 24px; border-radius: 50%; background: ${EX_COLOR}; color: #fff; display: flex; align-items: center; justify-content: center; font-weight: 800; font-size: .75rem; }
  .gp-ex-list .n.dep { background: #172431; border-radius: 6px; } .gp-ex-list .n.ile { background: #1F6F8B; } .gp-ex-list .n.port { background: #1F6F8B; border-radius: 6px; }
  .gp-ex-list small { display: block; color: #777; }
  .gp-ex-note { margin: 0; padding: .5rem .9rem; background: #eef6f9; color: #1c4a5b; border-top: 1px solid #dbe9ef; }
  .gp-ex-foot { padding: .6rem .9rem .8rem; display: flex; flex-wrap: wrap; gap: .5rem; align-items: center; }
  .gp-ex-foot a { color: #1a5fb4; font-weight: 700; text-decoration: none; }
  .gp-ex-foot em { color: #a05a00; font-style: normal; }
  @media (max-width: 860px) { .gp-ex-panel { left: 8px; right: 8px; width: auto; max-height: 42%; bottom: 46px; } }`;
  document.head.appendChild(st);
})();

function exPin(label, cls, anchor = 17) {
  return L.divIcon({ className: 'gp-ex-icon', html: `<div class="gp-ex-pin ${cls || ''}">${label}</div>`, iconSize: [anchor * 2, anchor * 2], iconAnchor: [anchor, anchor] });
}
async function exRouteMulti(coords) {                           // coords : [[lon,lat],…] — parcours complet en une requête
  const path = coords.map(c => `${c[0]},${c[1]}`).join(';');
  const bases = [ROUTE_MODES.driving.base, ROUTE_FALLBACK];
  for (const base of bases) {
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 15000);
    try {
      const r = await fetch(`${base}/${path}?overview=full&geometries=geojson&steps=false`, { signal: ctl.signal });
      const j = await r.json();
      if (r.ok && j.code === 'Ok' && j.routes && j.routes.length) return j.routes[0];
    } catch (e) { /* on essaie le serveur suivant */ } finally { clearTimeout(timer); }
  }
  return null;
}
function closeExcursion() {
  exState.req++;
  if (exState.layer) { map.removeLayer(exState.layer); exState.layer = null; }
  if (exState.panel) { exState.panel.remove(); exState.panel = null; }
  map.getContainer().classList.remove('gp-focus-ex');
  history.replaceState(null, '', location.pathname);
}

async function focusExcursionFromUrl() {
  const q = new URLSearchParams(location.search), key = q.get('excursion');
  if (!key) return false;
  let data;
  try { data = await (await fetch('sites_alentours.json', { cache: 'no-cache' })).json(); }
  catch (e) { showToast('Impossible de charger les sites de l\'excursion'); return true; }
  const dest = (data.destinations || {})[key];
  const sites = (data.features || []).filter(f => f.properties.destination === key)
    .map(f => ({ ...f.properties, lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0] }));
  if (!dest || !sites.length) { showToast('Excursion introuvable'); return true; }

  const d = (q.get('dep') || '').split(',').map(parseFloat);
  const dep = d.length === 2 && d.every(isFinite) ? { lat: d[0], lon: d[1] } : EX_THIES;
  const depNom = q.get('depnom') || 'Thiès';

  // Étapes routières : sites accessibles en voiture + embarcadère si l'excursion comprend l'île de Gorée
  const iles = sites.filter(s => s.acces === 'bateau');
  const stops = sites.filter(s => s.acces !== 'bateau').map(s => ({ ...s, kind: 'site' }));
  if (iles.length && dest.embarcadere) stops.push({ nom: dest.embarcadere.nom, lat: dest.embarcadere.lat, lon: dest.embarcadere.lon, kind: 'port', note: dest.embarcadere.note });

  // Ordre de visite : plus proche voisin + 2-opt depuis le départ, avec retour au départ (excursion d'une journée)
  const pts = [dep, ...stops];
  let ordre = pts.map((_, i) => i);
  if (typeof Circuit !== 'undefined' && pts.length > 2) ordre = Circuit.optimiser(pts, { boucle: true }).ordre;
  const visite = ordre.filter(i => i > 0).map(i => stops[i - 1]);
  visite.forEach((s, i) => { s.num = i + 1; });
  const full = [dep, ...visite, dep];

  // Nettoyage d'un éventuel mode précédent puis dessin
  if (exState.layer) map.removeLayer(exState.layer);
  if (exState.panel) exState.panel.remove();
  exState.layer = L.layerGroup().addTo(map); exState.markers = {};
  map.getContainer().classList.add('gp-focus-ex');
  const id = ++exState.req;

  L.marker([dep.lat, dep.lon], { icon: exPin('<i class="fa-solid fa-flag"></i>', 'dep', 17), zIndexOffset: 900 })
    .bindTooltip(`Départ : ${escapeHtml(depNom)}`, { permanent: true, direction: 'bottom', offset: [0, 14], className: 'gp-ex-lab' }).addTo(exState.layer);
  const popup = s => `<strong>${escapeHtml(s.nom)}</strong>${s.description ? `<br>${escapeHtml(s.description)}` : ''}${s.note ? `<br><em>${escapeHtml(s.note)}</em>` : ''}
    ${s.kind === 'site' ? `<br><small>${escapeHtml(s.type || 'Site alentour')}</small>` : ''}`;
  visite.forEach(s => {
    const cls = (s.kind === 'port' ? 'port' : (s.ancre ? 'ancre' : '')), size = s.ancre ? 20 : 17;
    const m = L.marker([s.lat, s.lon], { icon: exPin(s.kind === 'port' ? `<i class="fa-solid fa-anchor"></i>` : s.num, cls, size), zIndexOffset: 800 })
      .bindPopup(popup(s)).bindTooltip(escapeHtml(s.nom), { permanent: true, direction: 'right', offset: [size, 0], className: 'gp-ex-lab' }).addTo(exState.layer);
    exState.markers[s.nom.toLowerCase()] = m;
  });
  iles.forEach(s => {                                           // sites de l'île : points distincts (bleu, bordure pointillée), pas de route
    const m = L.marker([s.lat, s.lon], { icon: exPin('<i class="fa-solid fa-ship"></i>', 'ile', 17), zIndexOffset: 800 })
      .bindPopup(popup({ ...s, note: 'Accès uniquement en bateau depuis le port de Dakar' }))
      .bindTooltip(escapeHtml(s.nom), { permanent: true, direction: 'right', offset: [17, 0], className: 'gp-ex-lab' }).addTo(exState.layer);
    exState.markers[s.nom.toLowerCase()] = m;
  });

  // Cadrage immédiat sur les points, puis tracé routier
  const bounds = L.latLngBounds([[dep.lat, dep.lon], ...sites.map(s => [s.lat, s.lon])]);
  const large = window.innerWidth > 860;                        // le panneau occupe le bas-gauche (ordinateur) ou le bas (mobile)
  map.fitBounds(bounds, { paddingTopLeft: [large ? 380 : 30, 70], paddingBottomRight: [40, large ? 70 : Math.round(window.innerHeight * .45)], maxZoom: 13 });

  // Panneau
  const panel = document.createElement('div');
  panel.className = 'gp-ex-panel';
  exState.panel = panel;
  document.querySelector('.gp-map-wrap').appendChild(panel);
  const render = (route) => {
    const legs = route && route.legs ? route.legs : null;
    let totD, totT, estim = false;
    if (legs && legs.length === full.length - 1) { totD = route.distance; totT = route.duration; }
    else {                                                        // secours : estimation à vol d'oiseau × 1,3
      estim = true; totD = 0; totT = 0;
      for (let i = 0; i < full.length - 1; i++) {
        const dm = Circuit.haversine(full[i], full[i + 1]) * 1.3; totD += dm; totT += Circuit.dureeEstimee(dm / 1.3, 60);
      }
    }
    const leg = i => legs && legs.length === full.length - 1 ? legs[i] : null;
    panel.innerHTML = `
      <div class="gp-ex-head"><i class="fa-solid ${escapeHtml(dest.icone || 'fa-compass')}"></i>
        <div><b>${escapeHtml(dest.titre)}</b><small>Parcours depuis ${escapeHtml(depNom)}</small></div>
        <button type="button" id="gpExQuit"><i class="fa-solid fa-xmark"></i> Quitter</button></div>
      <div class="gp-ex-sum"><strong>${routeDist(totD)}</strong> · <strong>${routeDuree(totT)}</strong> de route, aller-retour${estim ? ' <em style="color:#a05a00">(estimation)</em>' : ''}
        <small style="display:block;color:#777">${visite.length} étape${visite.length > 1 ? 's' : ''}, classée${visite.length > 1 ? 's' : ''} pour limiter les kilomètres.${estim ? ' Le service de routage ne répond pas : tracé en ligne droite.' : ''}</small></div>
      <ul class="gp-ex-list">
        <li data-ll="${dep.lat},${dep.lon}"><span class="n dep"><i class="fa-solid fa-flag"></i></span><div><b>Départ : ${escapeHtml(depNom)}</b></div></li>
        ${visite.map((s, i) => { const l = leg(i); return `<li data-nom="${escapeHtml(s.nom.toLowerCase())}">
          <span class="n ${s.kind === 'port' ? 'port' : ''}">${s.kind === 'port' ? '<i class="fa-solid fa-anchor"></i>' : s.num}</span>
          <div><b>${escapeHtml(s.nom)}</b><small>${l ? `${routeDist(l.distance)} · ${routeDuree(l.duration)} depuis l'étape précédente` : 'étape ' + s.num}</small></div></li>`; }).join('')}
        ${leg(full.length - 2) ? `<li data-ll="${dep.lat},${dep.lon}"><span class="n dep"><i class="fa-solid fa-house"></i></span><div><b>Retour à ${escapeHtml(depNom)}</b><small>${routeDist(leg(full.length - 2).distance)} · ${routeDuree(leg(full.length - 2).duration)}</small></div></li>` : ''}
        ${iles.map(s => `<li data-nom="${escapeHtml(s.nom.toLowerCase())}"><span class="n ile"><i class="fa-solid fa-ship"></i></span><div><b>${escapeHtml(s.nom)}</b><small>à Gorée — accès en bateau</small></div></li>`).join('')}
      </ul>
      ${iles.length && dest.embarcadere ? `<p class="gp-ex-note"><i class="fa-solid fa-anchor"></i> ${escapeHtml(dest.embarcadere.note)}</p>` : ''}`;
    panel.querySelector('#gpExQuit').addEventListener('click', closeExcursion);
    panel.querySelectorAll('.gp-ex-list li').forEach(li => li.addEventListener('click', () => {
      if (li.dataset.nom && exState.markers[li.dataset.nom]) { const m = exState.markers[li.dataset.nom]; map.flyTo(m.getLatLng(), 14, { duration: .8 }); setTimeout(() => m.openPopup(), 850); }
      else if (li.dataset.ll) map.flyTo(li.dataset.ll.split(',').map(Number), 13, { duration: .8 });
    }));
  };
  render(null);

  const route = await exRouteMulti(full.map(p => [p.lon, p.lat]));
  if (id !== exState.req) return true;
  if (route) {
    const ll = route.geometry.coordinates.map(c => [c[1], c[0]]);
    L.polyline(ll, { color: '#fff', weight: 9, opacity: .95, lineCap: 'round', lineJoin: 'round', className: 'gp-ex-line', interactive: false }).addTo(exState.layer);
    L.polyline(ll, { color: '#D62828', weight: 5, opacity: .95, lineCap: 'round', lineJoin: 'round', className: 'gp-ex-line', interactive: false }).addTo(exState.layer);
    exState.layer.eachLayer(l => { if (l instanceof L.Marker) l.setZIndexOffset(900); });
    render(route);
  } else {
    L.polyline(full.map(p => [p.lat, p.lon]), { color: '#D62828', weight: 4, opacity: .8, dashArray: '8 8', className: 'gp-ex-line', interactive: false }).addTo(exState.layer);
  }
  const focus = (q.get('site') || '').toLowerCase();
  if (focus && exState.markers[focus]) { const m = exState.markers[focus]; map.flyTo(m.getLatLng(), 13, { duration: 1 }); setTimeout(() => m.openPopup(), 1100); }
  return true;
}

// Noms affichés à côté des repères (à partir d'un certain zoom pour éviter le fouillis)
function applyNamesVisibility() {
  const chk = document.getElementById('gpShowNames');
  map.getContainer().classList.toggle('gp-hide-names', !(chk && chk.checked && map.getZoom() >= 15));
}

// Meilleur cadrage de la carte sur ce qui est affiché
function fitToVisible() {
  const filters = currentFilters();
  const pts = [];
  state.allFeatures.forEach(f => { if (featureMatches(f, filters)) pts.push([f.geometry.coordinates[1], f.geometry.coordinates[0]]); });
  if (filters.cats.includes('presta')) Object.values(prestaData).forEach(p => { if (prestaMatches(p, filters)) pts.push([p._lat, p._lon]); });
  if (pts.length) map.fitBounds(L.latLngBounds(pts), { padding: [50, 50], maxZoom: 13 });
}

// ============================================================
// 11. COUCHES UI
// ============================================================
// Chaque couche = une case + son compteur + SES filtres (visibles seulement si la couche est cochée)
function chip(cls, cat, value, label, extra = '', checked = true) {
  return `<label class="gp-fchip"><input type="checkbox" class="${cls}" ${cat ? `data-cat="${cat}"` : ''} value="${escapeHtml(value)}" ${checked ? 'checked' : ''}>${extra}<span>${escapeHtml(label)}</span></label>`;
}
function uniqueSorted(cat, fn) {
  const m = new Map();
  state.allFeatures.filter(f => f.properties.categorie === cat).forEach(f => { const k = fn(f.properties); m.set(k, (m.get(k) || 0) + 1); });
  return [...m.entries()].sort((a, b) => b[1] - a[1]).map(e => e[0]);
}
function buildLayerPanels() {
  const container = document.getElementById('gpLayerList');
  const opacity = cat => `
    <div class="gp-sub-group"><div class="gp-sub-title">Opacité</div>
      <div class="gp-layer-opacity"><input type="range" min="10" max="100" value="${state.visibleLayers[cat].opacity * 100}" data-role="opacity" data-cat="${cat}"><span>100%</span></div></div>`;
  const subs = {
    hebergement: () => {
      const types = uniqueSorted('hebergement', normaliseHebTypeProps);
      const piscine = state.allFeatures.some(f => f.properties.categorie === 'hebergement' && f.properties.piscine === true);
      return `<div class="gp-sub-group"><div class="gp-sub-title">Type d'hébergement</div><div class="gp-fchips">${types.map(t => chip('gp-sub-type', 'hebergement', t, t)).join('')}</div></div>
        <div class="gp-sub-group"><div class="gp-sub-title">Milieu</div><div class="gp-fchips">${chip('gp-milieu-filter', '', 'URBAIN', 'Urbain')}${chip('gp-milieu-filter', '', 'RURAL', 'Rural')}</div></div>
        ${piscine ? `<div class="gp-sub-group"><div class="gp-sub-title">Équipement</div><div class="gp-fchips">${chip('gp-amenity-filter', '', 'piscine', 'Piscine', '<i class="fa-solid fa-water"></i>', false)}</div></div>` : ''}
        ${opacity('hebergement')}`;
    },
    restaurant: () => {
      const types = uniqueSorted('restaurant', p => normaliseRestoType(p.type));
      return `<div class="gp-sub-group"><div class="gp-sub-title">Type d'établissement</div><div class="gp-fchips">${types.map(t => chip('gp-sub-type', 'restaurant', t, t)).join('')}</div></div>${opacity('restaurant')}`;
    },
    site: () => {
      const types = uniqueSorted('site', p => p.type || 'Autre');
      const nA = state.allFeatures.filter(f => isAlentour(f.properties)).length;
      const nR = state.allFeatures.filter(f => f.properties.categorie === 'site' && !isAlentour(f.properties)).length;
      const zones = nA ? `<div class="gp-sub-group"><div class="gp-sub-title">Zone</div><div class="gp-fchips">${
        chip('gp-zone-filter', '', 'region', `Région de Thiès (${nR})`, `<i class="gp-dot" style="background:${CAT_COLORS.site}"></i>`)}${
        chip('gp-zone-filter', '', 'alentour', `Alentours (${nA})`, `<i class="gp-dot" style="background:${CAT_ALENTOUR.color}"></i>`)}</div>
        <p class="gp-hint" style="margin:.5rem 0 0"><a href="excursions.html#hors-region"><i class="fa-solid fa-sun"></i> Voir les excursions d'une journée</a></p></div>` : '';
      return `${zones}<div class="gp-sub-group"><div class="gp-sub-title">Type de site</div><div class="gp-fchips">${types.map(t => chip('gp-sub-type', 'site', t, SITE_TYPE_LABELS[t] || t)).join('')}</div></div>${opacity('site')}`;
    },
    presta: () => `<div class="gp-sub-group"><div class="gp-sub-title">Famille</div><div class="gp-fchips">${
      Object.entries(PRESTA_STYLE).map(([k, v]) => chip('gp-presta-fam', '', k, v.l, `<i class="gp-dot" style="background:${v.c}"></i>`)).join('')}</div>
      <p class="gp-hint" style="margin:.5rem 0 0">Cliquez sur un prestataire puis sur « Que trouver autour ? » pour l'analyse de proximité.</p></div>`,
  };
  container.innerHTML = LAYERS.map(l => `
    <div class="gp-lyr" data-cat="${l.cat}">
      <div class="gp-lyr-head">
        <label class="gp-lyr-main">
          <input type="checkbox" class="gp-cat-filter" value="${l.cat}" ${l.cat === 'presta' ? 'id="gpPrestaToggle"' : ''} checked>
          <i class="fa-solid ${l.icon}"></i><span>${l.label}</span>
        </label>
        <span class="gp-lyr-count" data-cat="${l.cat}" title="affichés / total">–</span>
      </div>
      <div class="gp-lyr-sub">${subs[l.cat]()}</div>
    </div>`).join('');

  container.addEventListener('change', (e) => {
    if (e.target.matches('[data-role="opacity"]')) return;
    render(); updateShareUrl();
  });
  container.addEventListener('input', (e) => {
    if (!e.target.matches('[data-role="opacity"]')) return;
    const cat = e.target.dataset.cat, cfg = state.visibleLayers[cat];
    cfg.opacity = e.target.value / 100;
    e.target.nextElementSibling.textContent = `${e.target.value}%`;
    cfg.cluster.eachLayer(m => { const dom = m.getElement(); if (dom) dom.style.opacity = cfg.opacity; });
  });
}
function normaliseHebTypeProps(p) { return normaliseHebType(p.type); }

function updateLayersUI(filters, matched, prestaMatched) {
  const total = { hebergement: 0, restaurant: 0, site: 0, presta: Object.keys(prestaData).length };
  state.allFeatures.forEach(f => { total[f.properties.categorie] = (total[f.properties.categorie] || 0) + 1; });
  const m = { ...matched, presta: prestaMatched };
  document.querySelectorAll('.gp-lyr').forEach(el => {
    const cat = el.dataset.cat;
    el.classList.toggle('on', filters.cats.includes(cat));
    const c = el.querySelector('.gp-lyr-count');
    if (c) c.textContent = `${m[cat] || 0} / ${total[cat] || 0}`;
  });
  updateCommuneNote(filters);
}

// ============================================================
// 12. RECHERCHE
// ============================================================
function buildSearchIndex() {
  return state.allFeatures.map(f => {
    const p = f.properties;
    const [lon, lat] = f.geometry.coordinates;
    return {
      nom: p.nom, commune: p.commune || '', dept: p.departement || '',
      cat: p.categorie, alentour: isAlentour(p), lat, lon,
      search: `${p.nom} ${p.commune || ''} ${p.departement || ''} ${p.type || ''}`.toLowerCase(),
    };
  });
}
function setupSearch() {
  const input = document.getElementById('gpSearchInput');
  const results = document.getElementById('gpSearchResults');
  const clearBtn = document.getElementById('gpSearchClear');
  let index = [];
  input.addEventListener('input', () => {
    const q = input.value.trim().toLowerCase();
    clearBtn.style.display = q ? 'flex' : 'none';
    if (q.length < 2) { results.classList.remove('open'); return; }
    if (index.length === 0) index = buildSearchIndex();
    const matches = index.filter(item => item.search.includes(q)).slice(0, 10);
    if (matches.length === 0) {
      results.innerHTML = `<div class="gp-search-empty">Aucun résultat pour « ${escapeHtml(q)} »</div>`;
    } else {
      results.innerHTML = matches.map(m => `
        <div class="gp-search-item" data-lat="${m.lat}" data-lon="${m.lon}">
          <div class="gp-search-item-icon"><i class="fa-solid ${m.alentour ? CAT_ALENTOUR.icon : CAT_ICONS[m.cat]}"></i></div>
          <div class="gp-search-item-text">
            <strong>${escapeHtml(m.nom)}</strong>
            <small>${escapeHtml(m.commune || m.dept || (m.alentour ? 'Hors région de Thiès' : ''))} — ${m.alentour ? CAT_ALENTOUR.label : CAT_LABELS[m.cat]}</small>
          </div>
        </div>`).join('');
    }
    results.classList.add('open');
    results.querySelectorAll('.gp-search-item').forEach(el => {
      el.addEventListener('click', () => {
        const lat = parseFloat(el.dataset.lat), lon = parseFloat(el.dataset.lon);
        map.flyTo([lat, lon], 16, { duration: 1.2 });
        setTimeout(() => {
          state.allFeatures.forEach(f => {
            const [flon, flat] = f.geometry.coordinates;
            if (Math.abs(flat - lat) < 1e-6 && Math.abs(flon - lon) < 1e-6) {
              const cfg = state.visibleLayers[f.properties.categorie];
              cfg.cluster.eachLayer(m => {
                const ll = m.getLatLng();
                if (Math.abs(ll.lat - lat) < 1e-6 && Math.abs(ll.lng - lon) < 1e-6) m.fire('click');
              });
            }
          });
        }, 1300);
        results.classList.remove('open');
        input.value = '';
        clearBtn.style.display = 'none';
      });
    });
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { results.classList.remove('open'); input.blur(); }
  });
  clearBtn.addEventListener('click', () => {
    input.value = ''; clearBtn.style.display = 'none';
    results.classList.remove('open'); input.focus();
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.gp-search-wrap')) results.classList.remove('open');
  });
}

// ============================================================
// 13. COMMUNES
// ============================================================
// La liste des communes dépend du département choisi (concordance région → communes)
function buildCommuneSelect() {
  const sel = document.getElementById('gpCommuneSelect');
  const dept = document.getElementById('gpDeptSelect').value;
  const prev = sel.value;
  // Les nombres suivent les filtres actifs (couches, types, milieu, équipements…), hors département/commune
  const fl = Object.assign({}, currentFilters(), { dept: '', commune: '' });
  const byDept = {};
  state.allFeatures.forEach(f => {
    const p = f.properties;
    if (!p.commune || !p.departement) return;
    byDept[p.departement] = byDept[p.departement] || {};
    byDept[p.departement][p.commune] = (byDept[p.departement][p.commune] || 0) + (featureMatches(f, fl) ? 1 : 0);
  });
  const opts = d => Object.keys(byDept[d] || {}).sort((a, b) => a.localeCompare(b, 'fr'))
    .map(c => `<option value="${escapeHtml(c)}">${escapeHtml(communeLabel(c))} (${byDept[d][c]})</option>`).join('');
  const depts = dept ? [dept] : Object.keys(DEPT_NAMES);
  sel.innerHTML = '<option value="">Toutes les communes</option>' + depts.map(d => {
    if (!byDept[d]) return '';
    return dept ? opts(d) : `<optgroup label="Département de ${DEPT_NAMES[d]}">${opts(d)}</optgroup>`;
  }).join('');
  sel.value = [...sel.options].some(o => o.value === prev) ? prev : '';
}
function deptOfCommune(c) {
  const f = state.allFeatures.find(x => x.properties.commune === c);
  return f ? f.properties.departement : '';
}
function updateCommuneNote(filters) {
  const note = document.getElementById('gpCommuneNote');
  if (!note) return;
  if (filters.commune && filters.cats.includes('restaurant')) {
    const n = state.allFeatures.filter(f => f.properties.categorie === 'restaurant' && !f.properties.commune && (!filters.dept || f.properties.departement === filters.dept)).length;
    if (n > 0) {                                           // le message n'a de sens que s'il existe des restaurants sans commune
      note.innerHTML = `<i class="fa-solid fa-circle-info"></i> ${n} restaurant${n > 1 ? 's' : ''} de ${filters.dept ? 'ce département' : 'la région'} ${n > 1 ? 'n\'ont' : 'n\'a'} pas de commune renseignée : ${n > 1 ? 'ils ne sont' : 'il n\'est'} pas affiché${n > 1 ? 's' : ''} quand une commune est choisie.`;
      note.style.display = 'block';
    } else note.style.display = 'none';
  } else note.style.display = 'none';
}
function setupWhere() {
  const deptSel = document.getElementById('gpDeptSelect');
  const comSel = document.getElementById('gpCommuneSelect');
  deptSel.addEventListener('change', () => {
    buildCommuneSelect();          // ne garde que les communes du département (et vide la commune si elle n'en fait pas partie)
    render(); updateShareUrl(); fitToVisible();
  });
  comSel.addEventListener('change', () => {
    if (comSel.value && !deptSel.value) {         // commune choisie sans département : on aligne le département
      const keep = comSel.value;
      deptSel.value = deptOfCommune(keep);
      buildCommuneSelect(); comSel.value = keep;
    }
    render(); updateShareUrl(); fitToVisible();
  });
}

// ============================================================
// 14. GÉOLOCALISATION / AUTOUR DE MOI
// ============================================================
// Adresse de l'API (vide = même serveur que le site). Surchargeable : window.GEO_API_BASE = 'http://localhost:5000'
const API_BASE = (typeof window !== 'undefined' && window.GEO_API_BASE) || '';
const AUTOUR_CATS = ['hebergement', 'restaurant', 'site'];
const fmtDistFr = m => m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} km`;

async function fetchJsonTimeout(url, ms = 4000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally { clearTimeout(t); }
}

// Définit le point de référence (position GPS, point choisi sur la carte, ou repère déplacé à la main)
//   accuracy : précision de la mesure en mètres (null si la position n'est pas une mesure)
//   manuel   : true si l'utilisateur l'a placée ou corrigée lui-même
const formatPrecision = m => m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1).replace('.', ',')} km`;

function setAutourCenter(latlng, label, accuracy = null, manuel = false) {
  state.userLocation = L.latLng(latlng.lat, latlng.lng);
  state.userAccuracy = accuracy;
  state.userLocationAt = Date.now();
  state.userLocationManual = manuel;
  if (!state.userLocationMarker) {
    // repère que l'on peut faire glisser : si la position mesurée est fausse, on la corrige d'un geste
    state.userLocationMarker = L.marker(state.userLocation, {
      draggable: true, zIndexOffset: 900, title: 'Faites glisser pour corriger votre position',
      icon: L.divIcon({ className: 'gp-me-dot', html: '<span></span>', iconSize: [24, 24], iconAnchor: [12, 12] }),
    }).addTo(map);
    state.userLocationMarker.on('dragend', () => positionCorrigee(state.userLocationMarker.getLatLng()));
  } else state.userLocationMarker.setLatLng(state.userLocation);
  if (state.userAccuracyCircle) { map.removeLayer(state.userAccuracyCircle); state.userAccuracyCircle = null; }
  if (accuracy && accuracy > 15) {
    state.userAccuracyCircle = L.circle(state.userLocation, { radius: accuracy, color: '#286D73', weight: 1,
      fillColor: '#286D73', fillOpacity: 0.1, interactive: false }).addTo(map);
  }
  const prec = accuracy ? `<br><small>Précision : ± ${formatPrecision(accuracy)}</small>` : '';
  state.userLocationMarker.unbindPopup().bindPopup(`${label}${prec}<br><small>Ce n'est pas ici ? Faites glisser ce repère.</small>`);
  document.getElementById('gpRangeWrap').style.display = 'block';
}

function labelMaPosition() {
  if (state.userLocationManual) return 'Position corrigée';
  return state.userAccuracy ? `Ma position (± ${formatPrecision(state.userAccuracy)})` : 'Ma position';
}

// L'utilisateur a déplacé le repère : c'est désormais sa position de référence (autour de moi, itinéraire, circuit)
function positionCorrigee(latlng) {
  setAutourCenter(latlng, 'Position corrigée', null, true);
  showToast('Position corrigée ✓');
  if (state.rangeCircle) runAutour();
  if (routeState.dest && routeState.originGps && !document.getElementById('gpRoute').hidden) setRouteOrigin(state.userLocation, 'Position corrigée', true);
}

// ---- Mesure de la position ---------------------------------------------------
// Un ordinateur sans GPS renvoie d'abord une position APPROXIMATIVE (Wi-Fi, adresse IP), parfois à plusieurs kilomètres.
// On laisse donc quelques secondes au navigateur pour s'affiner, on garde la MEILLEURE mesure et on affiche sa précision.
const GEO = { watchId: null, timer: null, cap: null };
function arreterSuiviPosition() {
  if (GEO.watchId != null && navigator.geolocation) navigator.geolocation.clearWatch(GEO.watchId);
  GEO.watchId = null;
  clearTimeout(GEO.timer); clearTimeout(GEO.cap);
  GEO.timer = GEO.cap = null;
}
function messageErreurGeo(err) {
  if (err && err.code === 1) return "Localisation refusée : autorisez-la pour ce site (icône à gauche de l'adresse), puis réessayez";
  if (err && err.code === 3) return 'La localisation met trop de temps à répondre';
  return 'Position indisponible sur cet appareil';
}

function getUserLocation(callback, force = false, onError = null) {
  const echec = msg => { if (onError) onError(msg); else showToast(msg + ' — essayez « Choisir un point »', 5000); };
  // une position déjà connue n'est réutilisée que si elle vient de l'utilisateur ou si elle a moins de 2 minutes
  if (!force && state.userLocation && (state.userLocationManual || Date.now() - state.userLocationAt < 120000)) { callback(state.userLocation); return; }
  if (!navigator.geolocation) { echec('Géolocalisation non supportée'); return; }
  if (window.isSecureContext === false) { echec('La localisation exige une connexion sécurisée (https) ou « localhost »'); return; }
  arreterSuiviPosition();
  showToast('Recherche de votre position…');
  let meilleure = null, termine = false;
  const finir = () => {
    if (termine) return;
    termine = true; arreterSuiviPosition();
    const a = meilleure.coords.accuracy;
    setAutourCenter(L.latLng(meilleure.coords.latitude, meilleure.coords.longitude), 'Votre position', a);
    if (a <= 100) showToast(`Position trouvée ✓ (± ${formatPrecision(a)})`);
    else if (a <= 1000) showToast(`Position approximative (± ${formatPrecision(a)}). Faites glisser le repère bleu pour la corriger si besoin`, 6000);
    else {
      showToast(`Position très approximative (± ${formatPrecision(a)}) : cet appareil n'a sans doute pas de GPS. Faites glisser le repère bleu jusqu'à votre vraie position`, 8000);
      state.userLocationMarker.openPopup();
    }
    callback(state.userLocation);
  };
  GEO.watchId = navigator.geolocation.watchPosition(
    (pos) => {
      if (termine) return;
      if (!meilleure || pos.coords.accuracy < meilleure.coords.accuracy) {
        meilleure = pos;                                            // affichage progressif : le repère se précise à l'écran
        setAutourCenter(L.latLng(pos.coords.latitude, pos.coords.longitude), 'Votre position', pos.coords.accuracy);
      }
      if (pos.coords.accuracy <= 40) finir();                       // assez précis : inutile d'attendre
      else if (!GEO.timer) GEO.timer = setTimeout(finir, 7000);     // sinon on laisse 7 s au GPS pour s'affiner
    },
    (err) => { if (meilleure) finir(); else { termine = true; arreterSuiviPosition(); echec(messageErreurGeo(err)); } },
    { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 }
  );
  GEO.cap = setTimeout(() => { if (meilleure) finir(); else if (!termine) { termine = true; arreterSuiviPosition(); echec('Position introuvable'); } }, 20000);
}

function pickAutourPoint() {
  showAutourPanel();
  showToast('Cliquez sur la carte pour choisir le point de départ');
  map.getContainer().style.cursor = 'crosshair';
  map.once('click', (e) => {
    map.getContainer().style.cursor = '';
    setAutourCenter(e.latlng, 'Point de départ choisi', null, true);
    runAutour();
  });
}

function showAutourPanel() {
  const tab = document.querySelector('.gp-tab[data-tab="autour"]');
  if (tab && !tab.classList.contains('active')) tab.click();
}

function runAutour() {
  if (!state.userLocation) { getUserLocation(() => runAutour(), true); return; }
  filterWithinRadius(state.userLocation, state.autourKm || 5);
}

// Requête spatiale côté serveur (PostGIS : ST_DWithin + ST_Distance)
async function fetchAutour(center, radiusKm) {
  const url = `${API_BASE}/api/autour?lat=${center.lat}&lon=${center.lng}&rayon=${radiusKm}`
            + `&categories=${AUTOUR_CATS.join(',')}&limite=1000`;
  return (await fetchJsonTimeout(url)).features;
}
// Repli si l'API n'est pas disponible : même calcul dans le navigateur
function autourLocal(center, radiusKm) {
  return state.allFeatures
    .map(f => {
      const [lon, lat] = f.geometry.coordinates;
      return { ...f, properties: { ...f.properties, distance_m: Math.round(center.distanceTo(L.latLng(lat, lon))) } };
    })
    .filter(f => f.properties.distance_m <= radiusKm * 1000)
    .sort((a, b) => a.properties.distance_m - b.properties.distance_m);
}

let autourSeq = 0;
async function filterWithinRadius(center, radiusKm) {
  const seq = ++autourSeq;
  let proches, source;
  try { proches = await fetchAutour(center, radiusKm); source = 'api'; }
  catch (e) { console.info('API indisponible, calcul local :', e.message); proches = autourLocal(center, radiusKm); source = 'local'; }
  if (seq !== autourSeq) return;                 // une requête plus récente a été lancée entre-temps

  if (state.rangeCircle) map.removeLayer(state.rangeCircle);
  state.rangeCircle = L.circle(center, {
    radius: radiusKm * 1000, color: '#A16D32', fillColor: '#A16D32',
    fillOpacity: 0.08, weight: 2, dashArray: '6 4', interactive: false,
  }).addTo(map);

  const filters = currentFilters();
  Object.values(state.visibleLayers).forEach(l => l.cluster.clearLayers());
  const items = [];
  proches.forEach(f => {
    if (!featureMatches(f, filters)) return;
    const cat = f.properties.categorie;
    const cfg = state.visibleLayers[cat];
    if (!cfg || !cfg.visible) return;
    const [lon, lat] = f.geometry.coordinates;
    const props = { ...f.properties, _lat: lat, _lon: lon };
    const marker = L.marker([lat, lon], { icon: makeDivIcon(f.properties.departement, cat), opacity: cfg.opacity });
    attachMarkerHandlers(marker, props);
    cfg.cluster.addLayer(marker);
    items.push({ props, marker, cat });
  });
  document.getElementById('gpCount').textContent = items.length;
  renderAutourList(items, radiusKm, source);
  map.fitBounds(state.rangeCircle.getBounds(), { padding: [40, 40] });
  showToast(`${items.length} lieu(x) dans un rayon de ${radiusKm} km`);
}

function renderAutourList(items, radiusKm, source) {
  const sum = document.getElementById('gpAutourSummary');
  const ul = document.getElementById('gpAutourList');
  const src = document.getElementById('gpAutourSource');
  if (!sum || !ul || !src) return;
  const n = { site: 0, hebergement: 0, restaurant: 0 };
  items.forEach(i => { n[i.cat] = (n[i.cat] || 0) + 1; });
  sum.innerHTML = items.length
    ? `<b>${items.length}</b> lieu(x) dans ${radiusKm} km : ${n.site} site(s) · ${n.hebergement} hébergement(s) · ${n.restaurant} restaurant(s)`
    : `Aucun lieu dans un rayon de ${radiusKm} km. Essayez un rayon plus grand.`;
  const MAX = 40;
  ul.innerHTML = items.slice(0, MAX).map((it, i) => {
    const p = it.props;
    const color = CAT_COLORS[it.cat] || '#64748B';
    const sousTitre = [p.type, p.commune].filter(Boolean).join(' · ');
    return `<li data-i="${i}" tabindex="0">
      <span class="gp-autour-ico" style="background:${color}"><i class="fa-solid ${CAT_ICONS[it.cat] || 'fa-location-dot'}"></i></span>
      <span class="gp-autour-txt"><b>${escapeHtml(p.nom)}</b><small>${escapeHtml(sousTitre)}</small></span>
      <span class="gp-autour-dist">${fmtDistFr(p.distance_m)}</span>
      <button type="button" class="gp-autour-add" data-i="${i}" title="Ajouter à mon circuit" aria-label="Ajouter à mon circuit"><i class="fa-solid fa-plus"></i></button></li>`;
  }).join('') + (items.length > MAX ? `<li class="gp-autour-more">… et ${items.length - MAX} autre(s) sur la carte</li>` : '');
  state.autourItems = items;
  const btnCirc = document.getElementById('gpAutourToCircuit');
  if (btnCirc) btnCirc.style.display = items.some(it => it.cat === 'site') ? 'flex' : 'none';
  ul.querySelectorAll('.gp-autour-add').forEach(b => b.addEventListener('click', ev => {
    ev.stopPropagation();
    itinerary.add(items[+b.dataset.i].props);
  }));
  ul.querySelectorAll('li[data-i]').forEach(li => {
    const ouvrir = () => {
      const it = items[+li.dataset.i];
      state.visibleLayers[it.cat].cluster.zoomToShowLayer(it.marker, () => it.marker.fire('click'));
    };
    li.addEventListener('click', ouvrir);
    li.addEventListener('keydown', e => { if (e.key === 'Enter') ouvrir(); });
  });
  src.textContent = source === 'api' ? 'Calcul : PostGIS (API)' : 'Calcul : navigateur (API indisponible)';
}

// Autour de moi → circuit : les sites du rayon (zone tampon) sont ordonnés par l'algorithme
async function circuitDepuisAutour(maxSites = 6) {
  const sites = (state.autourItems || []).filter(it => it.cat === 'site').slice(0, maxSites);
  if (!sites.length || !state.userLocation) { showToast('Aucun site dans le rayon'); return; }
  itinerary.setPlan({
    depart: { lat: state.userLocation.lat, lon: state.userLocation.lng, nom: 'Mon point de départ' },
    steps: sites.map(it => it.props), boucle: false,
  });
  await itinerary.optimiser();
  document.querySelector('.gp-tab[data-tab="itineraire"]').click();
  itinerary.voirSurCarte();
}

function clearAutour() {
  autourSeq++;
  if (state.rangeCircle) { map.removeLayer(state.rangeCircle); state.rangeCircle = null; }
  ['gpAutourSummary', 'gpAutourList', 'gpAutourSource'].forEach(id => { const el = document.getElementById(id); if (el) el.innerHTML = ''; });
  document.getElementById('gpRangeWrap').style.display = 'none';
}

// ============================================================
// 15. MESURE
// ============================================================
function enableMeasure(mode) {
  map.pm.disableDraw();
  clearMeasureLayers();
  if (state.measureMode === mode) {
    state.measureMode = null;
    document.querySelectorAll('#gpMeasureDist, #gpMeasureArea').forEach(b => b.classList.remove('active'));
    return;
  }
  state.measureMode = mode;
  document.querySelectorAll('#gpMeasureDist, #gpMeasureArea').forEach(b => b.classList.remove('active'));
  document.getElementById(mode === 'distance' ? 'gpMeasureDist' : 'gpMeasureArea').classList.add('active');
  const shape = mode === 'distance' ? 'Line' : 'Polygon';
  map.pm.enableDraw(shape, {
    snappable: true,
    templineStyle: { color: '#A16D32', weight: 3 },
    hintlineStyle: { color: '#A16D32', dashArray: '5,5' },
    pathOptions: { color: '#A16D32', fillOpacity: 0.15, weight: 3 },
  });
  map.on('pm:create', (e) => {
    const layer = e.layer;
    state.measureLayers.push(layer);
    updateMeasureTooltip(layer, mode);
    layer.on('pm:edit', () => updateMeasureTooltip(layer, mode));
    map.pm.disableDraw();
    state.measureMode = null;
    document.querySelectorAll('#gpMeasureDist, #gpMeasureArea').forEach(b => b.classList.remove('active'));
  });
}
function updateMeasureTooltip(layer, mode) {
  let html = '';
  if (mode === 'distance') {
    const latlngs = layer.getLatLngs();
    const pts = Array.isArray(latlngs[0]) ? latlngs[0] : latlngs;
    let total = 0;
    for (let i = 1; i < pts.length; i++) total += pts[i-1].distanceTo(pts[i]);
    html = total > 1000 ? `${(total/1000).toFixed(2)} km` : `${total.toFixed(0)} m`;
  } else {
    const latlngs = layer.getLatLngs()[0];
    const area = L.GeometryUtil ? L.GeometryUtil.geodesicArea(latlngs) : 0;
    html = area > 1e6 ? `${(area/1e6).toFixed(2)} km²` : `${area.toFixed(0)} m²`;
  }
  layer.bindTooltip(html, { permanent: true, direction: 'center', className: 'gp-measure-tip' }).openTooltip();
}
function clearMeasureLayers() {
  state.measureLayers.forEach(l => map.removeLayer(l));
  state.measureLayers = [];
}

// ============================================================
// 16. COORDONNÉES / FULLSCREEN / SHARE / TOAST
// ============================================================
function setupCoordsDisplay() {
  const el = document.getElementById('gpCoords');
  map.on('mousemove', (e) => {
    el.textContent = `${e.latlng.lat.toFixed(5)}° N, ${e.latlng.lng.toFixed(5)}° E`;
  });
  map.on('mouseout', () => { el.textContent = '—'; });
}
function setupFullscreen() {
  document.getElementById('gpFullscreen').addEventListener('click', () => {
    const wrap = document.querySelector('.gp-map-wrap');
    if (!document.fullscreenElement) {
      wrap.requestFullscreen().then(() => setTimeout(() => map.invalidateSize(), 200));
    } else {
      document.exitFullscreen().then(() => setTimeout(() => map.invalidateSize(), 200));
    }
  });
}
function updateShareUrl() {
  const c = map.getCenter(), z = map.getZoom();
  const params = new URLSearchParams();
  params.set('lat', c.lat.toFixed(5));
  params.set('lon', c.lng.toFixed(5));
  params.set('z', z);
  const fl = currentFilters();
  if (fl.cats.length) params.set('cat', fl.cats.join(','));
  if (fl.dept) params.set('dept', fl.dept);
  if (fl.commune) params.set('commune', fl.commune);
  history.replaceState(null, '', `?${params.toString()}`);
}
function setupShare() {
  document.getElementById('gpShare').addEventListener('click', () => {
    updateShareUrl();
    const url = window.location.href;
    navigator.clipboard.writeText(url)
      .then(() => showToast('Lien de la vue copié dans le presse-papier ✓'))
      .catch(() => showToast('Lien : ' + url));
  });
}
let toastTimer = null;
function showToast(msg, ms = 3000) {
  const t = document.getElementById('gpToast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}
function restoreFromUrl() {
  const p = new URLSearchParams(window.location.search);
  const lat = parseFloat(p.get('lat'));
  const lon = parseFloat(p.get('lon'));
  const z = parseInt(p.get('z'));
  if (!isNaN(lat) && !isNaN(lon) && !isNaN(z)) map.setView([lat, lon], z);
}
// Filtres partagés dans l'URL (couches, département, commune) — à appeler une fois les panneaux construits
function restoreFiltersFromUrl() {
  const p = new URLSearchParams(window.location.search);
  const cat = p.get('cat');
  if (cat) {
    const cats = cat.split(',');
    document.querySelectorAll('.gp-cat-filter').forEach(el => { el.checked = cats.includes(el.value); });
  }
  const dept = (p.get('dept') || '').toUpperCase();
  if (DEPT_NAMES[dept]) document.getElementById('gpDeptSelect').value = dept;
  buildCommuneSelect();
  const com = normCommune(p.get('commune'));
  const sel = document.getElementById('gpCommuneSelect');
  if (com && [...sel.options].some(o => o.value === com)) sel.value = com;
}

// ============================================================
// 17. DRAWER FICHE ÉTABLISSEMENT (Étape 2)
// ============================================================
const drawer = {
  init() {
    this.el = document.getElementById('gpDrawer');
    this.title = document.getElementById('gpDrawerTitle');
    this.type = document.getElementById('gpDrawerType');
    this.loc = document.getElementById('gpDrawerLoc');
    this.info = document.getElementById('gpDrawerInfo');
    this.desc = document.getElementById('gpDrawerDesc');
    this.badges = document.getElementById('gpDrawerBadges');
    this.actions = document.getElementById('gpDrawerActions');
    document.getElementById('gpDrawerClose').addEventListener('click', () => this.close());
  },
  open(props) {
    const catLabel = props.categorie === 'site' ? 'Site touristique'
                   : props.categorie === 'restaurant' ? 'Restauration'
                   : 'Hébergement';
    this.type.textContent = (SITE_TYPE_LABELS[props.type] || props.type || catLabel) + (isAlentour(props) ? ' · ' + CAT_ALENTOUR.un : '');
    this.title.textContent = props.nom;
    const dep = props.departement ? `Département de ${DEPT_NAMES[props.departement] || props.departement}` : (isAlentour(props) ? 'Hors région de Thiès' : '');
    this.loc.innerHTML = `<i class="fa-solid fa-location-dot"></i>${escapeHtml([props.commune ? communeLabel(props.commune) : '', dep].filter(Boolean).join(' · '))}`;

    const rows = [];
    if (isAlentour(props)) rows.push(`<div class="gp-drawer-row"><i class="fa-solid fa-sun"></i><a href="excursions.html#hors-region">Voir les excursions d'une journée hors région</a></div>`);
    if (props.adresse) rows.push(`<div class="gp-drawer-row"><i class="fa-solid fa-location-dot"></i><span>${escapeHtml(props.adresse)}</span></div>`);
    const periode = props.periode_ideale || (isAlentour(props) ? '' : PERIODE_REGION);      // propre au lieu, sinon repère général de la région
    if (periode) rows.push(`<div class="gp-drawer-row" title="${escapeHtml(PERIODE_SOURCE)}"><i class="fa-solid fa-calendar-days"></i><span>Période idéale : ${escapeHtml(periode)}</span></div>`);
    if (props.telephone) rows.push(`<div class="gp-drawer-row"><i class="fa-solid fa-phone"></i><a href="tel:${escapeHtml(props.telephone)}">${escapeHtml(formatPhone(props.telephone))}</a></div>`);
    if (props.nb_chambres) rows.push(`<div class="gp-drawer-row"><i class="fa-solid fa-bed"></i><span>${props.nb_chambres} chambre(s)</span></div>`);
    if (props.modalite) rows.push(`<div class="gp-drawer-row"><i class="fa-solid fa-utensils"></i><span>${escapeHtml(props.modalite)}</span></div>`);
    if (props.horaires) rows.push(`<div class="gp-drawer-row"><i class="fa-solid fa-clock"></i><span>${escapeHtml(props.horaires)}</span></div>`);
    this.info.innerHTML = `<h4>Informations</h4>${rows.join('')}`;
    this.info.style.display = rows.length ? 'block' : 'none';

    if (props.description) {
      this.desc.innerHTML = `<h4>À propos</h4><div class="gp-drawer-row"><span>${escapeHtml(props.description)}</span></div>`;
      this.desc.style.display = 'block';
    } else this.desc.style.display = 'none';

    const badges = [];
    if (props.piscine) badges.push('<i class="fa-solid fa-water"></i> Piscine');
    if (props.wifi) badges.push('<i class="fa-solid fa-wifi"></i> Wi-Fi');
    if (props.parking) badges.push('<i class="fa-solid fa-square-parking"></i> Parking');
    if (props.accessible_handicap) badges.push('<i class="fa-solid fa-wheelchair"></i> Accès PMR');
    if (badges.length) {
      this.badges.innerHTML = `<h4>Équipements</h4><div class="gp-drawer-badges">${badges.map(b => `<span class="gp-drawer-badge">${b}</span>`).join('')}</div>`;
      this.badges.style.display = 'block';
    } else this.badges.style.display = 'none';

    // Signalement d'une erreur (pas d'affichage de source ni de statut de vérification)
    const q = new URLSearchParams({ sujet: 'signalement', lieu: props.nom || '', commune: props.commune || '', cat: props.categorie || '', lat: props._lat, lon: props._lon });
    document.getElementById('gpDrawerTrust').innerHTML = `<a class="gp-report" href="contact.html?${q.toString()}"><i class="fa-solid fa-flag"></i> Signaler une erreur sur cette fiche</a>`;

    const actions = [];
    if (props.site_web) actions.push(`<a class="secondary" href="${escapeHtml(props.site_web)}" target="_blank" rel="noopener"><i class="fa-solid fa-globe"></i> Site web</a>`);
    actions.push(`<button class="primary" data-action="itin"><i class="fa-solid fa-diamond-turn-right"></i> Itinéraire</button>`);
    actions.push(`<button class="secondary" data-action="add-step"><i class="fa-solid fa-route"></i> Ajouter à mon circuit</button>`);
    this.actions.innerHTML = actions.join('');

    this.actions.querySelector('[data-action="itin"]').addEventListener('click', () => {
      startRoute(props._lat, props._lon, props.nom);
    });
    this.actions.querySelector('[data-action="add-step"]').addEventListener('click', () => {
      itinerary.add(props);
      document.querySelector('.gp-tab[data-tab="itineraire"]').click();
    });

    hideHoverCard();
    this.renderNearby(props);
    this.el.classList.add('open');
    this.el.setAttribute('aria-hidden', 'false');
  },
  // Lieux proches : les deux autres catégories que celle de la fiche ; rayon 2 km, élargi à 5 puis 10 km s'il n'y a rien
  renderNearby(props) {
    let box = document.getElementById('gpDrawerNearby');
    if (!box) {
      box = document.createElement('div');
      box.id = 'gpDrawerNearby'; box.className = 'gp-drawer-section';
      document.getElementById('gpDrawerTrust').before(box);
    }
    const here = L.latLng(props._lat, props._lon);
    const all = ['hebergement', 'restaurant', 'site'].filter(c => c !== props.categorie).map(cat => ({
      cat,
      items: state.allFeatures.filter(f => f.properties.categorie === cat).map(f => {
        const [lon, lat] = f.geometry.coordinates;
        return { f, d: here.distanceTo([lat, lon]) };
      }).sort((a, b) => a.d - b.d),
    }));
    const rayon = [2000, 5000, 10000].find(r => all.some(g => g.items.length && g.items[0].d <= r));
    this._nearby = [];
    // rien à moins de 10 km : on indique tout de même le lieu le plus proche de chaque catégorie, avec sa distance
    const groups = rayon ? all.map(g => ({ cat: g.cat, items: g.items.filter(x => x.d <= rayon) })).filter(g => g.items.length)
                         : all.map(g => ({ cat: g.cat, items: g.items.slice(0, 1) })).filter(g => g.items.length);
    if (!groups.length) { box.innerHTML = ''; return; }
    box.innerHTML = `<h4>${rayon ? `À proximité · moins de ${rayon / 1000} km` : 'Les lieux les plus proches'}</h4>` +
      (rayon > 2000 ? '<p class="gp-hint" style="margin:-.2rem 0 .6rem">Rien à moins de 2 km : voici les lieux les plus proches.</p>' : '') +
      groups.map(g => `
      <div class="gp-near-group"><div class="gp-near-title"><i class="fa-solid ${CAT_ICONS[g.cat]}" style="color:${CAT_COLORS[g.cat]}"></i> ${CAT_LABELS[g.cat]} <small>${g.items.length}</small></div>
        ${g.items.slice(0, 3).map(x => { this._nearby.push(x.f); return `<button type="button" class="gp-near-item" data-i="${this._nearby.length - 1}"><span>${escapeHtml(x.f.properties.nom)}</span><small>${routeDist(x.d)}</small></button>`; }).join('')}
      </div>`).join('');
    box.querySelectorAll('.gp-near-item').forEach(b => b.addEventListener('click', () => {
      const f = this._nearby[+b.dataset.i], [lon, lat] = f.geometry.coordinates;
      this.open({ ...f.properties, _lat: lat, _lon: lon });
      map.flyTo([lat, lon], Math.max(map.getZoom(), 15), { duration: 0.8 });
    }));
  },
  close() {
    this.el.classList.remove('open');
    this.el.setAttribute('aria-hidden', 'true');
  }
};

// ============================================================
// 18. ITINÉRAIRE / CIRCUIT → voir circuit-ui.js (objet `itinerary`)
// ============================================================

// ============================================================
// 19. UI DIVERS
// ============================================================
function setupTabs() {
  document.querySelectorAll('.gp-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const target = tab.dataset.tab;
      document.querySelectorAll('.gp-tab').forEach(t => t.classList.toggle('active', t === tab));
      document.querySelectorAll('.gp-panel').forEach(p => p.classList.toggle('active', p.dataset.panel === target));
    });
  });
}
function setupMobileMenu() {
  document.getElementById('gpMobileMenu').addEventListener('click', () => {
    document.querySelector('.gp-nav').classList.toggle('open');
  });
}
function setupReset() {
  document.getElementById('gpReset').addEventListener('click', () => {
    document.getElementById('gpDeptSelect').value = '';
    buildCommuneSelect();
    document.getElementById('gpCommuneSelect').value = '';
    document.querySelectorAll('.gp-cat-filter, .gp-sub-type, .gp-milieu-filter, .gp-zone-filter, .gp-presta-fam').forEach(el => el.checked = true);
    document.querySelectorAll('.gp-amenity-filter').forEach(el => el.checked = false);
    document.querySelectorAll('.gp-need').forEach(b => b.classList.remove('on'));
    clearAutour();
    render();
    showToast('Filtres réinitialisés');
  });
}
function setupOfflineIndicator() {
  const badge = document.getElementById('gpOfflineBadge');
  const upd = () => badge.style.display = navigator.onLine ? 'none' : 'inline-block';
  window.addEventListener('online', upd);
  window.addEventListener('offline', upd);
  upd();
}

// ============================================================
// 20. INIT GLOBAL
// ============================================================
// ============================================================
// LIMITES ADMINISTRATIVES (départements + communes)
// Fichiers attendus : data/limites_departements.geojson, data/limites_communes.geojson
// (GeoJSON WGS84, propriété « nom » — voir tools/preparer_limites.py)
// ============================================================
const LIMITES_URLS = {
  departements: 'data/limites_departements.geojson',
  communes:     'data/limites_communes.geojson',
};

// --- Utilitaires de robustesse pour les fichiers de limites ---
// Convertit UTM 28N (EPSG:32628) -> WGS84 [lon, lat]
function utm28nToLonLat(E, N) {
  const a = 6378137, f = 1 / 298.257223563, k0 = 0.9996, e2 = f * (2 - f), ep2 = e2 / (1 - e2);
  const x = E - 500000, M = N / k0;
  const mu = M / (a * (1 - e2 / 4 - 3 * e2 * e2 / 64 - 5 * Math.pow(e2, 3) / 256));
  const e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2));
  const phi1 = mu + (3 * e1 / 2 - 27 * Math.pow(e1, 3) / 32) * Math.sin(2 * mu)
    + (21 * e1 * e1 / 16 - 55 * Math.pow(e1, 4) / 32) * Math.sin(4 * mu)
    + (151 * Math.pow(e1, 3) / 96) * Math.sin(6 * mu) + (1097 * Math.pow(e1, 4) / 512) * Math.sin(8 * mu);
  const s = Math.sin(phi1), c = Math.cos(phi1), t = Math.tan(phi1);
  const N1 = a / Math.sqrt(1 - e2 * s * s), T1 = t * t, C1 = ep2 * c * c;
  const R1 = a * (1 - e2) / Math.pow(1 - e2 * s * s, 1.5), D = x / (N1 * k0);
  const lat = phi1 - (N1 * t / R1) * (D * D / 2 - (5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * ep2) * Math.pow(D, 4) / 24
    + (61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 252 * ep2 - 3 * C1 * C1) * Math.pow(D, 6) / 720);
  const lon = (-15 * Math.PI / 180) + (D - (1 + 2 * T1 + C1) * Math.pow(D, 3) / 6
    + (5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * ep2 + 24 * T1 * T1) * Math.pow(D, 5) / 120) / c;
  return [lon * 180 / Math.PI, lat * 180 / Math.PI];
}
function mapCoords(coords, fn) {
  return typeof coords[0] === 'number' ? fn(coords) : coords.map(c => mapCoords(c, fn));
}
function firstCoord(geom) {
  let c = geom && geom.coordinates;
  while (Array.isArray(c) && Array.isArray(c[0])) c = c[0];
  return c;
}
// Détecte et corrige : UTM, lat/lon inversés. Retourne { data, fix }.
function normaliseLimitesGeoJSON(data) {
  const feats = (data && data.features) || [];
  const sample = feats.map(f => firstCoord(f.geometry)).find(c => Array.isArray(c) && c.length >= 2);
  if (!sample) return { data, fix: null };
  const [x, y] = sample;
  let fn = null, fix = null;
  if (Math.abs(x) > 1000 || Math.abs(y) > 1000) { fn = c => utm28nToLonLat(c[0], c[1]); fix = 'reprojeté depuis UTM 28N'; }
  else if (x > 10 && x < 18 && y < -10 && y > -20) { fn = c => [c[1], c[0]]; fix = 'longitude/latitude inversées, corrigé'; }
  if (!fn) return { data, fix: null };
  return { fix, data: { ...data, features: feats.map(f => ({ ...f, geometry: f.geometry && { ...f.geometry, coordinates: mapCoords(f.geometry.coordinates, fn) } })) } };
}
// Nom d'une entité de limite, quel que soit le champ utilisé par le fichier (nom, DEPT, NAME_3…)
function limiteNom(p) {
  p = p || {};
  return p.nom || p.NOM || p.name || p.NAME || p.DEPT || p.NAME_2 || p.NAME_3 || p.ADM2_FR || p.ADM3_FR || p.admin2Name || p.admin3Name || '';
}
const limites = {
  layers: { departements: null, communes: null },
  loaded: { departements: false, communes: false },
  info: {},
  setNote(msg, isError) {
    const n = document.getElementById('gpLimNote');
    if (!n) return;
    n.textContent = msg; n.style.display = 'block'; n.style.color = isError ? '#c0392b' : '#4D5E43';
  },
  missing: {},
  showLabels: true,

  // « Thiès » / « THIES » / « thies » -> « THIES »
  key(nom) {
    return String(nom || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().trim();
  },

  init() {
    map.createPane('limites');
    const pane = map.getPane('limites');
    pane.style.zIndex = 390;            // sous les marqueurs (600), au-dessus des tuiles (200)
    pane.style.pointerEvents = 'none';  // ne bloque pas les clics sur la carte

    const dept = document.getElementById('gpLimDept');
    const com  = document.getElementById('gpLimCommunes');
    const lab  = document.getElementById('gpLimLabels');
    if (!dept || !com || !lab) return;

    dept.addEventListener('change', () => this.toggle('departements', dept.checked, dept));
    com.addEventListener('change',  () => this.toggle('communes', com.checked, com));
    lab.addEventListener('change',  () => { this.showLabels = lab.checked; this.applyLabelVisibility(); });
    map.on('zoomend', () => this.applyLabelVisibility());

    if (dept.checked) this.toggle('departements', true, dept);
    if (com.checked)  this.toggle('communes', true, com);
  },

  style(level, feature) {
    if (level === 'departements') {
      const c = DEPT_COLORS[this.key(limiteNom(feature.properties))] || '#64748B';
      return { pane: 'limites', color: c, weight: 3, opacity: 0.9, fillColor: c, fillOpacity: 0.06, interactive: false };
    }
    return { pane: 'limites', color: '#44546A', weight: 1, opacity: 0.8, dashArray: '5 4', fillOpacity: 0, interactive: false };
  },

  async load(level) {
    if (this.loaded[level]) return this.layers[level];
    let res = await fetch(`${API_BASE}/api/limites/${level}`).catch(() => null);   // 1. base PostGIS
    if (!res || !res.ok) res = await fetch(LIMITES_URLS[level] + '?t=' + Date.now());  // 2. fichier GeoJSON
    if (!res.ok) throw new Error(`fichier introuvable (HTTP ${res.status})`);
    let data;
    try { data = await res.json(); } catch (e) { throw new Error('fichier GeoJSON invalide'); }
    if (!data.features || !data.features.length) throw new Error('fichier vide (aucune entité)');
    const norm = normaliseLimitesGeoJSON(data);
    data = norm.data;
    const layer = L.geoJSON(data, {
      pane: 'limites',
      style: f => this.style(level, f),
      onEachFeature: (f, lyr) => {
        const p = f.properties || {};
        const brut = limiteNom(p);
        if (!brut) return;
        const nom = level === 'departements' ? (DEPT_NAMES[this.key(brut)] || brut) : brut;   // « THIES » → « Thiès »
        lyr.bindTooltip(escapeHtml(String(nom)), {
          permanent: true, direction: 'center', pane: 'tooltipPane',
          className: `gp-limite-label gp-limite-label--${level === 'departements' ? 'dept' : 'commune'}`,
        });
      },
    });
    // Contrôle : les limites doivent se situer au Sénégal (sinon CRS inconnu)
    const b = layer.getBounds();
    if (!b.isValid() || !b.intersects(L.latLngBounds([12.0, -18.0], [17.0, -11.0]))) {
      throw new Error('les coordonnées ne sont pas en WGS84 (EPSG:4326) — reprojetez le fichier dans QGIS');
    }
    this.layers[level] = layer;
    this.loaded[level] = true;
    this.info[level] = `${data.features.length} entité(s)` + (norm.fix ? ` — ${norm.fix}` : '');
    return layer;
  },

  async toggle(level, on, checkbox) {
    if (!on) {
      if (this.layers[level]) map.removeLayer(this.layers[level]);
      return;
    }
    try {
      const layer = await this.load(level);
      layer.addTo(map);
      this.applyLabelVisibility();
      this.setNote(`${level === 'departements' ? 'Départements' : 'Communes'} : ${this.info[level]}`, false);
    } catch (e) {
      console.warn(`Limites « ${level} » indisponibles :`, e);
      if (checkbox) { checkbox.checked = false; checkbox.disabled = true; }
      this.setNote(`${LIMITES_URLS[level]} : ${e.message}`, true);
    }
  },

  // Noms des départements : visibles dès qu'ils sont activés.
  // Noms des communes : seulement à partir du zoom 11 pour éviter le fouillis.
  applyLabelVisibility() {
    const z = map.getZoom();
    const c = map.getContainer();
    c.classList.toggle('gp-hide-limite-labels', !this.showLabels);
    c.classList.toggle('gp-hide-commune-labels', z < 11);
  },
};

async function init() {
  setupTabs();
  setupMobileMenu();
  setupSearch();
  setupCoordsDisplay();
  setupFullscreen();
  setupShare();
  setupReset();
  setupWhere();
  setupStats();
  setupHeat();
  setupRoute();
  setupLegend();
  setupOfflineIndicator();
  drawer.init();
  itinerary.init();
  printModal.init();
  limites.init();

  document.querySelectorAll('input[name="basemap"]').forEach(r => {
    r.addEventListener('change', () => setBasemap(r.value));
  });
  document.getElementById('gpShowNames').addEventListener('change', applyNamesVisibility);
  map.on('zoomend', applyNamesVisibility);
  ['gpLimDept', 'gpLimCommunes'].forEach(id => document.getElementById(id).addEventListener('change', () => updateLegend(currentFilters())));

  document.getElementById('gpZoomIn').addEventListener('click', () => map.zoomIn());
  document.getElementById('gpZoomOut').addEventListener('click', () => map.zoomOut());
  document.getElementById('gpGeolocTool').addEventListener('click', () => { showAutourPanel(); getUserLocation(() => runAutour(), true); });
  document.getElementById('gpMeasureDist').addEventListener('click', () => enableMeasure('distance'));
  document.getElementById('gpMeasureArea').addEventListener('click', () => enableMeasure('area'));
  document.getElementById('gpGeoloc').addEventListener('click', () => getUserLocation(() => runAutour(), true));
  document.getElementById('gpPickPoint').addEventListener('click', pickAutourPoint);
  document.getElementById('gpAutourToCircuit').addEventListener('click', () => circuitDepuisAutour());
  document.querySelectorAll('#gpRadiusChips .gp-chip').forEach(chip => chip.addEventListener('click', () => {
    document.querySelectorAll('#gpRadiusChips .gp-chip').forEach(c => c.classList.toggle('active', c === chip));
    state.autourKm = parseInt(chip.dataset.km, 10);
    runAutour();
  }));

  map.on('moveend zoomend', updateShareUrl);
  restoreFromUrl();

  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') drawer.close(); });

  map.on('contextmenu', (e) => {
    const { lat, lng } = e.latlng;
    L.popup().setLatLng(e.latlng).setContent(`
      <div style="text-align:center;padding:0.3rem">
        <strong>Point sélectionné</strong><br>
        <a href="#" onclick="startRoute(${lat}, ${lng}, 'Point sélectionné'); return false;"
           style="color:#A16D32;font-weight:600;font-size:0.85rem">🧭 Itinéraire vers ce point</a>
      </div>`).openOn(map);
  });

  try {
    let heb, resto, sites;
    try {                                   // 1. base PostGIS via l'API
      [heb, resto, sites] = await Promise.all(AUTOUR_CATS.map(c => fetchJsonTimeout(`${API_BASE}/api/lieux?categorie=${c}`)));
      state.dataSource = 'PostGIS';
    } catch (e) {                           // 2. secours : fichiers GeoJSON statiques
      console.info('API indisponible, chargement des fichiers statiques :', e.message);
      [heb, resto, sites] = await Promise.all([
        fetch(GEOJSON_URLS.hebergement).then(r => r.json()),
        fetch(GEOJSON_URLS.restaurant).then(r => r.json()),
        fetch(GEOJSON_URLS.site).then(r => r.json()).catch(() => ({ features: [] })),
      ]);
      const alent = await fetch(GEOJSON_URLS.alentour).then(r => r.json()).catch(() => ({ features: [] }));
      sites = { features: [...sites.features, ...alent.features] };
      state.dataSource = 'fichiers statiques';
    }
    state.allFeatures = [...heb.features, ...resto.features, ...sites.features];
    state.allFeatures.forEach(f => { f.properties.commune = normCommune(f.properties.commune); });
    buildLayerPanels();
    restoreFiltersFromUrl();
    render();
    showToast(`${state.allFeatures.length} établissements chargés ✓ (${state.dataSource})`);
    loadPrestataires();
    gpLoadTransports();
    if (!new URLSearchParams(location.search).get('excursion')) { focusLieuFromUrl(); focusFromCatalogue(); }
    else focusExcursionFromUrl();
  } catch (err) {
    console.error('Erreur chargement :', err);
    showToast('Erreur de chargement des données');
  }
}


// ============================================================
// SÉLECTION COURANTE → CHIFFRES, EXPORT, DENSITÉ
// ============================================================
function currentSelection() {
  const filters = currentFilters();
  const out = [];
  state.allFeatures.forEach(f => {
    if (!featureMatches(f, filters)) return;
    const [lon, lat] = f.geometry.coordinates;
    out.push({ cat: f.properties.categorie, p: f.properties, lat, lon });
  });
  if (filters.cats.includes('presta')) {
    Object.values(prestaData).forEach(p => { if (prestaMatches(p, filters)) out.push({ cat: 'presta', p, lat: p._lat, lon: p._lon }); });
  }
  return out;
}
const STAT_LABELS = { hebergement: 'Hébergements', restaurant: 'Restaurants', site: 'Sites touristiques', presta: 'Excursions & activités' };
let lastSelection = [];
function updateStats(sel) {
  lastSelection = sel;
  const n = { hebergement: 0, restaurant: 0, site: 0, presta: 0 };
  sel.forEach(s => { n[s.cat] = (n[s.cat] || 0) + 1; });
  document.getElementById('gpStatTotal').textContent = sel.length;
  document.querySelectorAll('.gp-stat--cat').forEach(el => {
    el.querySelector('b').textContent = n[el.dataset.cat] || 0;
    el.querySelector('.gp-lg-pin').style.background = CAT_COLORS[el.dataset.cat];
    el.classList.toggle('off', !(n[el.dataset.cat] > 0));
  });
  if (!document.getElementById('gpStatsPanel').hidden) renderStatsPanel(sel);
}
function barsHtml(rows, color) {
  const max = Math.max(1, ...rows.map(r => r.n));
  return rows.map(r => `<div class="gp-bar"><span class="gp-bar-l" title="${escapeHtml(r.label)}">${escapeHtml(r.label)}</span>
    <span class="gp-bar-t"><i style="width:${Math.max(3, r.n / max * 100)}%;background:${r.color || color}"></i></span><b>${r.n}</b></div>`).join('');
}
function renderStatsPanel(sel) {
  const body = document.getElementById('gpStatsBody');
  if (!sel.length) { body.innerHTML = '<p class="gp-hint">Aucun lieu ne correspond aux filtres actuels.</p>'; return; }
  const count = (fn) => { const m = new Map(); sel.forEach(s => { const k = fn(s); if (k) m.set(k, (m.get(k) || 0) + 1); }); return [...m.entries()].map(([k, n]) => ({ k, n })).sort((a, b) => b.n - a.n); };
  const parCat = ['hebergement', 'restaurant', 'site', 'presta'].map(c => ({ label: STAT_LABELS[c], n: sel.filter(s => s.cat === c && !isAlentour(s.p)).length, color: CAT_COLORS[c] }))
    .concat([{ label: CAT_ALENTOUR.label, n: sel.filter(s => isAlentour(s.p)).length, color: CAT_ALENTOUR.color }]).filter(r => r.n);
  const parDept = count(s => s.p.departement).map(r => ({ label: 'Département de ' + (DEPT_NAMES[r.k] || r.k), n: r.n, color: DEPT_COLORS[r.k] }));
  const communes = count(s => normCommune(s.p.commune));
  const sansCommune = sel.filter(s => !normCommune(s.p.commune)).length;
  body.innerHTML = `
    <div class="gp-sub-title">Par type de lieu</div>${barsHtml(parCat)}
    <div class="gp-sub-title" style="margin-top:1rem">Par département</div>${barsHtml(parDept)}
    <div class="gp-sub-title" style="margin-top:1rem">Par commune${communes.length > 8 ? ' (8 premières)' : ''}</div>
    ${barsHtml(communes.slice(0, 8).map(r => ({ label: communeLabel(r.k), n: r.n })), '#A16D32')}
    ${sansCommune ? `<p class="gp-hint">${sansCommune} lieu(x) sans commune renseignée ne sont pas comptés dans ce graphique.</p>` : ''}`;
}
function setupStats() {
  const panel = document.getElementById('gpStatsPanel'), btn = document.getElementById('gpStatsMore');
  const set = open => { panel.hidden = !open; btn.setAttribute('aria-expanded', open); if (open) renderStatsPanel(lastSelection); };
  btn.addEventListener('click', () => set(panel.hidden));
  document.getElementById('gpStatsClose').addEventListener('click', () => set(false));
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !panel.hidden) set(false); });
  document.getElementById('gpExportCsv').addEventListener('click', exportCsv);
  document.getElementById('gpExportGeo').addEventListener('click', exportGeojson);
}
function downloadBlob(name, mime, text) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: mime }));
  a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
const exportName = ext => `selection_thies_${new Date().toISOString().slice(0, 10)}.${ext}`;
function exportRow(s) {
  const p = s.p;
  return { categorie: s.cat === 'presta' ? 'excursion' : s.cat, nom: p.nom || '', type: p.type || '', commune: normCommune(p.commune), departement: p.departement || '',
    adresse: p.adresse || p.localisation_texte || '', telephone: p.telephone || p.contact || '', site_web: p.site_web || '', latitude: s.lat, longitude: s.lon };
}
function exportCsv() {
  if (!lastSelection.length) { showToast('Rien à exporter : aucun lieu affiché'); return; }
  const rows = lastSelection.map(exportRow), cols = Object.keys(rows[0]);
  const esc = (v, c) => (c === 'latitude' || c === 'longitude') ? String(v) : `"${String(v).replace(/"/g, '""')}"`;   // coordonnées en nombres
  const csv = [cols.join(';'), ...rows.map(r => cols.map(c => esc(r[c], c)).join(';'))].join('\r\n');
  downloadBlob(exportName('csv'), 'text/csv;charset=utf-8', '\ufeff' + csv);        // BOM : accents corrects dans Excel
  showToast(`${rows.length} lieu(x) exporté(s) en CSV ✓`);
}
function exportGeojson() {
  if (!lastSelection.length) { showToast('Rien à exporter : aucun lieu affiché'); return; }
  const fc = { type: 'FeatureCollection', features: lastSelection.map(s => {
    const r = exportRow(s), { latitude, longitude, ...props } = r;
    return { type: 'Feature', properties: props, geometry: { type: 'Point', coordinates: [longitude, latitude] } };
  }) };
  downloadBlob(exportName('geojson'), 'application/geo+json', JSON.stringify(fc, null, 1));
  showToast(`${fc.features.length} lieu(x) exporté(s) en GeoJSON ✓`);
}

// Carte de densité : remplace les repères par une surface de concentration
let heatLayer = null;
function applyHeat(sel) {
  const on = !!state.heat && typeof L.heatLayer === 'function';
  if (on) { if (map.hasLayer(gpCluster)) map.removeLayer(gpCluster); } else if (!map.hasLayer(gpCluster)) map.addLayer(gpCluster);
  if (heatLayer) { map.removeLayer(heatLayer); heatLayer = null; }
  if (on) {
    heatLayer = L.heatLayer(sel.map(s => [s.lat, s.lon, 1]), { radius: 28, blur: 22, maxZoom: 14,
      gradient: { 0.2: '#E8D5B0', 0.45: '#C9964F', 0.7: '#A16D32', 0.9: '#6B3F1C', 1: '#172431' } }).addTo(map);
  }
  const b = document.getElementById('gpHeatBtn');
  b.classList.toggle('active', on); b.setAttribute('aria-pressed', on);
}
function setupHeat() {
  document.getElementById('gpHeatBtn').addEventListener('click', () => {
    if (typeof L.heatLayer !== 'function') { showToast('Module densité indisponible (connexion internet requise)'); return; }
    state.heat = !state.heat;
    render();
    showToast(state.heat ? 'Carte de densité — recliquez pour revenir aux repères' : 'Retour aux repères');
  });
}

// ============================================================
// PRESTATAIRES (excursions, activités, agences) — couche + analyse de proximité
// Points issus de data/prestataires.json (latitude/longitude renseignées dans QGIS).
// Ouverture depuis la page Excursions : carte.html?presta=ID
// ============================================================
const PRESTA_STYLE = {
  aventure: { c: '#7A4A2A', l: 'Aventure & nature' }, nautique: { c: '#4B6A8F', l: 'Nautique & pêche' },
  loisirs:  { c: '#54476E', l: 'Loisirs' },            agence:   { c: '#64748B', l: 'Agences & guides' },
};
const prestaLayer = catLayer();                 // les excursions sont regroupées avec les autres lieux
const analysisLayer = L.layerGroup().addTo(map);
const prestaMarkers = {}, prestaData = {};
let analysisCtl = null;

(function injectPrestaCss() {
  const st = document.createElement('style');
  st.textContent = `
    .pr-pin{width:34px;height:34px;border-radius:50%;border:3px solid #fff;display:flex;align-items:center;justify-content:center;
      color:#fff;font-size:14px;box-shadow:0 3px 12px rgba(0,0,0,.4)}
    .pr-an{background:#fff;border-radius:16px;box-shadow:0 8px 28px rgba(15,25,35,.25);padding:14px 16px;width:290px;max-width:80vw;
      font-family:Montserrat,sans-serif;font-size:.8rem;color:#172431}
    .pr-an h4{margin:0 0 2px;font-family:'Playfair Display',serif;font-size:1.05rem}
    .pr-an small{color:#64748B}
    .pr-an input[type=range]{width:100%;accent-color:#A16D32;margin:6px 0 2px}
    .pr-row{display:flex;justify-content:space-between;align-items:center;padding:5px 0;border-top:1px solid #eee}
    .pr-row b{font-size:1.15rem;color:#A16D32}
    .pr-near{font-size:.74rem;color:#35485b;padding:2px 0 0 0}
    .pr-btn{background:#A16D32;color:#fff;border:0;border-radius:10px;padding:.5rem .8rem;font:600 .78rem Montserrat,sans-serif;cursor:pointer;width:100%;margin-top:.5rem}
    .pr-x{float:right;border:0;background:none;font-size:1.1rem;cursor:pointer;color:#64748B}`;
  document.head.appendChild(st);
})();

function prestaIcon(p) {
  const st = PRESTA_STYLE[p.famille] || { c: '#54476E' };
  return L.divIcon({ className: '', iconSize: [34, 34], iconAnchor: [17, 17], popupAnchor: [0, -18],
    html: `<div class="pr-pin" style="background:${st.c}"><i class="fa-solid ${p.icone || 'fa-route'}"></i></div>` });
}
function buildPrestaPopup(p) {
  const tel = (String(p.contact || '').match(/\+221[\d\s]{9,}/) || [null])[0];
  const telClean = tel ? tel.trim().replace(/\s/g, '') : null;
  const st = PRESTA_STYLE[p.famille] || { c: '#A16D32', l: '' };
  return `
    <div style="min-width:215px;font-family:Montserrat,sans-serif">
      <div style="font-size:.66rem;font-weight:700;color:${st.c};text-transform:uppercase;letter-spacing:.06em">${escapeHtml(st.l)} · ${escapeHtml(p.type)}</div>
      <strong style="font-size:1.02rem">${escapeHtml(p.nom)}</strong>
      <div style="font-size:.8rem;color:#35485b;margin:.3rem 0">${escapeHtml(p.description)}</div>
      ${p.tarif_annonce ? `<div style="font-size:.78rem;background:#F2EBDE;border-radius:8px;padding:.35rem .5rem">🏷️ ${escapeHtml(p.tarif_annonce)}</div>` : ''}
      <div style="display:flex;gap:.4rem;margin-top:.5rem">
        ${telClean ? `<a href="tel:${telClean}" style="flex:1;text-align:center;background:#A16D32;color:#fff;padding:.4rem;border-radius:8px;text-decoration:none;font-size:.78rem;font-weight:600">Appeler</a>` : ''}
        <a href="#" onclick="startRoute(${p._lat}, ${p._lon}, '${String(p.nom).replace(/'/g, "\\'").replace(/"/g, '&quot;')}'); return false;"
           style="flex:1;text-align:center;background:#f1ece1;color:#172431;padding:.4rem;border-radius:8px;text-decoration:none;font-size:.78rem;font-weight:600">Itinéraire</a>
      </div>
      <button class="pr-btn" onclick="exploreAround('${p.id}', 1000)">📍 Que trouver autour ? (analyse 1 km)</button>
    </div>`;
}
function fmtDist(m) { return m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`; }

// Analyse de proximité : zone tampon + comptage + plus proche voisin par catégorie (distance sphérique Leaflet)
function exploreAround(id, radiusM, refit = true) {
  const p = prestaData[id]; if (!p) return;
  const center = L.latLng(p._lat, p._lon);
  analysisLayer.clearLayers();
  const circle = L.circle(center, { radius: radiusM, color: '#A16D32', weight: 2, dashArray: '6 4', fillColor: '#A16D32', fillOpacity: .09 });
  analysisLayer.addLayer(circle);
  const rows = ['hebergement', 'restaurant', 'site'].map(cat => {
    const all = state.allFeatures.filter(f => f.properties.categorie === cat).map(f => {
      const [lon, lat] = f.geometry.coordinates;
      return { nom: f.properties.nom, ll: L.latLng(lat, lon), d: center.distanceTo(L.latLng(lat, lon)) };
    }).sort((x, y) => x.d - y.d);
    const inside = all.filter(x => x.d <= radiusM), near = all[0];
    if (near) {
      analysisLayer.addLayer(L.polyline([center, near.ll], { color: '#2F4A5E', weight: 2, dashArray: '2 6', opacity: .85 })
        .bindTooltip(`${escapeHtml(near.nom)} · ${fmtDist(near.d)}`, { sticky: true }));
    }
    return { cat, n: inside.length, near };
  });
  if (refit) map.fitBounds(circle.getBounds(), { padding: [40, 40] });
  if (!analysisCtl) {
    analysisCtl = L.control({ position: 'topright' });
    analysisCtl.onAdd = () => { const d = L.DomUtil.create('div', 'pr-an'); L.DomEvent.disableClickPropagation(d); L.DomEvent.disableScrollPropagation(d); return d; };
    analysisCtl.addTo(map);
  }
  const el = analysisCtl.getContainer();
  el.style.display = 'block';
  el.innerHTML = `
    <button class="pr-x" onclick="closeAnalysis()" aria-label="Fermer">✕</button>
    <h4>${escapeHtml(p.nom)}</h4><small>Analyse de proximité · zone tampon de ${fmtDist(radiusM)}</small>
    <input type="range" min="500" max="5000" step="250" value="${radiusM}" oninput="exploreAround('${id}', +this.value, false)" onchange="exploreAround('${id}', +this.value, true)">
    ${rows.map(r => `<div class="pr-row"><span><i class="fa-solid ${CAT_ICONS[r.cat]}" style="color:#A16D32;width:18px"></i> ${CAT_LABELS[r.cat]}</span><b>${r.n}</b></div>
      <div class="pr-near">${r.near ? `Le plus proche : ${escapeHtml(r.near.nom)} (${fmtDist(r.near.d)})` : 'Aucune donnée'}</div>`).join('')}
    <small style="display:block;margin-top:.5rem">Distances à vol d'oiseau (WGS84).</small>`;
}
function closeAnalysis() { analysisLayer.clearLayers(); if (analysisCtl) analysisCtl.getContainer().style.display = 'none'; }

// Les prestataires suivent les mêmes filtres que le reste (département, commune, famille) via render()
function renderPresta(filters) {
  prestaLayer.clearLayers();
  let matched = 0, shown = 0;
  Object.keys(prestaData).forEach(id => {
    if (!prestaMatches(prestaData[id], filters)) return;
    matched++;
    if (filters.cats.includes('presta')) { prestaLayer.addLayer(prestaMarkers[id]); shown++; }
  });
  if (!filters.cats.includes('presta')) closeAnalysis();
  return { matched, shown };
}

async function loadPrestataires() {
  try {
    const list = await fetch('data/prestataires.json').then(r => r.json());
    list.forEach(p => {
      const lat = parseFloat(p.latitude), lon = parseFloat(p.longitude);
      if (isNaN(lat) || isNaN(lon)) return;            // pas encore géolocalisé : on n'invente rien
      p._lat = lat; p._lon = lon; prestaData[p.id] = p;
      prestaMarkers[p.id] = L.marker([lat, lon], { icon: prestaIcon(p), zIndexOffset: 500 })
        .bindPopup(buildPrestaPopup(p), { maxWidth: 290 })
        .bindTooltip(p.nom, { direction: 'top', offset: [0, -16] });
    });
    render();
    const id = new URLSearchParams(window.location.search).get('presta');
    if (id) {
      const m = prestaMarkers[id];
      if (m && prestaLayer.hasLayer(m)) { map.flyTo(m.getLatLng(), 16, { duration: 1.2 }); highlightTarget(m.getLatLng().lat, m.getLatLng().lng, (prestaData[id] || {}).nom); setTimeout(() => m.openPopup(), 1300); }
      else showToast("Position de ce prestataire pas encore disponible sur la carte");
    }
  } catch (e) { console.warn('Prestataires non chargés :', e); }
}

// ============================================================
// ITINÉRAIRE TRACÉ DANS LA CARTE (routage OpenStreetMap / OSRM)
// ============================================================
const ROUTE_MODES = {
  driving: { label: 'Voiture', base: 'https://routing.openstreetmap.de/routed-car/route/v1/driving' },
  bike:    { label: 'Vélo',    base: 'https://routing.openstreetmap.de/routed-bike/route/v1/driving' },
  foot:    { label: 'À pied',  base: 'https://routing.openstreetmap.de/routed-foot/route/v1/driving' },
};
const ROUTE_FALLBACK = 'https://router.project-osrm.org/route/v1/driving';     // voiture uniquement
const routeLayer = L.layerGroup().addTo(map);
const routeState = { dest: null, origin: null, originGps: false, originLabel: '', mode: 'driving', req: 0, cache: {}, pickHandler: null };

const routeDist = m => m < 1000 ? `${Math.max(10, Math.round(m / 10) * 10)} m` : `${(m / 1000).toFixed(m < 10000 ? 1 : 0).replace('.', ',')} km`;
function routeDuree(s) {
  const min = Math.max(1, Math.round(s / 60));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60), r = min % 60;
  return r ? `${h} h ${String(r).padStart(2, '0')}` : `${h} h`;
}
function stepText(st) {
  const m = st.maneuver || {}, rue = st.name ? ` sur ${st.name}` : '';
  const dir = { left: 'à gauche', 'slight left': 'légèrement à gauche', 'sharp left': 'franchement à gauche', right: 'à droite',
    'slight right': 'légèrement à droite', 'sharp right': 'franchement à droite', straight: 'tout droit' }[m.modifier] || '';
  switch (m.type) {
    case 'depart': return `Départ${rue}`;
    case 'arrive': return 'Arrivée à destination';
    case 'turn': return m.modifier === 'uturn' ? `Faites demi-tour${rue}` : `Tournez ${dir}${rue}`;
    case 'continue': return `Continuez ${dir || 'tout droit'}${rue}`;
    case 'merge': return `Insérez-vous ${dir}${rue}`;
    case 'on ramp': return `Prenez la bretelle ${dir}${rue}`;
    case 'off ramp': return `Prenez la sortie ${dir}${rue}`;
    case 'fork': return `À la fourche, prenez ${dir}${rue}`;
    case 'end of road': return `Au bout de la route, tournez ${dir}${rue}`;
    case 'roundabout': case 'rotary': return `Au rond-point, prenez la ${m.exit === 1 ? '1re' : (m.exit || '') + 'e'} sortie${rue}`;
    case 'roundabout turn': return `Au rond-point, tournez ${dir}${rue}`;
    case 'exit roundabout': case 'exit rotary': return `Sortez du rond-point${rue}`;
    default: return `Continuez${rue}`;
  }
}
function setRouteSum(kind, html) {
  const el = document.getElementById('gpRouteSum');
  el.className = 'gp-route-sum gp-route-sum--' + kind;
  el.innerHTML = html;
}
function startRoute(lat, lon, nom) {
  routeState.dest = { lat: +lat, lon: +lon, nom: nom || 'Destination' };
  document.getElementById('gpRoute').hidden = false;
  document.getElementById('gpRouteDest').textContent = routeState.dest.nom;
  document.querySelector('.gp-map-wrap').classList.add('has-route');
  if (typeof drawer !== 'undefined' && drawer.close) drawer.close();      // libère la carte
  map.closePopup();
  gpRefreshRouteTransport();
  if (routeState.origin && !routeState.originGps) { fetchRoute(); return; }   // départ choisi à la main : conservé
  locateForRoute();                                                           // départ GPS : on le mesure à nouveau (l'utilisateur a pu bouger)
}
function locateForRoute(force = false) {
  setRouteSum('loading', '<i class="fa-solid fa-spinner fa-spin"></i> Recherche de votre position…');
  getUserLocation(loc => setRouteOrigin(loc, labelMaPosition(), true), force, raison => pickRouteOrigin(raison));
}
function cancelRoutePick() {
  if (routeState.pickHandler) { map.off('click', routeState.pickHandler); routeState.pickHandler = null; }
  map.getContainer().style.cursor = '';
}
function pickRouteOrigin(reason) {
  cancelRoutePick();
  setRouteSum('info', `<i class="fa-solid fa-hand-pointer"></i> ${reason ? reason + '. ' : ''}Cliquez sur la carte pour choisir votre point de départ.`);
  map.getContainer().style.cursor = 'crosshair';
  routeState.pickHandler = e => { cancelRoutePick(); setRouteOrigin(e.latlng, 'Point choisi sur la carte'); };
  map.once('click', routeState.pickHandler);
}
function setRouteOrigin(latlng, label, gps = false) {
  routeState.origin = L.latLng(latlng.lat, latlng.lng);
  routeState.originLabel = label;
  routeState.originGps = gps;                              // true : départ issu de la position de l'utilisateur (suit sa correction)
  fetchRoute();
}
async function osrmRoute(base, o, d) {
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 12000);
  try {
    const r = await fetch(`${base}/${o.lng},${o.lat};${d.lon},${d.lat}?overview=full&geometries=geojson&steps=true`, { signal: ctl.signal });
    const j = await r.json();
    if (j.code === 'NoRoute') { const e = new Error('NoRoute'); e.noRoute = true; throw e; }
    if (!r.ok || j.code !== 'Ok' || !j.routes || !j.routes.length) throw new Error(j.code || r.status);
    return j.routes[0];
  } finally { clearTimeout(timer); }
}
async function fetchRoute() {
  const { origin: o, dest: d, mode } = routeState;
  if (!o || !d) return;
  const id = ++routeState.req;
  document.getElementById('gpRouteFrom').textContent = `Départ : ${routeState.originLabel}`;
  document.querySelectorAll('#gpRouteModes button').forEach(b => b.classList.toggle('on', b.dataset.mode === mode));
  setRouteSum('loading', '<i class="fa-solid fa-spinner fa-spin"></i> Calcul de l\'itinéraire…');
  const key = `${mode}|${o.lat.toFixed(5)},${o.lng.toFixed(5)}|${d.lat},${d.lon}`;
  let route = routeState.cache[key], noRoute = false;
  if (!route) {
    try { route = await osrmRoute(ROUTE_MODES[mode].base, o, d); }
    catch (e) {
      noRoute = !!e.noRoute;
      if (!noRoute && mode === 'driving') { try { route = await osrmRoute(ROUTE_FALLBACK, o, d); } catch (e2) { noRoute = !!e2.noRoute; } }
    }
    if (route) routeState.cache[key] = route;
  }
  if (id !== routeState.req) return;                      // une demande plus récente a pris le relais
  if (!route) {
    routeLayer.clearLayers();
    document.getElementById('gpRouteStepsBox').hidden = true;
    setRouteSum('error', noRoute
      ? `<i class="fa-solid fa-triangle-exclamation"></i> Aucun itinéraire trouvé en ${ROUTE_MODES[mode].label.toLowerCase()} entre ces deux points. Essayez un autre mode ou un autre départ.`
      : `<i class="fa-solid fa-triangle-exclamation"></i> Le service d'itinéraire ne répond pas (connexion ou serveur). Réessayez dans un instant.`);
    return;
  }
  drawRoute(route);
  setRouteSum('ok', `<b>${routeDist(route.distance)}</b><span>${routeDuree(route.duration)}</span>
    <small>${ROUTE_MODES[mode].label} · estimation sur le réseau routier OpenStreetMap</small>`);
  const steps = (route.legs && route.legs[0] && route.legs[0].steps) || [];
  const box = document.getElementById('gpRouteStepsBox');
  document.getElementById('gpRouteSteps').innerHTML = steps.map(st =>
    `<li><span>${escapeHtml(stepText(st))}</span>${st.distance >= 10 && st.maneuver.type !== 'arrive' ? `<small>${routeDist(st.distance)}</small>` : ''}</li>`).join('');
  box.hidden = !steps.length;
}
function drawRoute(r) {
  routeLayer.clearLayers();
  const ll = r.geometry.coordinates.map(c => [c[1], c[0]]), foot = routeState.mode === 'foot';
  L.polyline(ll, { color: '#fff', weight: 10, opacity: .95, lineCap: 'round', lineJoin: 'round', interactive: false }).addTo(routeLayer);
  const line = L.polyline(ll, { color: '#D62828', weight: 5, opacity: .95, lineCap: 'round', lineJoin: 'round', dashArray: foot ? '1 9' : null, interactive: false }).addTo(routeLayer);
  L.circleMarker(routeState.origin, { radius: 8, color: '#D62828', weight: 3, fillColor: '#fff', fillOpacity: 1 }).bindTooltip(escapeHtml(routeState.originLabel)).addTo(routeLayer);
  L.marker([routeState.dest.lat, routeState.dest.lon], { interactive: false,
    icon: L.divIcon({ className: 'gp-route-flag', html: '<i class="fa-solid fa-flag-checkered"></i>', iconSize: [30, 30], iconAnchor: [6, 28] }) }).addTo(routeLayer);
  map.fitBounds(line.getBounds(), { paddingTopLeft: [60, 130], paddingBottomRight: [60, 270], maxZoom: 16 });
}
function closeRoute() {
  routeState.req++; routeState.dest = null; cancelRoutePick();
  routeLayer.clearLayers();
  document.getElementById('gpRoute').hidden = true;
  document.getElementById('gpRouteTransBox').open = false;
  document.querySelector('.gp-map-wrap').classList.remove('has-route');
}
function setupRoute() {
  document.getElementById('gpRouteClose').addEventListener('click', closeRoute);
  document.getElementById('gpRouteMyPos').addEventListener('click', () => { cancelRoutePick(); routeState.origin = null; locateForRoute(true); });
  document.getElementById('gpRoutePick').addEventListener('click', () => pickRouteOrigin(''));
  document.getElementById('gpRouteModes').addEventListener('click', e => {
    const b = e.target.closest('button[data-mode]'); if (!b || !routeState.dest) return;
    routeState.mode = b.dataset.mode; if (routeState.origin) fetchRoute();
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !document.getElementById('gpRoute').hidden) closeRoute(); });
}

// ============================================================
// TRANSPORT : « comment s'y rendre » (panneau d'itinéraire) et « se déplacer » (circuit)
// Les services (data/transports.json) et les applications (data/applis_transport.json) sont rattachés à des ZONES, pas à des points.
// ============================================================
const GP_TR_TAGS = [
  { k: 'vtc',     re: /vtc|taxi/i },
  { k: 'navette', re: /navette/i },
  { k: 'prive',   re: /transfert|chauffeur/i },
  { k: 'minibus', re: /minibus/i },
];
// Copie de secours des données (data/transports.json et data/applis_transport.json) : utilisée seulement si ces fichiers sont introuvables.
const GP_TRANSPORT_DEFAULTS = {"services": [{"id": 1, "nom": "Wemoov Sénégal", "type_service": "VTC & Navette Aéroport", "zones": ["Thiès", "Mbour", "Saly", "AIBD"], "telephone": "+221338018282", "site_web": "https://wemoovsenegal.com/"}, {"id": 2, "nom": "Sénégal Transport Solutions", "type_service": "VTC & Transfert Privé", "zones": ["AIBD", "Mbour", "Saly", "Thiès"], "telephone": "+221775372893", "site_web": "https://senegaltransportsolutions.com/"}, {"id": 3, "nom": "Sénégal Shuttle", "type_service": "Navette Aéroport & Interurbaine", "zones": ["Thiès", "Mbour", "Saly", "AIBD", "Tivaouane"], "telephone": "+221777731713", "site_web": "https://www.senegal-shuttle.com/"}, {"id": 4, "nom": "Yobalé – Taxis Privés", "type_service": "VTC Écoresponsable (Hybride)", "zones": ["Thiès", "Mbour", "Saly", "Tivaouane", "AIBD"], "telephone": "+221786330808", "site_web": "https://yobale.sn/"}, {"id": 5, "nom": "Allo Taxi Dakar", "type_service": "Centrale de réservation VTC 24/7", "zones": ["Thiès", "Mbour", "Saly", "Tivaouane", "AIBD"], "telephone": "+221781653737", "site_web": "http://www.allotaxisn.com/"}, {"id": 6, "nom": "Chauffeur Adama", "type_service": "Chauffeur Privé à la journée", "zones": ["Mbour", "Saly", "Popenguine", "Somone", "Thiès"], "telephone": "+221773649965", "site_web": ""}, {"id": 7, "nom": "Le Minibus Bleu", "type_service": "Location de Minibus avec Chauffeur", "zones": ["Saly", "Mbour", "Thiès", "AIBD"], "telephone": "+221775449311", "site_web": "https://leminibusbleu.com/"}], "apps": [{"id": "yango", "nom": "Yango", "zones": ["Thiès", "Mbour"], "site_web": "https://yango.com"}, {"id": "yassir", "nom": "Yassir", "zones": ["Thiès"], "site_web": "https://yassir.com"}]};
const gpTransport = { all: [], apps: [], keys: [], labels: {} };
const gpZoneKey = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().trim();

// Zone(s) d'un lieu : mot de sa commune qui correspond à une zone (« SALY PORTUDAL » → SALY), sinon son département
function gpPlaceZoneKeys(p) {
  const words = normCommune(p.commune).split(/[\s-]+/);
  const found = gpTransport.keys.filter(z => words.includes(z));
  if (found.length) return found;
  const dept = gpZoneKey(DEPT_NAMES[p.departement] || p.departement);
  return gpTransport.keys.includes(dept) ? [dept] : [];
}
// Lecture tolérante : accepte un tableau ou {services:[…]}, des zones en tableau ou en texte « Thiès, Mbour », et quelques noms de champs alternatifs
function gpNormZones(v) {
  const arr = Array.isArray(v) ? v : [v];
  return arr.flatMap(z => String(z == null ? '' : z).split(/[,;/]/)).map(s => s.trim()).filter(Boolean);
}
function gpNormService(r) {
  if (!r || typeof r !== 'object') return null;
  const nom = r.nom ?? r.name;
  if (!nom) return null;
  const zones = gpNormZones(r.zones ?? r.zones_desservies ?? r.zone ?? r.zones_desservies_texte);
  if (!zones.length) return null;                       // un service sans zone ne peut être rattaché à aucun lieu
  return { nom: String(nom).trim(), type_service: String(r.type_service ?? r.type ?? r.service ?? '').trim(), zones,
    telephone: String(r.telephone ?? r.tel ?? r.phone ?? '').trim(), site_web: String(r.site_web ?? r.site ?? r.url ?? '').trim() };
}
function gpNormList(data, withTel) {
  const arr = Array.isArray(data) ? data : (data && (data.services || data.transports || data.applications || data.apps || data.items));
  return Array.isArray(arr) ? arr.map(gpNormService).filter(Boolean) : [];
}
async function gpLoadTransports() {
  const get = u => fetch(u).then(r => { if (!r.ok) throw new Error(r.status); return r.json(); });
  // Source : l'API Django (modifiable dans l'interface d'administration), sinon le fichier statique, sinon la copie intégrée
  const lire = async (urls, defauts, nomFichier) => {
    for (const url of [].concat(urls)) {
      try { const l = gpNormList(await get(url)); if (l.length) return l; }
      catch (e) { /* source suivante */ }
    }
    console.warn(`${nomFichier} introuvable ou vide : données intégrées utilisées.`);
    return gpNormList(JSON.parse(JSON.stringify(defauts)));
  };
  const list = await lire([`${API_BASE}/api/transports`, 'data/transports.json'], GP_TRANSPORT_DEFAULTS.services, 'data/transports.json');
  const apps = (await lire([`${API_BASE}/api/applis-transport`, 'data/applis_transport.json'], GP_TRANSPORT_DEFAULTS.apps, 'data/applis_transport.json'));
  list.forEach(t => {
    t.keys = t.zones.map(gpZoneKey);
    t.zones.forEach(z => { gpTransport.labels[gpZoneKey(z)] = gpTransport.labels[gpZoneKey(z)] || z; });
    t.tags = GP_TR_TAGS.filter(g => g.re.test(t.type_service)).map(g => g.k);
  });
  apps.forEach(a => { a.keys = a.zones.map(gpZoneKey); a.zones.forEach(z => { gpTransport.labels[gpZoneKey(z)] = gpTransport.labels[gpZoneKey(z)] || z; }); });
  gpTransport.all = list;
  gpTransport.apps = apps;
  gpTransport.keys = [...new Set([...list.flatMap(t => t.keys), ...apps.flatMap(a => a.keys)])];
  if (routeState.dest) gpRefreshRouteTransport();
  if (typeof itinerary !== 'undefined' && itinerary.render) itinerary.render();
}

// Bloc commun : applications présentes dans la zone + services locaux à appeler (les « conseillés » d'abord)
function gpTransportBlockHtml(keys, prefer, intro, appKeys = keys) {
  const nom = k => gpTransport.labels[k] || k;
  // Une application n'apparaît que si TOUTES les zones concernées font partie de ses zones confirmées
  const apps = gpTransport.apps.filter(a => appKeys.length && appKeys.every(k => a.keys.includes(k))).map(a =>
    `<a class="gp-tr-app" href="${escapeHtml(a.site_web)}" target="_blank" rel="noopener"><b>${escapeHtml(a.nom)}</b>
      <small>Disponible à ${appKeys.map(nom).map(escapeHtml).join(', ')}</small></a>`).join('');
  let list = gpTransport.all.filter(t => !keys.length || keys.every(k => t.keys.includes(k)));
  let note = '';
  if (keys.length && !list.length) { list = gpTransport.all.filter(t => keys.some(k => t.keys.includes(k))); note = 'Aucun service ne couvre toutes les zones : contactez-en un pour convenir du trajet.'; }
  list = list.slice().sort((a, b) => (b.tags.some(t => prefer.includes(t)) ? 1 : 0) - (a.tags.some(t => prefer.includes(t)) ? 1 : 0));
  const row = t => `<div class="gp-tr-mini"><div><b>${escapeHtml(t.nom)}${t.tags.some(g => prefer.includes(g)) ? ' <span class="gp-tr-reco">Conseillé</span>' : ''}</b><small>${escapeHtml(t.type_service)}</small></div>
      ${t.telephone ? `<a class="gp-tr-call" href="tel:${escapeHtml(t.telephone)}" title="Appeler ${escapeHtml(t.nom)} · ${escapeHtml(formatPhone(t.telephone))}"><i class="fa-solid fa-phone"></i></a>` : ''}</div>`;
  return `<p class="gp-hint" style="margin:.2rem 0 .6rem">${intro}</p>
    ${keys.length ? `<p class="gp-hint" style="margin:0 0 .6rem">Zone : ${keys.map(nom).map(escapeHtml).join(', ')}</p>` : ''}
    ${list.length ? `<div class="gp-tr-sub">Services locaux · appel direct</div>${note ? `<p class="gp-hint" style="margin:0 0 .4rem">${note}</p>` : ''}
      ${list.slice(0, 3).map(row).join('')}
      ${list.length > 3 ? `<div class="gp-tr-more" hidden>${list.slice(3).map(row).join('')}</div><button type="button" class="gp-tr-all">Voir les ${list.length - 3} autre(s) <i class="fa-solid fa-chevron-down"></i></button>` : ''}`
      : `<p class="gp-hint">${gpTransport.all.length ? 'Aucun service local référencé pour cette zone.' : 'Aucun service local référencé pour le moment.'}</p>`}
    ${apps ? `<div class="gp-tr-sub">Applications</div><div class="gp-tr-apps">${apps}</div>` : ''}`;
}
function gpWireTransportBlock(el) {
  const btn = el.querySelector('.gp-tr-all');
  if (btn) btn.addEventListener('click', () => { el.querySelector('.gp-tr-more').hidden = false; btn.remove(); });
}

// --- panneau d'itinéraire : « Sans voiture ? » ---
function gpFindPlaceAt(lat, lon) {
  const f = state.allFeatures.find(f => Math.abs(f.geometry.coordinates[1] - lat) < 1e-6 && Math.abs(f.geometry.coordinates[0] - lon) < 1e-6);
  if (f) return f.properties;
  return Object.values(prestaData).find(p => Math.abs(p._lat - lat) < 1e-6 && Math.abs(p._lon - lon) < 1e-6) || null;
}
function gpRefreshRouteTransport() {
  const box = document.getElementById('gpRouteTransBox'), body = document.getElementById('gpRouteTrans');
  if (!box || !routeState.dest || (!gpTransport.all.length && !gpTransport.apps.length)) { if (box) box.hidden = true; return; }
  const place = gpFindPlaceAt(routeState.dest.lat, routeState.dest.lon);
  const keys = place ? gpPlaceZoneKeys(place) : [];
  body.innerHTML = gpTransportBlockHtml(keys, [],
    keys.length ? 'Pour vous faire conduire jusqu\'à cette destination.' : 'Services de la région (la zone de cette destination n\'est pas identifiée).', keys);
  gpWireTransportBlock(body);
  box.hidden = false;
}

// --- circuit : « Se déplacer pour ce circuit » ---
function gpRenderCircuitTransport(it) {
  const box = document.getElementById('gpItinTransBox'), body = document.getElementById('gpItinTransport');
  if (!box) return;
  if (!it.steps.length || (!gpTransport.all.length && !gpTransport.apps.length)) { box.style.display = 'none'; return; }
  const zonesParEtape = it.steps.map(s => gpPlaceZoneKeys({ commune: s.commune }));
  const keys = [...new Set(zonesParEtape.flat())];
  const appKeys = zonesParEtape.every(z => z.length) ? keys : [];
  const n = it.steps.length, km = it.info ? it.info.distance_m / 1000 : 0, long = n >= 3 || km >= 15;
  const trajet = it.info ? ` (${routeDist(it.info.distance_m)})` : '';
  const intro = long
    ? `Circuit de ${n} étapes${trajet} : un chauffeur à la journée ou un minibus est plus pratique pour enchaîner les arrêts.`
    : `Circuit court${trajet} : un VTC ou un taxi suffit pour relier les étapes.`;
  const open = box.open;
  body.innerHTML = gpTransportBlockHtml(keys, long ? ['prive', 'minibus'] : [], intro, appKeys);
  gpWireTransportBlock(body);
  box.style.display = 'block'; box.open = open;
}

// ============================================================
// LÉGENDE FLOTTANTE — une seule, sur la carte, qui n'affiche que ce qui est visible
// ============================================================
function updateLegend(filters) {
  const body = document.getElementById('gpLegendBody');
  if (!body) return;
  let h = '';
  if (state.heat) h += '<div class="gp-lg-title">Densité de lieux</div><div class="gp-lg-grad"></div><div class="gp-lg-gl"><span>faible</span><span>forte</span></div>';
  const zonesUI = !!document.querySelector('.gp-zone-filter');
  const showRegion = !zonesUI || filters.zones.includes('region');
  const showAlent = zonesUI && filters.zones.includes('alentour') && filters.cats.includes('site');
  const estab = state.heat ? [] : ['hebergement', 'restaurant', 'site'].filter(c => filters.cats.includes(c) && (c !== 'site' || showRegion));
  if (estab.length || (!state.heat && showAlent)) {
    h += '<div class="gp-lg-title">Type de lieu</div>' + estab.map(c =>
      `<div class="gp-lg-item"><span class="gp-lg-pin" style="background:${CAT_COLORS[c]}"><i class="fa-solid ${CAT_ICONS[c]}"></i></span>${CAT_LABELS[c]}</div>`).join('');
    if (!state.heat && showAlent) h += `<div class="gp-lg-item"><span class="gp-lg-pin" style="background:${CAT_ALENTOUR.color}"><i class="fa-solid ${CAT_ALENTOUR.icon}"></i></span>${CAT_ALENTOUR.label}</div>`;
  }
  if (!state.heat && filters.cats.includes('presta')) {
    h += '<div class="gp-lg-title">Excursions &amp; activités</div>' + Object.entries(PRESTA_STYLE)
      .filter(([k]) => filters.prestaFam.includes(k))
      .map(([, v]) => `<div class="gp-lg-item"><span class="gp-dot gp-dot--round" style="background:${v.c}"></span>${v.l}</div>`).join('');
  }
  const limDept = document.getElementById('gpLimDept'), limCom = document.getElementById('gpLimCommunes');
  if ((limDept && limDept.checked) || (limCom && limCom.checked)) {
    h += '<div class="gp-lg-title">Limites</div>';
    if (limDept && limDept.checked) h += (filters.dept ? [filters.dept] : Object.keys(DEPT_NAMES)).map(d =>
      `<div class="gp-lg-item"><span class="gp-lg-line" style="border-color:${DEPT_COLORS[d]}"></span>${DEPT_NAMES[d]}</div>`).join('');
    if (limCom && limCom.checked)  h += '<div class="gp-lg-item"><span class="gp-limite-swatch gp-limite-swatch--commune"></span>Arrondissements</div>';
  }
  body.innerHTML = h || '<div class="gp-lg-empty">Aucune couche affichée</div>';
}
function setupLegend() {
  const box = document.getElementById('gpLegendBox');
  const btn = document.getElementById('gpLegendToggle');
  const apply = open => { box.classList.toggle('collapsed', !open); btn.setAttribute('aria-expanded', open); };
  apply(!matchMedia('(max-width: 860px)').matches);       // repliée par défaut sur téléphone
  btn.addEventListener('click', () => apply(box.classList.contains('collapsed')));
}

// ============================================================
// 21. IMPRESSION / EXPORT PDF
// ============================================================
const printModal = {
  el: null,
  init() {
    this.el = document.getElementById('gpPrintModal');
    document.getElementById('gpPrint').addEventListener('click', () => this.open());
    this.el.querySelectorAll('[data-close]').forEach(b =>
      b.addEventListener('click', () => this.close())
    );
    document.getElementById('gpPrintGo').addEventListener('click', () => this.generate());
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.el.classList.contains('open')) this.close();
    });
  },
  open() {
    this.el.classList.add('open');
    this.el.setAttribute('aria-hidden', 'false');
  },
  close() {
    this.el.classList.remove('open');
    this.el.setAttribute('aria-hidden', 'true');
  },
  async generate() {
    if (!window.html2canvas || !window.jspdf) {
      showToast('Modules PDF en cours de chargement… réessayez');
      return;
    }
    const title = document.getElementById('gpPrintTitle').value || 'Carte touristique';
    const format = document.querySelector('input[name="pdfFormat"]:checked').value;
    const includeLegend = document.getElementById('gpPrintLegend').checked;
    const includeScale  = document.getElementById('gpPrintScale').checked;
    const includeDate   = document.getElementById('gpPrintDate').checked;
    const includeStats  = document.getElementById('gpPrintStats').checked;

    this.close();

    // Overlay de progression
    const overlay = document.createElement('div');
    overlay.className = 'gp-print-overlay';
    overlay.innerHTML = `<div class="gp-spinner"></div><p>Génération du PDF en cours…</p>`;
    document.body.appendChild(overlay);

    try {
      // 1. Masquer temporairement certains éléments de la carte
      const hideSelectors = ['.gp-search-wrap', '.gp-toolbar', '.gp-bottom-bar', '.gp-drawer'];
      const hidden = [];
      hideSelectors.forEach(sel => {
        document.querySelectorAll(sel).forEach(el => {
          hidden.push({ el, display: el.style.display });
          el.style.display = 'none';
        });
      });

      // 2. Attendre un rendu propre
      await new Promise(r => setTimeout(r, 250));

      // 3. Capturer la carte
      const mapEl = document.getElementById('gpMap');
      const canvas = await html2canvas(mapEl, {
        useCORS: true,
        allowTaint: false,
        backgroundColor: '#E9ECEF',
        scale: 1.5,
      });

      // 4. Restaurer l'affichage
      hidden.forEach(({ el, display }) => { el.style.display = display; });

      // 5. Construire le PDF
      const { jsPDF } = window.jspdf;
      const isLandscape = format === 'a4l';
      const pdf = new jsPDF({
        orientation: isLandscape ? 'landscape' : 'portrait',
        unit: 'mm',
        format: 'a4',
      });

      const pw = pdf.internal.pageSize.getWidth();
      const ph = pdf.internal.pageSize.getHeight();
      const margin = 12;

      // Bandeau orange
      pdf.setFillColor(232, 115, 10);
      pdf.rect(0, 0, pw, 22, 'F');

      // Titre dans le bandeau
      pdf.setTextColor(255, 255, 255);
      pdf.setFont('helvetica', 'bold');
      pdf.setFontSize(14);
      pdf.text(title, margin, 14);

      // Date à droite du bandeau
      if (includeDate) {
        pdf.setFontSize(9);
        pdf.setFont('helvetica', 'normal');
        const d = new Date().toLocaleDateString('fr-FR', {
          day: '2-digit', month: 'long', year: 'numeric'
        });
        pdf.text(d, pw - margin, 14, { align: 'right' });
      }

      // Image de la carte
      const imgY = 28;
      const imgW = pw - margin * 2;
      const imgH = imgW * (canvas.height / canvas.width);
      const maxH = ph - imgY - margin - (includeLegend || includeStats ? 22 : 0);
      const finalH = Math.min(imgH, maxH);
      const finalW = imgH > maxH ? imgW * (maxH / imgH) : imgW;

      pdf.addImage(canvas.toDataURL('image/jpeg', 0.9), 'JPEG',
        margin, imgY, finalW, finalH);

      // Bloc bas : légende + stats
      let cursorY = imgY + finalH + 6;
      pdf.setTextColor(28, 43, 57);
      pdf.setFontSize(9);

      if (includeLegend) {
        pdf.setFont('helvetica', 'bold');
        pdf.text('Légende', margin, cursorY);
        cursorY += 5;
        pdf.setFont('helvetica', 'normal');
        // Départements
        const legend = [
          { color: [232, 115, 10], label: 'Thiès' },
          { color: [27, 79, 114], label: 'Mbour' },
          { color: [45, 106, 79], label: 'Tivaouane' },
        ];
        let lx = margin;
        legend.forEach(item => {
          pdf.setFillColor(item.color[0], item.color[1], item.color[2]);
          pdf.circle(lx + 2, cursorY - 1.5, 2, 'F');
          pdf.text(item.label, lx + 6, cursorY);
          lx += 42;
        });
        cursorY += 6;
      }

      if (includeStats) {
        pdf.setFont('helvetica', 'italic');
        pdf.setTextColor(120, 130, 145);
        pdf.text(
          `${document.getElementById('gpCount').textContent} établissement(s) affiché(s) — Sources : recensement de terrain, région de Thiès`,
          margin, cursorY
        );
      }

      if (includeScale) {
        pdf.setFontSize(8);
        pdf.setTextColor(150, 160, 175);
        pdf.text(`Échelle approximative — Zoom ${map.getZoom()}`, pw - margin, ph - 6, { align: 'right' });
      }

      // Pied de page
      pdf.setFontSize(7);
      pdf.setTextColor(180, 190, 200);
      pdf.text('Géoportail touristique — Région de Thiès',
        pw - margin, ph - 3, { align: 'right' });

      // Téléchargement
      const slug = title.toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      pdf.save(`${slug || 'carte'}.pdf`);

      showToast('PDF généré ✓');
    } catch (err) {
      console.error(err);
      showToast('Erreur lors de la génération du PDF');
    } finally {
      document.body.removeChild(overlay);
    }
  }
};

init();