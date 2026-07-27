(() => {
  'use strict';
  const STORAGE_KEY = 'materialPermanente:lastApp';
  const path = window.location.pathname;
  const current = path.includes('/app-atual/') ? 'processos' : path.includes('/caderno-2025/') ? 'caderno' : null;
  document.body.classList.add('suite-integrated');

  document.querySelectorAll('[data-suite-app]').forEach((link) => {
    const isCurrent = link.dataset.suiteApp === current;
    if (isCurrent) {
      link.setAttribute('aria-current', 'page');
      link.addEventListener('click', (event) => event.preventDefault());
    }
    link.addEventListener('click', () => {
      try { localStorage.setItem(STORAGE_KEY, link.dataset.suiteApp); } catch {}
    });
  });

  if (current) {
    try { localStorage.setItem(STORAGE_KEY, current); } catch {}
  }

  document.querySelector('[data-suite-menu]')?.addEventListener('click', () => {
    try { sessionStorage.setItem('materialPermanente:returningToMenu', '1'); } catch {}
  });
})();