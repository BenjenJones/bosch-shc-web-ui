/** @type {import('tailwindcss').Config} */
module.exports = {
  // Scan everything the express server actually ships — these are the only
  // places a class name can legitimately appear. The CLI walks these files
  // and tree-shakes Tailwind's ~10k utilities down to the ~50 we use.
  content: ['./public/**/*.{html,js}'],
  // dataset.theme = 'dark' is set by public/init.js before paint, so we
  // toggle dark variants on `[data-theme="dark"]` rather than the default
  // `prefers-color-scheme` media query.
  darkMode: ['selector', '[data-theme="dark"]'],
  theme: { extend: {} },
  plugins: [],
};
