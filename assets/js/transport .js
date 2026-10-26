/* ============================================================
   TRANSPORT — services de transport proposés
     1) dans le panneau d'itinéraire tracé (« Pas de voiture ? »)
     2) dans « Mon circuit » (services qui desservent TOUTES les étapes)
   Données : data/transports.json  (services recensés et leurs zones de desserte)
   S'appuie sur carte.js / circuit-ui.js : state, prestaData, routeState, startRoute, itinerary,
   openGoogleMapsItinerary, escapeHtml, formatPhone.
   Règle : un service n'est proposé que si la zone de la destination figure dans ses zones_desservies.
   Aucune zone n'est déduite ni élargie (« Mbour » ne couvre pas « Malicounda », par exemple).
   ============================================================ */
(function () {
  'use strict';

  const norm = s => String(s || '').replace(/['’]/g, '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/[^A-Z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

  // Commune de la base -> nom de zone tel qu'écrit dans transports.json. Seules des équivalences de nom :
  // Thiès Nord/Est/Ouest/Sud = ville de Thiès ; « Saly Portudal » = Saly.
  const ZONE_DE_COMMUNE = {
    'SALY PORTUDAL': 'SALY', 'SALY': 'SALY', 'MBOUR': 'MBOUR', 'SOMONE': 'SOMONE', 'POPENGUINE': 'POPENGUINE',
    'THIES': 'THIES', 'THIES NORD': 'THIES', 'THIES SUD': 'THIES', 'THIES EST': 'THIES', 'THIES OUEST': 'THIES',
    'TIVAOUANE': 'TIVAOUANE', 'TIVAOUNE': 'TIVAOUANE',
  };
  const NOM_ZONE = { SALY: 'Saly', MBOUR: 'Mbour', SOMONE: 'Somone', POPENGUINE: 'Popenguine', TIVAOUANE: 'Tivaouane', THIES: 'Thiès' };
  const nomZone = z => NOM_ZONE[z] || z;

  let services = [];
  const ready = fetch('data/transports.json').then(r => r.json()).then(d => { services = Array.isArray(d) ? d : []; })
    .catch(e => { console.warn('Transports non chargés :', e); services = []; });

  // ---------- zone d'un lieu ----------
  // Commune du lieu ; à défaut (restaurants non rattachés) un nom de zone écrit dans l'adresse.
  function zoneDe(props) {
    const c = norm(props.commune);
    if (c) return ZONE_DE_COMMUNE[c] || null;           // commune connue mais absente de la liste : aucune zone
    const adr = ' ' + norm([props.adresse, props.quartier_village].join(' ')) + ' ';
    return Object.keys(NOM_ZONE).find(n => adr.includes(' ' + n + ' ')) || null;
  }
  const dessert = (s, zone) => (s.zones_desservies || []).some(z => norm(z) === zone);

  // Retrouve la fiche d'un point (les étapes de circuit et l'itinéraire ne gardent que lat/lon/nom)
  function lieuAuPoint(lat, lon) {
    const eq = (a, b) => Math.abs(a - b) < 1e-5;
    const f = (state.allFeatures || []).find(x => eq(x.geometry.coordinates[1], lat) && eq(x.geometry.coordinates[0], lon));
    if (f) return f.properties;
    return Object.values(typeof prestaData !== 'undefined' ? prestaData : {}).find(p => eq(p._lat, lat) && eq(p._lon, lon)) || null;
  }

  // ---------- affichage ----------
  const tel = s => (typeof formatPhone === 'function' ? formatPhone(s) : s);
  function carteService(s) {
    const t = String(s.telephone || '').replace(/\s/g, '');
    return `<div class="gp-tr-svc">
      <div class="gp-tr-name">${escapeHtml(s.nom)}<small>${escapeHtml(s.type_service)}</small></div>
      <div class="gp-tr-zones"><i class="fa-solid fa-location-dot"></i> ${escapeHtml((s.zones_desservies || []).join(', '))}</div>
      <div class="gp-tr-act">
        ${t ? `<a class="gp-tr-btn" href="tel:${escapeHtml(t)}"><i class="fa-solid fa-phone"></i> ${escapeHtml(tel(t))}</a>` : ''}
        ${s.site_web ? `<a class="gp-tr-btn gp-tr-btn--alt" href="${escapeHtml(s.site_web)}" target="_blank" rel="noopener"><i class="fa-solid fa-globe"></i> Site web</a>` : ''}
      </div></div>`;
  }
  const AVERTISSEMENT = '<p class="gp-tr-note">Services recensés dans notre catalogue, à titre indicatif : confirmez disponibilité et tarifs auprès du transporteur.</p>';

  // ---------- 1) panneau d'itinéraire tracé ----------
  function installerRoute() {
    const box = document.getElementById('gpRoute');
    if (!box || document.getElementById('gpRouteTransport')) return;
    const det = document.createElement('details');
    det.id = 'gpRouteTransport'; det.className = 'gp-tr-box'; det.hidden = true;
    const ref = document.getElementById('gpRouteStepsBox');
    ref ? ref.before(det) : box.appendChild(det);
  }
  function majRoute(lat, lon, nom) {
    installerRoute();
    const det = document.getElementById('gpRouteTransport'); if (!det) return;
    ready.then(() => {
      const props = lieuAuPoint(+lat, +lon), zone = props ? zoneDe(props) : null;
      const liste = zone ? services.filter(s => dessert(s, zone)) : [];
      const titre = liste.length ? `${liste.length} service${liste.length > 1 ? 's' : ''} · ${nomZone(zone)}` : 'aucun service recensé';
      const corps = !zone
        ? '<p class="gp-tr-note">La zone de cette destination n\'est pas reconnue dans notre liste : aucun service de transport ne peut être proposé.</p>'
        : liste.length ? liste.map(carteService).join('') + AVERTISSEMENT
          : `<p class="gp-tr-note">Aucun service de notre liste ne mentionne la zone de ${escapeHtml(nomZone(zone))}.</p>`;
      det.innerHTML = `<summary><i class="fa-solid fa-van-shuttle"></i> Pas de voiture ? Services de transport <small>${escapeHtml(titre)}</small></summary>
        <div class="gp-tr-body">${corps}</div>`;
      det.hidden = false; det.open = false;
    });
  }
  const startRouteOrigine = window.startRoute;
  window.startRoute = function (lat, lon, nom) {
    startRouteOrigine.apply(this, arguments);
    majRoute(lat, lon, nom);
  };
  // La fermeture du panneau d'itinéraire le masque en entier : rien d'autre à nettoyer.

  // ---------- 2) « Mon circuit » : services qui desservent TOUTES les étapes ----------
  function installerCircuit() {
    if (document.getElementById('gpItinTransport')) return;
    const ref = document.getElementById('gpItinSummary'); if (!ref) return;
    const det = document.createElement('details');
    det.id = 'gpItinTransport'; det.className = 'gp-tr-box gp-tr-box--circuit'; det.hidden = true;
    ref.after(det);
  }
  function majCircuit() {
    installerCircuit();
    const det = document.getElementById('gpItinTransport'); if (!det) return;
    const steps = itinerary.steps || [];
    if (!steps.length) { det.hidden = true; return; }
    ready.then(() => {
      const infos = steps.map(s => { const p = lieuAuPoint(s.lat, s.lon) || { commune: s.commune, adresse: s.adresse }; return { nom: s.nom, zone: zoneDe(p) }; });
      const inconnues = infos.filter(i => !i.zone);
      const zones = [...new Set(infos.filter(i => i.zone).map(i => i.zone))];
      const communs = inconnues.length ? [] : services.filter(s => zones.every(z => dessert(s, z)));
      const ok = communs.length > 0;
      const titre = ok ? `${communs.length} service${communs.length > 1 ? 's' : ''}` : 'aucun service pour tout le circuit';
      const corps = inconnues.length
        ? `<p class="gp-tr-note">Zone non reconnue pour : ${inconnues.map(i => escapeHtml(i.nom)).join(', ')}. Aucun service ne peut être proposé pour l'ensemble du circuit.</p>`
        : ok ? `<p class="gp-tr-note" style="margin-top:0">Zones des étapes : ${zones.map(z => escapeHtml(nomZone(z))).join(', ')}. Seuls les services qui desservent chacune de ces zones sont listés.</p>${communs.map(carteService).join('')}${AVERTISSEMENT}`
          : `<p class="gp-tr-note">Aucun service recensé ne dessert à la fois ${zones.map(z => escapeHtml(nomZone(z))).join(', ')}. Vous pouvez réserver un transport séparément pour chaque zone depuis l'itinéraire d'une étape.</p>`;
      det.innerHTML = `<summary><i class="fa-solid fa-van-shuttle"></i> Transport pour ce circuit <small>${escapeHtml(titre)}</small></summary><div class="gp-tr-body">${corps}</div>`;
      det.hidden = false;
    });
  }
  const renderOrigine = itinerary.render;
  itinerary.render = function () { renderOrigine.apply(this, arguments); try { majCircuit(); } catch (e) { console.warn(e); } };
  ready.then(() => { installerRoute(); majCircuit(); });

  // Réutilisable ailleurs
  window.GPTransport = { zoneDe, ready, servicesPour: props => { const zone = zoneDe(props); return { zone, liste: zone ? services.filter(s => dessert(s, zone)) : [] }; } };

  // Styles (injectés ici : aucune modification de carte.css nécessaire)
  const css = document.createElement('style');
  css.textContent = `
  .gp-tr-box { border-top: 1px solid var(--border); }
  .gp-tr-box[hidden] { display: none; }
  .gp-tr-box summary { cursor: pointer; padding: .6rem 1rem; font: 700 .76rem 'Montserrat', sans-serif; color: var(--charcoal); list-style: none; display: flex; align-items: center; gap: .5rem; }
  .gp-tr-box summary::-webkit-details-marker { display: none; }
  .gp-tr-box summary i { color: var(--orange); }
  .gp-tr-box summary small { margin-left: auto; color: var(--text-muted); font-weight: 600; font-size: .68rem; }
  .gp-tr-box summary::after { content: '\\f078'; font-family: 'Font Awesome 6 Free'; font-weight: 900; font-size: .6rem; color: var(--text-muted); transition: transform .2s; }
  .gp-tr-box[open] summary::after { transform: rotate(180deg); }
  .gp-tr-body { padding: 0 1rem .8rem; max-height: 220px; overflow-y: auto; }
  #gpRouteTransport .gp-tr-body { max-height: 170px; }
  .gp-tr-box--circuit { border: 1px solid var(--border); border-radius: 10px; background: #fff; margin-bottom: .7rem; }
  .gp-tr-box--circuit summary { padding: .65rem .8rem; }
  .gp-tr-box--circuit .gp-tr-body { padding: 0 .8rem .8rem; max-height: 300px; }
  .gp-tr-gmaps { width: 100%; cursor: pointer; border: 0; border-radius: 8px; padding: .5rem .8rem; background: var(--charcoal); color: #fff; margin-bottom: .6rem;
    font: 700 .76rem 'Montserrat', sans-serif; display: inline-flex; align-items: center; justify-content: center; gap: .5rem; }
  .gp-tr-gmaps:hover { background: var(--orange); }
  .gp-tr-svc { border: 1px solid var(--border); border-radius: 10px; background: #F8FAFC; padding: .55rem .7rem; margin-bottom: .45rem; }
  .gp-tr-name { font-weight: 700; font-size: .82rem; }
  .gp-tr-name small { display: block; font-weight: 500; color: var(--text-muted); font-size: .7rem; margin-top: .1rem; }
  .gp-tr-zones { font-size: .7rem; color: var(--text-muted); margin: .35rem 0; }
  .gp-tr-zones i { color: var(--orange); margin-right: .3rem; }
  .gp-tr-act { display: flex; flex-wrap: wrap; gap: .4rem; }
  .gp-tr-btn { text-decoration: none; font: 700 .72rem 'Montserrat', sans-serif; padding: .35rem .7rem; border-radius: 999px; background: var(--orange); color: #fff; display: inline-flex; align-items: center; gap: .35rem; }
  .gp-tr-btn:hover { background: #7F5528; }
  .gp-tr-btn--alt { background: #fff; color: var(--charcoal); border: 1.5px solid var(--border); }
  .gp-tr-btn--alt:hover { background: #fff; border-color: var(--orange); color: var(--orange); }
  .gp-tr-note { font-size: .72rem; line-height: 1.45; color: var(--text-muted); margin: .5rem 0; }`;
  document.head.appendChild(css);
})();
