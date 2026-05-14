// Runs before paint to flip `<html data-theme="dark">` if the user picked
// dark mode previously. Kept in its own file (rather than inline in
// index.html) so a strict `script-src 'self'` Content Security Policy
// can disallow inline execution entirely.
(function () {
  try {
    var t = localStorage.getItem('theme');
    if (t === 'dark') document.documentElement.dataset.theme = 'dark';
  } catch (e) {
    /* localStorage disabled — fall back to light theme */
  }
})();
