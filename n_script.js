// Signal CSS that JS loaded — enables scroll animations
document.body.classList.add('js-ready');

// Respect prefers-reduced-motion throughout
const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function smoothScrollTo(target) {
  const behavior = prefersReducedMotion ? 'auto' : 'smooth';
  if (typeof target === 'string') {
    const el = document.getElementById(target);
    if (el) el.scrollIntoView({ behavior, block: 'start' });
  } else if (target && target.scrollIntoView) {
    target.scrollIntoView({ behavior, block: 'start' });
  } else {
    window.scrollTo({ top: 0, behavior });
  }
}

/* ============================================================
   RAF-THROTTLED SCROLL HANDLER
   Drives: navbar state, back-to-top button, reading progress
   bar, and scroll-spy active nav link.
   ============================================================ */
const navbar = document.getElementById('navbar');
const backTop = document.getElementById('back-top');
const progressBar = document.getElementById('reading-progress');

let ticking = false;

function updateNavbarAndBackTop() {
  if (window.scrollY > 60) {
    navbar.classList.add('scrolled');
    backTop.classList.add('show');
  } else {
    navbar.classList.remove('scrolled');
    backTop.classList.remove('show');
  }
}

function updateReadingProgress() {
  if (!progressBar) return;
  const scrollTop = window.scrollY;
  const docHeight = document.documentElement.scrollHeight - window.innerHeight;
  const pct = docHeight > 0 ? Math.min(100, Math.max(0, (scrollTop / docHeight) * 100)) : 0;
  progressBar.style.width = pct + '%';
}

function onScroll() {
  if (!ticking) {
    window.requestAnimationFrame(() => {
      updateNavbarAndBackTop();
      updateReadingProgress();
      ticking = false;
    });
    ticking = true;
  }
}

window.addEventListener('scroll', onScroll, { passive: true });
// Run once on load in case the page opens already scrolled (e.g. anchor link)
updateNavbarAndBackTop();
updateReadingProgress();

backTop.addEventListener('click', () => smoothScrollTo(null));
// Replace inline onclick fallback so reduced-motion is respected
backTop.removeAttribute('onclick');

/* ============================================================
   HAMBURGER MENU — accessible (aria-expanded) + Escape to close
   ============================================================ */
const ham = document.getElementById('hamburger');
const mob = document.getElementById('mobileMenu');

function openMobileMenu() {
  ham.classList.add('open');
  mob.classList.add('open');
  ham.setAttribute('aria-expanded', 'true');
  mob.setAttribute('aria-hidden', 'false');
}

function closeMobileMenu({ returnFocus = false } = {}) {
  ham.classList.remove('open');
  mob.classList.remove('open');
  ham.setAttribute('aria-expanded', 'false');
  mob.setAttribute('aria-hidden', 'true');
  if (returnFocus) ham.focus();
}

ham.addEventListener('click', () => {
  const isOpen = ham.classList.contains('open');
  if (isOpen) closeMobileMenu();
  else openMobileMenu();
});

mob.querySelectorAll('a').forEach(a => {
  a.addEventListener('click', () => closeMobileMenu());
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && mob.classList.contains('open')) {
    closeMobileMenu({ returnFocus: true });
  }
});

/* ============================================================
   BANDEAU COUP DE CŒUR / GÉOPORTAIL — défilement horizontal
   Alterne entre les deux messages toutes les 5 secondes.
   ============================================================ */
const coupCoeurTrack = document.getElementById('coupCoeurTrack');
if (coupCoeurTrack) {
  let coupCoeurIndex = 0;
  setInterval(() => {
    coupCoeurIndex = (coupCoeurIndex + 1) % 2;
    coupCoeurTrack.classList.toggle('slide-2', coupCoeurIndex === 1);
  }, 5000);
}

/* ============================================================
   SLIDER "POURQUOI VISITER" — une raison à la fois, image de
   fond plein écran, flèches + dots + rotation auto (6s).
   ============================================================ */
(function () {
  const slides = Array.from(document.querySelectorAll('#whySlider .why-slide'));
  const dots = Array.from(document.querySelectorAll('#whySliderDots .why-dot'));
  if (!slides.length) return;

  let current = 0;
  let autoTimer = null;

  function goTo(index) {
    current = (index + slides.length) % slides.length;
    slides.forEach((s, i) => s.classList.toggle('active', i === current));
    dots.forEach((d, i) => d.classList.toggle('active', i === current));
  }

  function stopAuto() { if (autoTimer) clearInterval(autoTimer); }
  function startAuto() {
    if (prefersReducedMotion) return;
    stopAuto();
    autoTimer = setInterval(() => goTo(current + 1), 6000);
  }

  window.whySliderNav = function (dir) { goTo(current + dir); startAuto(); };
  window.whySliderGoTo = function (i) { goTo(i); startAuto(); };

  goTo(0);
  startAuto();
})();

/* ============================================================
   SITE / DEPARTMENT FILTERS
   Every mixed-department grid (sites, expériences, galerie,
   hébergements, restaurants) carries cards tagged data-dept
   ("thies" | "mbour" | "tivaouane"). Some grids (sites) also
   carry a secondary data-cat filter. Both filters are tracked
   per-section (via dataset on the <section>) and combined.
   ============================================================ */
function applySectionFilters(section) {
  if (!section) return;
  const dept = section.dataset.deptFilter || 'all';
  const cat = section.dataset.catFilter || 'all';
  section.querySelectorAll('[data-dept]').forEach(card => {
    const deptOk = dept === 'all' || card.dataset.dept === dept;
    const catOk = cat === 'all' || !card.dataset.cat || card.dataset.cat === cat;
    card.style.display = (deptOk && catOk) ? '' : 'none';
  });
}

// Department tabs — reusable across every mixed-department section
function filterByDept(dept, btn, sectionSelector) {
  const section = document.querySelector(sectionSelector);
  if (!section) return;
  section.querySelectorAll('.dept-filter-bar .filter-btn').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  section.dataset.deptFilter = dept;
  applySectionFilters(section);
}

// Category filter — used only within #sites, alongside the department tabs
function filterSites(cat, btn) {
  const section = document.getElementById('sites');
  section.querySelectorAll('.filter-bar:not(.dept-filter-bar) .filter-btn').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  section.dataset.catFilter = cat;
  applySectionFilters(section);
}

// Search from hero quick hints
function filterSitesFromHero(cat) {
  smoothScrollTo('sites');
  setTimeout(() => {
    const btn = document.querySelector(`#sites .filter-bar:not(.dept-filter-bar) .filter-btn[onclick*="${cat}"]`);
    filterSites(cat, btn);
  }, prefersReducedMotion ? 0 : 600);
}

// Hero search bar
document.getElementById('heroSearch').addEventListener('keydown', function (e) {
  if (e.key === 'Enter') {
    smoothScrollTo('sites');
  }
});

/* ============================================================
   SCROLL ANIMATIONS (IntersectionObserver)
   Skipped entirely when reduced motion is requested — CSS
   already forces full opacity in that case.
   ============================================================ */
if (!prefersReducedMotion) {
  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add('visible');
      }
    });
  }, { threshold: 0.12 });

  document.querySelectorAll(
    '.why-card, .site-card, .exp-card, .timeline-item, .fade-in'
  ).forEach(el => observer.observe(el));

  // Staggered delay for grid items
  document.querySelectorAll('.why-grid .why-card').forEach((el, i) => {
    el.style.transitionDelay = (i * 0.1) + 's';
  });
  document.querySelectorAll('.sites-grid .site-card').forEach((el, i) => {
    el.style.transitionDelay = (i * 0.08) + 's';
  });
  document.querySelectorAll('.exp-grid .exp-card').forEach((el, i) => {
    el.style.transitionDelay = (i * 0.1) + 's';
  });
}

/* ============================================================
   SCROLL-SPY — highlights the nav link matching the visible section
   ============================================================ */
const spySections = Array.from(document.querySelectorAll('section[id]'));
const desktopNavLinks = Array.from(document.querySelectorAll('.nav-links > li > a[href^="#"]'));
const mobileNavLinks = Array.from(document.querySelectorAll('.mobile-menu a[href^="#"]'));

function setActiveNav(id) {
  [...desktopNavLinks, ...mobileNavLinks].forEach(a => {
    const match = a.getAttribute('href') === '#' + id;
    a.classList.toggle('active', match);
  });
}

if (spySections.length) {
  const spyObserver = new IntersectionObserver((entries) => {
    // Pick the most visible intersecting section
    let best = null;
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        if (!best || entry.intersectionRatio > best.intersectionRatio) best = entry;
      }
    });
    if (best) setActiveNav(best.target.id);
  }, { rootMargin: '-40% 0px -50% 0px', threshold: [0, 0.25, 0.5, 0.75, 1] });

  spySections.forEach(sec => spyObserver.observe(sec));
}

/* ============================================================
   TOAST NOTIFICATIONS
   ============================================================ */
const toastContainer = document.getElementById('toast-container');
const TOAST_ICONS = {
  success: 'fa-circle-check',
  error: 'fa-circle-exclamation',
  info: 'fa-circle-info'
};

function showToast(message, type = 'info', duration = 4500) {
  if (!toastContainer) return;
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.setAttribute('role', 'status');
  toast.innerHTML = `
    <i class="fa-solid ${TOAST_ICONS[type] || TOAST_ICONS.info}"></i>
    <span>${message}</span>
    <button class="toast-close" aria-label="Fermer la notification"><i class="fa-solid fa-xmark"></i></button>
  `;
  toastContainer.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('show'));

  const remove = () => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 300);
  };
  toast.querySelector('.toast-close').addEventListener('click', remove);
  const timer = setTimeout(remove, duration);
  toast.addEventListener('mouseenter', () => clearTimeout(timer));
}

/* ============================================================
   GALLERY LIGHTBOX — keyboard accessible
   ============================================================ */
const gItems = Array.from(document.querySelectorAll('.g-item'));
const lightboxOverlay = document.getElementById('lightboxOverlay');
const lightboxVisual = document.getElementById('lightboxVisual');
const lightboxTitle = document.getElementById('lightboxTitle');
const lightboxCount = document.getElementById('lightboxCount');
const lightboxClose = document.getElementById('lightboxClose');
const lightboxPrev = document.getElementById('lightboxPrev');
const lightboxNext = document.getElementById('lightboxNext');

let lbIndex = 0;
let lbLastFocused = null;

const galleryData = gItems.map(item => ({
  bgClass: item.querySelector('.g-bg').className,
  iconHtml: item.querySelector('.g-bg i').outerHTML,
  label: item.querySelector('.g-label').textContent
}));

function openLightbox(index) {
  if (!lightboxOverlay || !galleryData.length) return;
  lbIndex = index;
  lbLastFocused = document.activeElement;
  renderLightbox();
  lightboxOverlay.classList.add('open');
  document.body.style.overflow = 'hidden';
  lightboxClose.focus();
}

function renderLightbox() {
  const data = galleryData[lbIndex];
  lightboxVisual.className = 'lightbox-visual ' + data.bgClass.replace('g-bg', '').trim();
  lightboxVisual.innerHTML = data.iconHtml;
  lightboxTitle.textContent = data.label;
  lightboxCount.textContent = (lbIndex + 1) + ' / ' + galleryData.length;
}

function closeLightbox() {
  lightboxOverlay.classList.remove('open');
  document.body.style.overflow = '';
  if (lbLastFocused) lbLastFocused.focus();
}

function shiftLightbox(dir) {
  lbIndex = (lbIndex + dir + galleryData.length) % galleryData.length;
  renderLightbox();
}

gItems.forEach((item, i) => {
  item.addEventListener('click', () => openLightbox(i));
  item.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openLightbox(i);
    }
  });
});

if (lightboxOverlay) {
  lightboxClose.addEventListener('click', closeLightbox);
  lightboxPrev.addEventListener('click', () => shiftLightbox(-1));
  lightboxNext.addEventListener('click', () => shiftLightbox(1));
  lightboxOverlay.addEventListener('click', (e) => {
    if (e.target === lightboxOverlay) closeLightbox();
  });
  document.addEventListener('keydown', (e) => {
    if (!lightboxOverlay.classList.contains('open')) return;
    if (e.key === 'Escape') closeLightbox();
    if (e.key === 'ArrowLeft') shiftLightbox(-1);
    if (e.key === 'ArrowRight') shiftLightbox(1);
  });
}

/* ============================================================
   CONTACT FORM VALIDATION
   ============================================================ */
const contactForm = document.getElementById('contactForm');

function validateField(field) {
  const group = field.closest('.form-group');
  let valid = true;

  if (field.hasAttribute('required')) {
    if (field.tagName === 'SELECT') {
      valid = field.value.trim() !== '';
    } else if (field.type === 'email') {
      const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      valid = emailRe.test(field.value.trim());
    } else if (field.id === 'cfMessage') {
      valid = field.value.trim().length >= 10;
    } else {
      valid = field.value.trim() !== '';
    }
  }

  group.classList.toggle('invalid', !valid);
  field.setAttribute('aria-invalid', String(!valid));
  return valid;
}

if (contactForm) {
  const fields = Array.from(contactForm.querySelectorAll('input, select, textarea'));

  fields.forEach(field => {
    field.addEventListener('blur', () => validateField(field));
    field.addEventListener('input', () => {
      if (field.closest('.form-group').classList.contains('invalid')) {
        validateField(field);
      }
    });
  });

  contactForm.addEventListener('submit', (e) => {
    e.preventDefault();
    let allValid = true;
    let firstInvalid = null;

    fields.forEach(field => {
      const ok = validateField(field);
      if (!ok) {
        allValid = false;
        if (!firstInvalid) firstInvalid = field;
      }
    });

    if (!allValid) {
      if (firstInvalid) firstInvalid.focus();
      showToast('Merci de corriger les champs en rouge avant d\'envoyer.', 'error');
      return;
    }

    // No backend wired up yet — simulate a successful submission
    showToast('Message envoyé ! Nous vous répondrons rapidement.', 'success');
    contactForm.reset();
    fields.forEach(field => field.closest('.form-group').classList.remove('invalid'));
  });
}

/* ============================================================
   NEWSLETTER — lightweight feedback via toast
   ============================================================ */
const newsletterForm = document.querySelector('.newsletter-form');
if (newsletterForm) {
  const newsletterInput = newsletterForm.querySelector('input[type="email"]');
  const newsletterBtn = newsletterForm.querySelector('button');
  if (newsletterInput && newsletterBtn) {
    newsletterBtn.addEventListener('click', () => {
      const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRe.test(newsletterInput.value.trim())) {
        showToast('Entrez une adresse email valide.', 'error');
        newsletterInput.focus();
        return;
      }
      showToast('Inscription confirmée — à bientôt !', 'success');
      newsletterInput.value = '';
    });
  }
}