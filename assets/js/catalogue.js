/* ============================================================
   CATALOGUE — Liste filtrable des établissements
   ============================================================ */
   const GEOJSON_URLS = {
    hebergement: 'hebergements.geojson',
    restaurant:  'restaurants.geojson',
    site:        'sites.json',
  };
  
  const CAT_ICONS = { hebergement: 'fa-hotel', restaurant: 'fa-utensils', site: 'fa-mountain-sun' };
  const CAT_LABELS = { hebergement: 'Hébergement', restaurant: 'Restauration', site: 'Site touristique' };
  const DEPT_COLORS = { THIES: '#A16D32', MBOUR: '#286D73', TIVAOUANE: '#64748B' };
  
  let allFeatures = [];
  
  function escapeHtml(s) {
    if (s == null) return '';
    return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }
  function formatPhone(tel) {
    if (!tel) return '';
    const d = String(tel).replace(/\D/g, '');
    if (d.length === 9) return `+221 ${d.slice(0,2)} ${d.slice(2,5)} ${d.slice(5,7)} ${d.slice(7)}`;
    return tel;
  }
  
  function renderCards(features) {
    const grid = document.getElementById('catGrid');
    const count = document.getElementById('catCount');
  
    if (features.length === 0) {
      grid.innerHTML = `<div class="cat-empty" style="grid-column:1/-1"><i class="fa-solid fa-magnifying-glass"></i>Aucun résultat</div>`;
      count.textContent = '0 résultat';
      return;
    }
    count.textContent = `${features.length} résultat${features.length > 1 ? 's' : ''}`;
  
    grid.innerHTML = features.map((f, idx) => {
      const p = f.properties;
      const [lon, lat] = f.geometry.coordinates;
      const color = DEPT_COLORS[p.departement] || '#64748B';
      const icon = CAT_ICONS[p.categorie] || 'fa-location-dot';
  
      const chips = [];
      if (p.piscine) chips.push('Piscine');
      if (p.wifi) chips.push('Wi-Fi');
      if (p.nb_chambres) chips.push(`${p.nb_chambres} ch.`);
      if (p.modalite) chips.push(p.modalite.split('/')[0]);
  
      return `
        <article class="cat-card" data-idx="${idx}">
          <div class="cat-card-hero" style="background:linear-gradient(135deg, ${color}33, ${color}99)">
            <span class="cat-card-dept">${escapeHtml(p.departement || '')}</span>
            <i class="fa-solid ${icon}"></i>
          </div>
          <div class="cat-card-body">
            <div class="cat-card-type">${escapeHtml(p.type || CAT_LABELS[p.categorie])}</div>
            <h3>${escapeHtml(p.nom)}</h3>
            <div class="cat-card-loc">
              <i class="fa-solid fa-location-dot"></i>
              ${escapeHtml(p.commune || '')}${p.commune ? ', ' : ''}${escapeHtml(p.departement || '')}
            </div>
            ${chips.length ? `<div class="cat-card-meta">${chips.map(c => `<span class="cat-chip">${escapeHtml(c)}</span>`).join('')}</div>` : ''}
          </div>
          <div class="cat-card-actions">
            <a class="primary" href="carte.html?lat=${lat}&lon=${lon}&z=17" target="_blank">
              <i class="fa-solid fa-map"></i> Voir sur la carte
            </a>
            <a class="secondary" href="carte.html?lieu=${encodeURIComponent(p.nom)}&lat=${lat}&lon=${lon}&itineraire=1" target="_blank">
              <i class="fa-solid fa-diamond-turn-right"></i> Itinéraire
            </a>
          </div>
        </article>
      `;
    }).join('');
  }
  
  function applyFilters() {
    const q = document.getElementById('catSearch').value.trim().toLowerCase();
    const cat = document.getElementById('catCat').value;
    const dept = document.getElementById('catDept').value;
    const commune = document.getElementById('catCommune').value;
  
    const results = allFeatures.filter(f => {
      const p = f.properties;
      if (cat && p.categorie !== cat) return false;
      if (dept && p.departement !== dept) return false;
      if (commune && p.commune !== commune) return false;
      if (q) {
        const haystack = `${p.nom || ''} ${p.commune || ''} ${p.type || ''} ${p.departement || ''}`.toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    });
  
    renderCards(results);
  }
  
  function populateCommunes() {
    const select = document.getElementById('catCommune');
    const communes = [...new Set(allFeatures.map(f => f.properties.commune).filter(Boolean))].sort();
    select.innerHTML = '<option value="">Toutes</option>' +
      communes.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
  }
  
  async function init() {
    document.querySelectorAll('#catSearch, #catCat, #catDept, #catCommune')
      .forEach(el => el.addEventListener('input', applyFilters));
  
    document.getElementById('catReset').addEventListener('click', () => {
      document.getElementById('catSearch').value = '';
      document.getElementById('catCat').value = '';
      document.getElementById('catDept').value = '';
      document.getElementById('catCommune').value = '';
      applyFilters();
    });
  
    document.getElementById('gpMobileMenu').addEventListener('click', () => {
      document.querySelector('.gp-nav').classList.toggle('open');
    });
  
    try {
      const [heb, resto, sites] = await Promise.all([
        fetch(GEOJSON_URLS.hebergement).then(r => r.json()),
        fetch(GEOJSON_URLS.restaurant).then(r => r.json()),
        fetch(GEOJSON_URLS.site).then(r => r.json()).catch(() => ({ features: [] })),
      ]);
      allFeatures = [...heb.features, ...resto.features, ...sites.features];
      populateCommunes();
      applyFilters();
    } catch (err) {
      console.error(err);
      document.getElementById('catCount').textContent = 'Erreur de chargement des données';
    }
  }
  
  init();