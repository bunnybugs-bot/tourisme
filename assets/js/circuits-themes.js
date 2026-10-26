/* ============================================================
   CIRCUITS THÉMATIQUES — choisir un thème, cocher les lieux, les ajouter à « Mon circuit »
   Source : sites.json (propriété « circuits » = thèmes du lieu, « pole » = regroupement du thème Religieux).
   Pour ajouter un lieu à un thème : ajouter son nom de thème dans « circuits » dans sites.json.
   Chargé APRÈS carte.js (utilise map, drawer, itinerary, showToast, escapeHtml).
   ============================================================ */
   (function () {
    'use strict';
    const THEMES = [
      { id: 'Religieux', icone: 'fa-mosque', couleur: '#6A3D9A', parPole: true,
        objectif: 'Découvrir des lieux de culte et des sites associés au patrimoine religieux. Chacun choisit les lieux qui l’intéressent.' },
      { id: 'Artisanal et culturel', icone: 'fa-palette', couleur: '#B8651B',
        objectif: 'Mettre en valeur l’artisanat, les activités culturelles et le patrimoine local.' },
      { id: 'Écotouristique', icone: 'fa-tree', couleur: '#2E8B57',
        objectif: 'Découvrir les espaces naturels et les sites présentant un intérêt écologique.' },
      { id: 'Balnéaire', icone: 'fa-umbrella-beach', couleur: '#1F78B4',
        objectif: 'Valoriser le littoral et les activités touristiques de la côte.' },
    ];
    const box = document.getElementById('gpThemes');
    if (!box) return;
    const chipsEl = document.getElementById('gpThemeChips');
    const bodyEl = document.getElementById('gpThemeBody');
    let lieux = [], theme = null, couche = null;
  
    const esc = s => (typeof escapeHtml === 'function' ? escapeHtml(s) : String(s ?? ''));
    const court = (t, n = 130) => { t = String(t || '').trim(); return t.length > n ? t.slice(0, n).replace(/\s+\S*$/, '') + '…' : t; };
    const propsFiche = f => ({ ...f.properties, categorie: 'site', _lat: f.geometry.coordinates[1], _lon: f.geometry.coordinates[0] });
  
    function effacerCouche() {
      if (couche) { map.removeLayer(couche); couche = null; }
      map.getContainer().classList.remove('gp-th-dim');
      const b = bodyEl.querySelector('[data-act="voir"]'); if (b) b.innerHTML = '<i class="fa-solid fa-map-pin"></i> Voir sur la carte';
    }
  
    function choisir(id) {
      theme = THEMES.find(t => t.id === id) || null;
      effacerCouche();
      chipsEl.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.id === id));
      render();
    }
  
    function liste() { return theme ? lieux.filter(f => (f.properties.circuits || []).includes(theme.id)) : []; }
  
    function ligne(f, i, coche) {
      const p = f.properties;
      return `<li class="gp-th-item">
        <label><input type="checkbox" data-i="${i}" ${coche ? 'checked' : ''}>
          <span><button type="button" class="gp-th-nom" data-i="${i}">${esc(p.nom)}</button>
          <small>${esc(p.commune ? p.commune.replace(/\b(\w)(\w*)/g, (m, a, b) => a + b.toLowerCase()) : p.departement || '')}</small>
          ${p.description ? `<em>${esc(court(p.description))}</em>` : ''}</span></label></li>`;
    }
  
    function render() {
      if (!theme) { bodyEl.innerHTML = ''; return; }
      const fs = liste();
      const defaut = !theme.parPole;              // Religieux : rien de coché au départ, chacun choisit
      let html = `<p class="gp-th-obj">${esc(theme.objectif)}</p>`;
      if (!fs.length) {
        html += '<p class="gp-hint">Aucun lieu n’est encore associé à ce thème.</p>';
      } else if (theme.parPole) {
        const poles = [...new Set(fs.map(f => f.properties.pole || 'Autres'))];
        poles.forEach(po => {
          html += `<div class="gp-th-pole">${esc(po)}</div><ul class="gp-th-list">`;
          fs.forEach((f, i) => { if ((f.properties.pole || 'Autres') === po) html += ligne(f, i, defaut); });
          html += '</ul>';
        });
      } else {
        html += `<ul class="gp-th-list">${fs.map((f, i) => ligne(f, i, defaut)).join('')}</ul>`;
      }
      if (fs.length) html += `<div class="gp-th-actions">
        <button type="button" class="gp-btn gp-btn-outline" data-act="tout">Tout cocher</button>
        <button type="button" class="gp-btn gp-btn-outline" data-act="rien">Tout décocher</button>
        <button type="button" class="gp-btn gp-btn-outline" data-act="voir"><i class="fa-solid fa-map-pin"></i> Voir sur la carte</button>
        <button type="button" class="gp-btn gp-btn-primary" data-act="ajouter"><i class="fa-solid fa-route"></i> Ajouter à mon circuit</button></div>`;
      bodyEl.innerHTML = html;
      if (couche) { const b = bodyEl.querySelector('[data-act="voir"]'); if (b) b.innerHTML = '<i class="fa-solid fa-eye-slash"></i> Retirer de la carte'; }
    }
  
    const coches = () => { const fs = liste(); return [...bodyEl.querySelectorAll('input:checked')].map(i => fs[+i.dataset.i]); };
  
    function voir() {
      if (couche) { effacerCouche(); return; }                     // 2e clic : on retire la mise en évidence
      const fs = liste(); if (!fs.length) return;
      const sel = new Set(coches());
      const cibles = sel.size ? fs.filter(f => sel.has(f)) : fs;   // lieux cochés, sinon tout le thème
      couche = L.layerGroup(cibles.map(f => {
        const icon = L.divIcon({ className: 'gp-th-pin', iconSize: [38, 38], iconAnchor: [19, 19],
          html: `<span style="--c:${theme.couleur}"><i class="fa-solid ${theme.icone}"></i></span>` });
        const m = L.marker([f.geometry.coordinates[1], f.geometry.coordinates[0]], { icon, zIndexOffset: 10000, title: f.properties.nom });
        m.bindTooltip(esc(f.properties.nom), { direction: 'top', offset: [0, -16] }); m.on('click', () => drawer.open(propsFiche(f)));
        return m;
      })).addTo(map);
      map.getContainer().classList.add('gp-th-dim');               // les autres repères s'estompent
      const b = bodyEl.querySelector('[data-act="voir"]'); if (b) b.innerHTML = '<i class="fa-solid fa-eye-slash"></i> Retirer de la carte';
      map.fitBounds(L.latLngBounds(cibles.map(f => [f.geometry.coordinates[1], f.geometry.coordinates[0]])), { padding: [60, 60], maxZoom: 13 });
    }
  
    async function ajouter() {
      const sel = coches();
      if (!sel.length) { showToast('Cochez au moins un lieu'); return; }
      if (!itinerary.steps.length && !itinerary.depart) { itinerary.boucle = false; itinerary.loopEl.checked = false; }   // parcours ouvert par défaut
      let n = 0;
      sel.forEach(f => { if (itinerary.add(propsFiche(f), { silent: true })) n++; });
      itinerary.changed();
      showToast(n ? `${n} lieu(x) ajouté(s) à votre circuit` : 'Ces lieux sont déjà dans votre circuit');
      if (itinerary.tous().length >= 3) await itinerary.optimiser();
    }
  
    bodyEl.addEventListener('click', e => {
      const nom = e.target.closest('.gp-th-nom');
      if (nom) { e.preventDefault(); const f = liste()[+nom.dataset.i]; if (f) { map.flyTo([f.geometry.coordinates[1], f.geometry.coordinates[0]], 14, { duration: .8 }); drawer.open(propsFiche(f)); } return; }
      const b = e.target.closest('[data-act]'); if (!b) return;
      if (b.dataset.act === 'tout' || b.dataset.act === 'rien') bodyEl.querySelectorAll('input').forEach(i => { i.checked = b.dataset.act === 'tout'; });
      else if (b.dataset.act === 'voir') voir();
      else if (b.dataset.act === 'ajouter') ajouter();
    });
  
    chipsEl.innerHTML = THEMES.map(t => `<button type="button" data-id="${esc(t.id)}" style="--c:${t.couleur}"><i class="fa-solid ${t.icone}"></i> ${esc(t.id)}</button>`).join('');
    chipsEl.addEventListener('click', e => { const b = e.target.closest('button'); if (b) choisir(b.dataset.id === (theme && theme.id) ? null : b.dataset.id); });
  
    fetch('sites.json', { cache: 'no-cache' }).then(r => r.json()).then(fc => { lieux = (fc.features || []).filter(f => f.geometry && f.properties); render(); })
      .catch(() => { bodyEl.innerHTML = '<p class="gp-hint">Les circuits thématiques sont indisponibles (sites.json introuvable).</p>'; });
  })();