/* ATOM theme bootstrap. A classic (blocking) script so the chosen theme is on <html> before the first paint:
   without it a dark-theme user would see a flash of the light page while the app loads.
   - Plain file, not inline: the site's Content-Security-Policy is script-src 'self'.
   - Lives in /assets/ because IIS only serves that folder (and a short whitelist) before the SPA fallback.
   - The service worker keeps /assets/ files forever, so if you change this file RENAME it
     (theme-init-v3.js) and update index.html — otherwise browsers keep running the old copy.
   v2: the browser-bar colour tag is REPLACED, not edited. Some phone browsers ignore a changed `content` on a
   tag that already exists and stay on the first colour (the teal fallback in index.html).
   Keep the storage keys and ids in step with src/theme/themes.js. Defaults: teal + light (today's look). */
(function () {
  var theme = 'teal';
  var mode = 'light';
  var motion = 'system';
  try {
    var t = localStorage.getItem('atom.theme');
    var m = localStorage.getItem('atom.mode');
    var a = localStorage.getItem('atom.motion');
    if (t === 'teal' || t === 'navy' || t === 'maroon') theme = t;
    if (m === 'light' || m === 'dark' || m === 'system') mode = m;
    if (a === 'full' || a === 'reduced') motion = a;
  } catch (e) { // eslint-disable-line no-unused-vars
    /* storage blocked: stay on the defaults */
  }

  var dark = mode === 'dark';
  if (mode === 'system') {
    dark = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches;
  }
  var root = document.documentElement;
  root.setAttribute('data-theme', theme);
  root.setAttribute('data-mode', dark ? 'dark' : 'light');
  // Animations: only an explicit choice sets the attribute; otherwise the CSS follows the device.
  if (motion !== 'system') root.setAttribute('data-motion', motion);

  // Browser bars (address bar, phone bottom toolbar, installed-app bar): the primary of the theme in use.
  var PRIMARY = {
    teal: ['#0F5B5A', '#0E4E4D'],
    navy: ['#1E3A6E', '#22427C'],
    maroon: ['#721634', '#7E1C3E'],
  };
  var head = document.head;
  var old = head.querySelectorAll('meta[name="theme-color"]');
  for (var i = 0; i < old.length; i += 1) old[i].parentNode.removeChild(old[i]);
  var meta = document.createElement('meta');
  meta.setAttribute('name', 'theme-color');
  meta.setAttribute('content', PRIMARY[theme][dark ? 1 : 0]);
  head.appendChild(meta);
})();
