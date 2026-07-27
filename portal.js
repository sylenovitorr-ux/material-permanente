(() => {
  'use strict';

  const STORAGE_KEY = 'materialPermanente:lastApp';
  const cards = [...document.querySelectorAll('[data-app]')];
  const resume = document.querySelector('[data-resume]');
  const resumeName = document.querySelector('[data-resume-name]');
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const appNames = {
    processos: 'Meus processos',
    caderno: 'Caderno 2025'
  };

  function readLastApp() {
    try {
      return localStorage.getItem(STORAGE_KEY);
    } catch {
      return null;
    }
  }

  function saveLastApp(appId) {
    try {
      localStorage.setItem(STORAGE_KEY, appId);
    } catch {
      // O portal continua funcionando quando o armazenamento está bloqueado.
    }
  }

  function markLastApp(appId) {
    cards.forEach((card) => {
      const isLast = card.dataset.app === appId;
      card.classList.toggle('is-last-used', isLast);

      const marker = card.querySelector('[data-last-marker]');
      if (marker) marker.hidden = !isLast;
    });

    const activeCard = cards.find((card) => card.dataset.app === appId);
    if (!resume || !activeCard || !appNames[appId]) return;

    resume.hidden = false;
    resume.href = activeCard.href;
    resume.dataset.app = appId;
    if (resumeName) resumeName.textContent = appNames[appId];
  }

  function openCard(card) {
    if (!card || card.classList.contains('is-opening')) return;

    saveLastApp(card.dataset.app);
    markLastApp(card.dataset.app);
    card.classList.add('is-opening');
    card.setAttribute('aria-busy', 'true');

    const label = card.querySelector('[data-open-label]');
    if (label) {
      label.dataset.originalText ||= label.textContent;
      label.textContent = 'Abrindo…';
    }

    if (!reducedMotion) document.body.classList.add('is-navigating');
  }

  cards.forEach((card) => {
    card.addEventListener('click', () => openCard(card));
  });

  if (resume) {
    resume.addEventListener('click', () => {
      const card = cards.find((item) => item.dataset.app === resume.dataset.app);
      openCard(card);
    });
  }

  document.addEventListener('keydown', (event) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName)) return;

    const index = Number(event.key) - 1;
    const card = cards[index];
    if (!card) return;

    event.preventDefault();
    card.focus();
  });

  window.addEventListener('pageshow', () => {
    document.body.classList.remove('is-navigating');
    cards.forEach((card) => {
      card.classList.remove('is-opening');
      card.removeAttribute('aria-busy');
      const label = card.querySelector('[data-open-label]');
      if (label?.dataset.originalText) label.textContent = label.dataset.originalText;
    });
  });

  const lastApp = readLastApp();
  if (lastApp && appNames[lastApp]) markLastApp(lastApp);
})();
