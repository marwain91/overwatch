// Applies the saved theme before first paint. A static file because the CSP
// forbids inline scripts; keep the key in sync with stores/themeStore.ts.
(function () {
  var theme = 'system';
  try { theme = localStorage.getItem('overwatch_theme') || 'system'; } catch (e) { /* storage blocked */ }
  var dark = theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  if (dark) document.documentElement.classList.add('dark');
})();
