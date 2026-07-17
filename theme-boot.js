/* Local PDF — early theme application (runs before <body> paints to avoid a
 * flash). Loaded blocking in <head>. Reads localStorage "localpdf.theme"
 * ("light" | "dark" | "system"; unset ⇒ system) and sets data-theme on <html>.
 * The full toggle wiring + matchMedia live-update listener lives in app.js. */
"use strict";
(function () {
  var KEY = "localpdf.theme";
  var pref;
  try { pref = localStorage.getItem(KEY); } catch (e) { pref = null; }
  var effective;
  if (pref === "light" || pref === "dark") {
    effective = pref;
  } else {
    // "system" or unset → follow the OS preference.
    effective = (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) ? "dark" : "light";
  }
  document.documentElement.setAttribute("data-theme", effective);
})();
