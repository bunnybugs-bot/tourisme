/* ============================================================
   DÉCOUVRIR (entrées par besoin) + PRÉPARER MON SÉJOUR (assistant)
   Chargé APRÈS carte.js. Utilise : state, map, render, currentFilters, featureMatches,
   prestaData, itinerary, Circuit, escapeHtml, fmtDistFr, showToast, normaliseRestoType.
   ============================================================ */
(function () {
  'use strict';
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  const RAYON_DENSITE_M = 20000;        // rayon utilisé pour choisir le « cœur » du séjour
  const RAYON_EXCURSION_M = 30000;      // une excursion proposée doit être à moins de 30 km du cœur
  const TYPES_HEB_EXCLUS = new Set(['Agence immobilière', 'Restaurant', "Location d'appartements"]);

  const ll = f => ({ lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0] });
  const dist = (a, b) => Circuit.haversine(a, b);
  const plusProche = (centre, liste) => liste.reduce((best, x) => {
    const d = dist(centre, x.pt);
    return (!best || d < best.d) ? { x, d } : best;
  }, null);

  function ajusterVue(features) {
    const pts = features.map(f => [f.geometry.coordinates[1], f.geometry.coordinates[0]]);
    if (pts.length) map.fitBounds(L.latLngBounds(pts), { padding: [50, 50], maxZoom: 13 });
  }

  // ===================== DÉCOUVRIR =====================
  const BESOINS = {
    dormir:     { cats: ['hebergement'], presta: false },
    manger:     { cats: ['restaurant'],  presta: false },
    visiter:    { cats: ['site'],        presta: false },
    excursions: { cats: [],              presta: true  },
    tout:       { cats: ['hebergement', 'restaurant', 'site'], presta: true },
  };

  function appliquerBesoin(cle) {
    const b = BESOINS[cle];
    // les couches (dont « presta » = excursions) sont les cases .gp-cat-filter du panneau « Couches et filtres »
    $$('.gp-cat-filter').forEach(el => { el.checked = b.cats.includes(el.value) || (el.value === 'presta' && b.presta); });
    render();                                  // render() met aussi les boutons à jour (syncBesoins)
    const f = currentFilters();
    const visibles = state.allFeatures.filter(x => featureMatches(x, f));
    if (cle === 'excursions') {
      const pts = Object.values(prestaData).map(p => [p._lat, p._lon]);
      if (pts.length) map.fitBounds(L.latLngBounds(pts), { padding: [50, 50], maxZoom: 13 });
    } else ajusterVue(visibles);
  }

  // Un bouton « besoin » est allumé seulement si les catégories cochées correspondent exactement à lui
  window.syncBesoins = function () {
    const on = new Set($$('.gp-cat-filter:checked').map(el => el.value));
    const egal = cats => cats.length === on.size && cats.every(c => on.has(c));
    $$('.gp-need').forEach(btn => {
      const b = BESOINS[btn.dataset.besoin];
      btn.classList.toggle('on', egal([...b.cats, ...(b.presta ? ['presta'] : [])]));
    });
    const all = BESOINS.tout;
    $('#gpNeedAll').classList.toggle('on', egal([...all.cats, 'presta']));
  };

  function initDecouvrir() {
    $$('.gp-need').forEach(btn => btn.addEventListener('click', () => appliquerBesoin(btn.dataset.besoin)));
    $('#gpNeedAll').addEventListener('click', () => appliquerBesoin('tout'));
    // Département / commune / réinitialisation : gérés dans carte.js (setupWhere, setupReset)
  }

  // ===================== PRÉPARER MON SÉJOUR =====================
  function lireChoix() {
    return {
      dest: $('#gpSejDest').value,
      jours: +($('#gpSejDuree .gp-chip.active') || { dataset: { j: 2 } }).dataset.j,
      rythme: +($('#gpSejRythme .gp-chip.active') || { dataset: { r: 3 } }).dataset.r,
      interets: new Set($$('#gpSejInterets .gp-tag.on').map(b => b.dataset.i)),
      heb: $('#gpSejHeb').checked,
      resto: $('#gpSejResto').checked,
    };
  }

  /** Sélectionne `n` sites compacts : on part du site ayant le plus de voisins dans 20 km, puis on prend ses plus proches. */
  function selectionCompacte(cands, n) {
    if (cands.length <= n) return cands.slice();
    let seed = cands[0], best = -1;
    cands.forEach(a => {
      const k = cands.reduce((s, b) => s + (dist(a.pt, b.pt) <= RAYON_DENSITE_M ? 1 : 0), 0);
      if (k > best) { best = k; seed = a; }
    });
    return cands.slice().sort((a, b) => dist(seed.pt, a.pt) - dist(seed.pt, b.pt)).slice(0, n);
  }

  async function composer() {
    if (!state.allFeatures.length) { showToast('Les données sont en cours de chargement…'); return; }
    const c = lireChoix();
    const nbSites = c.jours * c.rythme;

    // 1. Sites correspondant à la destination et aux centres d'intérêt
    const sites = state.allFeatures
      .filter(f => f.properties.categorie === 'site' && (!c.dest || f.properties.departement === c.dest)
        && c.interets.has(f.properties.type))
      .map(f => ({ f, pt: ll(f), props: { ...f.properties, _lat: ll(f).lat, _lon: ll(f).lon } }));
    let choix = selectionCompacte(sites, nbSites);

    // 2. Excursions (une par jour au maximum), proches du cœur du séjour
    let excursions = [];
    if (c.interets.has('excursions')) {
      const base = choix.length ? centroide(choix.map(x => x.pt)) : null;
      excursions = Object.values(prestaData)
        .filter(p => p.famille !== 'agence')               // activités uniquement (les agences restent sur la carte)
        .filter(p => !c.dest || p.departement === c.dest)
        .map(p => ({ pt: { lat: p._lat, lon: p._lon }, p }))
        .filter(x => !base || dist(base, x.pt) <= RAYON_EXCURSION_M);
      if (base) excursions.sort((a, b) => dist(base, a.pt) - dist(base, b.pt));
      excursions = excursions.slice(0, c.jours).map(x => ({
        pt: x.pt,
        props: { nom: x.p.nom, categorie: 'prestataire', type: x.p.type || 'Excursion', commune: x.p.commune || '',
          departement: x.p.departement, telephone: ((x.p.contact || '').match(/\+221[\d\s]{9,}/) || [''])[0].trim(),
          _lat: x.pt.lat, _lon: x.pt.lon },
      }));
    }
    choix = choix.concat(excursions);
    const res = $('#gpSejResult');
    if (!choix.length) {
      res.innerHTML = `<div class="gp-sej-warn">Aucun lieu ne correspond à ces choix. Essayez « Toute la région » ou d'autres centres d'intérêt.</div>`;
      return;
    }

    // 3. Hébergement : le plus proche du centre des visites
    const centre = centroide(choix.map(x => x.pt));
    let hebergement = null;
    if (c.heb) {
      const bases = state.allFeatures.filter(f => f.properties.categorie === 'hebergement'
        && !TYPES_HEB_EXCLUS.has(f.properties.type) && (!c.dest || f.properties.departement === c.dest))
        .map(f => ({ f, pt: ll(f) }));
      const r = plusProche(centre, bases);
      if (r) hebergement = { f: r.x.f, pt: r.x.pt, d: r.d };
    }

    // 4. Ordre de visite (API PostGIS, sinon calcul local) à partir de l'hébergement (ou du lieu le plus central)
    let depart = null, aOrdonner = choix;
    if (hebergement) depart = { lat: hebergement.pt.lat, lon: hebergement.pt.lon, nom: `${hebergement.f.properties.nom} (hébergement)` };
    else {
      const premier = plusProche(centre, choix).x;
      aOrdonner = [premier, ...choix.filter(x => x !== premier)];
    }
    const pts = (depart ? [depart] : []).concat(aOrdonner.map(x => ({ lat: x.pt.lat, lon: x.pt.lon })));
    const boucle = !!hebergement;
    const { res: ordreRes, source } = pts.length > 2
      ? await itinerary.calculerOrdre(pts, boucle)
      : { res: { ordre: pts.map((_, i) => i) }, source: 'navigateur' };
    const idx = depart ? ordreRes.ordre.slice(1).map(i => i - 1) : ordreRes.ordre;
    const ordonnes = idx.map(i => aOrdonner[i]);

    // 5. Découpage en jours (étapes consécutives)
    const parJour = Math.ceil(ordonnes.length / c.jours);
    const etapes = ordonnes.map((x, i) => ({ ...x.props, jour: Math.min(c.jours, Math.floor(i / parJour) + 1) }));
    const joursUtiles = new Set(etapes.map(e => e.jour)).size;

    itinerary.setPlan({ depart, steps: etapes, boucle });

    // 6. Restaurant suggéré par jour (le plus proche de l'étape centrale du jour)
    const restos = c.resto ? state.allFeatures
      .filter(f => f.properties.categorie === 'restaurant' && normaliseRestoType(f.properties.type) === 'Restaurant'
        && (!c.dest || f.properties.departement === c.dest))
      .map(f => ({ f, pt: ll(f) })) : [];
    const jours = [];
    for (let j = 1; j <= joursUtiles; j++) {
      const du = etapes.filter(e => e.jour === j);
      const milieu = du[Math.floor(du.length / 2)];
      const r = restos.length ? plusProche({ lat: milieu._lat, lon: milieu._lon }, restos) : null;
      jours.push({ j, du, resto: r ? { f: r.x.f, d: r.d, autour: milieu.nom } : null });
    }
    afficherResultat({ c, jours, hebergement, source, nSites: ordonnes.length, boucle });
    itinerary.voirSurCarte();
  }

  function centroide(pts) {
    return { lat: pts.reduce((a, p) => a + p.lat, 0) / pts.length, lon: pts.reduce((a, p) => a + p.lon, 0) / pts.length };
  }

  function afficherResultat({ c, jours, hebergement, source, nSites, boucle }) {
    const demande = c.jours, obtenu = jours.length;
    const heb = hebergement
      ? `<div class="gp-sej-heb"><i class="fa-solid fa-bed"></i><span><b>${escapeHtml(hebergement.f.properties.nom)}</b>
          <small>${escapeHtml([hebergement.f.properties.type, hebergement.f.properties.commune].filter(Boolean).join(' · '))}
          — hébergement le plus proche du centre de vos visites (${fmtDistFr(hebergement.d)})</small></span></div>`
      : '';
    const blocs = jours.map(({ j, du, resto }) => `
      <div class="gp-sej-jour">
        <h4><i class="fa-regular fa-calendar"></i> Jour ${j}</h4>
        <ol>${du.map(e => `<li>${escapeHtml(e.nom)}<small>${escapeHtml([e.type, e.commune].filter(Boolean).join(' · '))}</small></li>`).join('')}</ol>
        ${resto ? `<div class="gp-sej-resto" data-lat="${resto.f.geometry.coordinates[1]}" data-lon="${resto.f.geometry.coordinates[0]}">
          <i class="fa-solid fa-utensils"></i> Déjeuner suggéré : <b>${escapeHtml(resto.f.properties.nom)}</b>
          <small>à ${fmtDistFr(resto.d)} de « ${escapeHtml(resto.autour)} »</small></div>` : ''}
      </div>`).join('');
    $('#gpSejResult').innerHTML = `
      <div class="gp-sej-sum"><b>${nSites}</b> étape(s) sur <b>${obtenu}</b> jour(s)${obtenu < demande ? ` <small>(moins de lieux disponibles que prévu pour ${demande} jours)</small>` : ''}
        <small>Ordre calculé : ${source}${boucle ? ' · retour à l\'hébergement' : ''}</small></div>
      ${heb}${blocs}
      <button class="gp-btn gp-btn-primary gp-full" id="gpSejVoir"><i class="fa-solid fa-route"></i> Voir mon circuit (carte, export)</button>
      <p class="gp-hint">Suggestion automatique fondée sur la proximité : vérifiez ouverture, disponibilité et prix avant de partir.</p>`;
    $('#gpSejVoir').addEventListener('click', () => $('.gp-tab[data-tab="itineraire"]').click());
    $$('.gp-sej-resto').forEach(el => el.addEventListener('click', () => map.flyTo([+el.dataset.lat, +el.dataset.lon], 16, { duration: 1 })));
  }

  function initSejour() {
    const unique = (sel, attr) => $$(sel + ' .gp-chip').forEach(ch => ch.addEventListener('click', () => {
      $$(sel + ' .gp-chip').forEach(x => x.classList.toggle('active', x === ch));
    }));
    unique('#gpSejDuree'); unique('#gpSejRythme');
    $$('#gpSejInterets .gp-tag').forEach(t => t.addEventListener('click', () => t.classList.toggle('on')));
    $('#gpSejGo').addEventListener('click', composer);
  }

  // ===================== OUVERTURE DIRECTE : carte.html?mode=sejour =====================
  function ouvrirModeDepuisUrl() {
    const p = new URLSearchParams(location.search);
    const mode = p.get('mode');
    const tab = { sejour: 'sejour', autour: 'autour', circuit: 'itineraire', decouvrir: 'decouvrir' }[mode];
    if (tab) $(`.gp-tab[data-tab="${tab}"]`).click();
    const dest = (p.get('dest') || '').toUpperCase();
    if (mode === 'sejour' && ['THIES', 'MBOUR', 'TIVAOUANE'].includes(dest)) $('#gpSejDest').value = dest;
    if (mode === 'decouvrir' && BESOINS[p.get('besoin')]) {
      const t = setInterval(() => { if (state.allFeatures.length) { clearInterval(t); appliquerBesoin(p.get('besoin')); } }, 200);
      setTimeout(() => clearInterval(t), 10000);
    }
    if (mode === 'decouvrir' && ['THIES', 'MBOUR', 'TIVAOUANE'].includes(dest)) {
      $('#gpDeptSelect').value = dest; $('#gpDeptSelect').dispatchEvent(new Event('change'));
    }
  }

  // Mobile : bouton Menu pour ouvrir / fermer la barre latérale
  function initMenuMobile() {
    const sb = $('#gpSidebar'), btn = $('#gpSidebarToggle');
    const maj = () => { btn.innerHTML = sb.classList.contains('open')
      ? '<i class="fa-solid fa-map"></i> Carte' : '<i class="fa-solid fa-bars-staggered"></i> Menu'; setTimeout(() => map.invalidateSize(), 250); };
    btn.addEventListener('click', () => { sb.classList.toggle('open'); maj(); });
    // sur téléphone, on arrive directement dans le panneau demandé (?mode=…)
    if (matchMedia('(max-width: 860px)').matches && new URLSearchParams(location.search).get('mode')) { sb.classList.add('open'); maj(); }
  }

  initDecouvrir();
  initSejour();
  initMenuMobile();
  ouvrirModeDepuisUrl();
})();
