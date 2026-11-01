/* ============================================================
   AVIS DES VISITEURS — pages des départements (thies.html, mbour.html, tivaouane.html)
   Conteneur attendu : <div class="av-widget" data-page="thies|mbour|tivaouane"></div>
   API : GET /api/avis?page=… (avis publiés) · POST /api/avis (dépôt, publié après modération)
   ============================================================ */
(function () {
  'use strict';
  const API = (window.GEO_API_BASE || '') + '/api/avis';
  const MAX = 1000;
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // étoiles en caractères Unicode : elles s'affichent même si la police d'icônes ne se charge pas
  const etoiles = n => [1, 2, 3, 4, 5].map(i => `<span class="${i <= n ? 'av-pleine' : 'av-vide'}">★</span>`).join('');
  const dateFr = iso => { const d = new Date(iso); return isNaN(d) ? '' : d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' }); };

  function gabarit(page) {
    return `
      <div class="av-head">
        <h3><i class="fa-regular fa-comments"></i> Avis des visiteurs du site</h3>
        <p class="av-resume" aria-live="polite">Chargement des avis…</p>
      </div>
      <div class="av-liste"></div>
      <button type="button" class="av-ouvrir"><i class="fa-solid fa-pen"></i> Laisser un avis</button>
      <form class="av-form" hidden novalidate>
        <div class="av-ligne">
          <label>Prénom ou pseudonyme <input name="nom" maxlength="60" required autocomplete="given-name"></label>
          <fieldset class="av-note"><legend>Votre note</legend><div class="av-choix">
            ${[5, 4, 3, 2, 1].map(n => `<input type="radio" id="av-${page}-${n}" name="note" value="${n}" required><label for="av-${page}-${n}" title="${n} sur 5">★</label>`).join('')}
          </div></fieldset>
        </div>
        <label>Votre commentaire
          <textarea name="commentaire" rows="4" maxlength="${MAX}" required placeholder="Ce que vous avez visité, ce qui vous a plu, vos conseils…"></textarea>
          <small class="av-compteur">0 / ${MAX}</small>
        </label>
        <div class="av-piege" aria-hidden="true"><label>Ne pas remplir <input name="ne_pas_remplir" tabindex="-1" autocomplete="new-password"></label></div>
        <div class="av-actions">
          <button type="submit" class="av-envoyer"><i class="fa-solid fa-paper-plane"></i> Envoyer mon avis</button>
          <button type="button" class="av-annuler">Annuler</button>
        </div>
        <p class="av-mention">Votre prénom (ou pseudonyme) et votre commentaire seront publiés après validation par l'équipe.</p>
        <p class="av-message" role="status"></p>
      </form>`;
  }

  async function charger(w, page) {
    const resume = w.querySelector('.av-resume'), liste = w.querySelector('.av-liste');
    try {
      const r = await fetch(`${API}?page=${encodeURIComponent(page)}`, { headers: { Accept: 'application/json' } });
      if (!r.ok) throw new Error(r.status);
      const d = await r.json();
      if (!d.nombre) {
        resume.textContent = 'Aucun avis publié pour le moment. Soyez le premier à partager votre expérience !';
        liste.innerHTML = '';
        return;
      }
      resume.innerHTML = `<span class="av-moy">${String(d.moyenne).replace('.', ',')}</span> <span class="av-etoiles">${etoiles(Math.round(d.moyenne))}</span> · ${d.nombre} avis publié${d.nombre > 1 ? 's' : ''}`;
      liste.innerHTML = d.avis.map(a => `
        <article class="av-carte">
          <div class="av-carte-tete"><span class="av-avatar">${esc((a.nom || '?').charAt(0).toUpperCase())}</span>
            <div><b>${esc(a.nom)}</b><small>${esc(dateFr(a.date))}</small></div>
            <span class="av-etoiles" aria-label="${a.note} sur 5">${etoiles(a.note)}</span></div>
          <p>${esc(a.commentaire)}</p>
        </article>`).join('');
    } catch (e) {
      resume.textContent = 'Les avis ne peuvent pas être chargés pour le moment.';
    }
  }

  /** Transforme la réponse d'erreur du serveur en phrase compréhensible. */
  async function raison(r) {
    if (r.status === 429) return 'Trop d\'avis envoyés depuis cette connexion. Réessayez dans une heure.';
    if (r.status === 404 || r.status === 405 || r.status === 501)
      return 'Le service des avis n\'est pas joignable. Ouvrez le site par le serveur Django (http://127.0.0.1:8000/…), pas en ouvrant directement le fichier HTML.';
    let detail = '';
    try {
      const j = await r.json();
      const e = j.error ?? j;
      detail = typeof e === 'string' ? e : Object.values(e).flat().join(' ; ');
    } catch (_) { /* réponse non JSON */ }
    if (r.status >= 500) return `Erreur du serveur${detail ? ' : ' + detail : ''}.`;
    return detail ? `Avis refusé : ${detail}.` : `Avis refusé (erreur ${r.status}).`;
  }

  function initForm(w, page) {
    const form = w.querySelector('.av-form'), ouvrir = w.querySelector('.av-ouvrir'), msg = w.querySelector('.av-message');
    const zone = form.querySelector('textarea'), compteur = form.querySelector('.av-compteur');
    const afficher = v => { form.hidden = !v; ouvrir.hidden = v; if (v) form.querySelector('input[name="nom"]').focus(); };
    ouvrir.addEventListener('click', () => afficher(true));
    form.querySelector('.av-annuler').addEventListener('click', () => { afficher(false); msg.textContent = ''; });
    zone.addEventListener('input', () => { compteur.textContent = `${zone.value.length} / ${MAX}`; });

    form.addEventListener('submit', async e => {
      e.preventDefault();
      msg.className = 'av-message';
      const d = Object.fromEntries(new FormData(form));
      const erreur = !d.nom || d.nom.trim().length < 2 ? 'Indiquez un prénom ou un pseudonyme.'
        : !d.note ? 'Choisissez une note de 1 à 5 étoiles.'
        : !d.commentaire || d.commentaire.trim().length < 10 ? 'Votre commentaire doit faire au moins 10 caractères.' : '';
      if (erreur) { msg.textContent = erreur; msg.classList.add('av-erreur'); return; }
      const bouton = form.querySelector('.av-envoyer'); bouton.disabled = true;
      try {
        const r = await fetch(API, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ page, nom: d.nom.trim(), note: +d.note, commentaire: d.commentaire.trim(), site_web: d.ne_pas_remplir || '' }),
        });
        if (!r.ok) throw new Error(await raison(r));
        form.reset(); compteur.textContent = `0 / ${MAX}`;
        msg.textContent = 'Merci ! Votre avis a bien été reçu. Il sera publié après validation par l\'équipe.';
        msg.classList.add('av-ok');
      } catch (err) {
        msg.textContent = err.message && !/fetch/i.test(err.message) ? err.message : 'Le service est indisponible pour le moment. Réessayez plus tard.';
        msg.classList.add('av-erreur');
      } finally { bouton.disabled = false; }
    });
  }

  document.querySelectorAll('.av-widget[data-page]').forEach(w => {
    const page = w.dataset.page;
    w.innerHTML = gabarit(page);
    initForm(w, page);
    charger(w, page);
  });
})();
