/* Local PDF — 100% in-browser PDF tools. Your files/content never leave the
 * device; the only network use is the optional Pro purchase/restore via
 * Stripe/RevenueCat, which sends just an anonymous id / restore code — never
 * your PDFs or their text.
 * pdf-lib (window.PDFLib) builds/edits PDFs; pdf.js (window.pdfjsLib) renders.
 *
 * SECURITY: filenames and error text are attacker-controlled, so they are
 * ALWAYS written via textContent — never interpolated into innerHTML. A strict
 * CSP (see index.html) enforces the no-upload promise at the browser level. */
"use strict";

pdfjsLib.GlobalWorkerOptions.workerSrc = "lib/pdf.worker.min.js";
const { PDFDocument, degrees, radians, StandardFonts, rgb } = PDFLib;

// ── DOM helpers ─────────────────────────────────────────────────────
const $ = (sel, root = document) => root.querySelector(sel);
// el(tag, cls[, html]) — `html` is ONLY ever passed constant, developer-authored
// markup (icons, static labels). Never pass user/file-derived strings here.
const el = (tag, cls, html) => { const n = document.createElement(tag); if (cls) n.className = cls; if (html != null) n.innerHTML = html; return n; };
const txt = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
const readBytes = (file) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(new Uint8Array(r.result)); r.onerror = () => rej(new Error("READ_FAILED")); r.readAsArrayBuffer(file); });

// ── Theme (light / dark / system) ───────────────────────────────────
// theme-boot.js already applied the effective theme to <html> before paint;
// here we wire the topbar toggle, persist the choice, and live-update when
// the OS preference changes while on "system".
const Theme = (() => {
  const KEY = "localpdf.theme"; // "light" | "dark" | "system" (unset ⇒ system)
  const SUN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4.2"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
  const MOON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';
  const AUTO = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 0 0 18z" fill="currentColor" stroke="none"/></svg>';
  const mql = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;
  const read = () => { try { return localStorage.getItem(KEY); } catch { return null; } };
  const pref = () => { const p = read(); return (p === "light" || p === "dark") ? p : "system"; };
  const effective = () => { const p = pref(); return p === "system" ? (mql && mql.matches ? "dark" : "light") : p; };
  function apply() { document.documentElement.setAttribute("data-theme", effective()); refreshBtn(); }
  let btn = null;
  function refreshBtn() {
    if (!btn) return;
    const p = pref();
    // The icon reflects the CURRENT rendered mode (sun in light, moon in dark) so it
    // matches the sibling apps even when following the system theme; the aria-label/
    // title still convey whether the preference is light, dark, or system.
    btn.innerHTML = effective() === "dark" ? MOON : SUN;
    // Next action mirrors cycle(): from "system" the click flips to the opposite
    // of what's rendered now (so the label matches what the user will actually see).
    const nextLabel = p === "system" ? (effective() === "dark" ? "light" : "dark") : { dark: "light", light: "system" }[p];
    btn.setAttribute("aria-label", "Switch theme (currently " + (p === "system" ? "system" : p) + ", tap for " + nextLabel + ")");
    btn.setAttribute("title", "Theme: " + (p === "system" ? "System" : p.charAt(0).toUpperCase() + p.slice(1)));
  }
  // Cycle so EVERY click visibly changes the rendered theme (matches LocalResume):
  // from "system"/unset, flip to the OPPOSITE of what's currently rendered — this
  // avoids a no-op first click when the OS already matches "light". After that:
  // dark → light → system, keeping all three states reachable.
  function cycle() {
    const cur = pref();
    const renderedDark = effective() === "dark";
    const next = cur === "system" ? (renderedDark ? "light" : "dark")
      : cur === "dark" ? "light"
      : "system";
    try { localStorage.setItem(KEY, next); } catch {}
    apply();
  }
  function init() {
    btn = $("#themeToggle");
    if (btn) btn.addEventListener("click", cycle);
    // Live-update when the OS theme changes AND the user is following "system".
    if (mql) {
      const onChange = () => { if (pref() === "system") apply(); };
      if (mql.addEventListener) mql.addEventListener("change", onChange);
      else if (mql.addListener) mql.addListener(onChange); // older Safari
    }
    apply();
  }
  return { init };
})();
const fmtBytes = (b) => b < 1024 ? b + " B" : b < 1048576 ? (b / 1024).toFixed(0) + " KB" : (b / 1048576).toFixed(1) + " MB";
const safeName = (s) => (s || "document").replace(/\.pdf$/i, "").replace(/[^\w.-]+/g, "-").slice(0, 60);
const bytesToBase64 = (bytes) => { let bin = ""; const chunk = 0x8000; for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk)); return btoa(bin); };
// In the Capacitor native app, <a download> doesn't trigger a save (no browser
// downloads UI exists in a WKWebView/native WebView) — write to the app's cache
// then hand off through the native share sheet instead. Plain web is untouched.
async function download(bytes, filename, type = "application/pdf") {
  if (window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()) {
    // Directory is a plain JS enum exported from the @capacitor/filesystem
    // *package* (not a "plugin"), so it's never present on
    // window.Capacitor.Plugins in this no-bundler, plain-<script>-tag app —
    // destructuring it from there silently yields undefined, and
    // `directory: undefined.Cache` throws. "CACHE" is that enum's actual
    // underlying string value (confirmed against the vendored package),
    // used directly instead of a reference that doesn't exist here.
    const { Filesystem } = window.Capacitor.Plugins;
    const { Share } = window.Capacitor.Plugins;
    const { uri } = await Filesystem.writeFile({ path: filename, data: bytesToBase64(bytes), directory: "CACHE" });
    await Share.share({ title: filename, files: [uri] });
    return;
  }
  // Safari (desktop and iOS) treats a blob: URL typed as a viewable format
  // (application/pdf, image/*) as content to display and opens its own
  // viewer instead of honoring the <a download> attribute below, so the
  // file never actually reaches Downloads. "application/octet-stream" has
  // no built-in viewer, so every browser treats it as an opaque file and
  // saves it instead — the filename's extension is what makes it open
  // correctly afterward. `type` is intentionally unused here now.
  const blob = new Blob([bytes], { type: "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const a = el("a"); a.href = url; a.download = filename; document.body.appendChild(a); a.click();
  document.body.removeChild(a); setTimeout(() => URL.revokeObjectURL(url), 4000);
}
// Pro feature: bundle several output files into one .zip instead of triggering
// N sequential downloads. Returns the zip's byte length so callers can report size.
async function downloadAsZip(files, zipName) {
  const zip = new JSZip();
  files.forEach((f) => zip.file(f.name, f.bytes));
  const blob = await zip.generateAsync({ type: "blob" });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  await download(bytes, zipName, "application/zip");
  return bytes.length;
}
// Local PDF has no single "rebuild the whole UI" function (the hub/workspace tools render
// themselves once and gate Pro features inline) — after a Pro-status change the closest
// equivalent is: reveal the footer license-card link (once a code exists), relabel any
// visible "(Pro)" gated buttons so owners never see the upsell wording again, and drop the
// self-heal nag if it's now satisfied. Open tool panels also re-check Billing.isPro() the
// next time their own gated button is clicked, so this is belt-and-suspenders.
function refreshAfterProChange() {
  try {
    const code = safeBilling(() => Billing.getRestoreCode(), null);
    const isPro = safeBilling(() => Billing.isPro(), false);
    // The footer license-card link is an OWNER surface: reveal it whenever a
    // usable code exists AND Pro is active; hide it again on a verified
    // revocation (Pro off) so a stopped-access user isn't offered a stale card.
    const link = $("#footerLicenseLink");
    if (link) {
      if (code && isPro) { link.classList.remove("hidden"); link.onclick = () => showLicenseCardModal(); }
      else { link.classList.add("hidden"); }
    }
    // Relabel any on-screen Pro-gated buttons so owners never see "(Pro)" again.
    if (isPro) {
      document.querySelectorAll(".js-pro-gated").forEach((b) => {
        if (b.textContent) b.textContent = b.textContent.replace(/\s*\(Pro\)\s*$/i, "");
      });
    }
    // On a verified revocation (no longer Pro), drop any lingering owner nags so a
    // stopped-access user isn't nagged to save/mint a code they can no longer use.
    if (!isPro) {
      const heal = $("#proHealBanner"); if (heal) heal.remove();
      const save = $("#saveNagBanner"); if (save) save.remove();
    }
    // If self-heal is now satisfied (Pro + code), remove its banner.
    if (code) { const b = $("#proHealBanner"); if (b) b.remove(); }
    // Show the self-heal nag if we're Pro on this browser but have no code yet.
    maybeShowSelfHealNag();
    // Keep the quiet topbar "Unlock Pro" front door in sync: owners never see it.
    syncUnlockProAffordance();
  } catch {}
}

// The topbar "Unlock Pro" button is a plain, low-pressure entry point to the
// EXISTING paywall (showProModal). It must never appear to an owner, so it stays
// hidden whenever Billing.isPro() is true and is re-evaluated after any Pro-status
// change (boot check, purchase, restore, revocation) via refreshAfterProChange().
// If the billing check throws, we treat the visitor as NOT Pro (show the card).
function syncUnlockProAffordance() {
  const btn = $("#unlockProBtn");
  if (!btn) return;
  const isPro = safeBilling(() => Billing.isPro(), false);
  btn.classList.toggle("hidden", !!isPro);
}

// ── Billing call safety: every Billing.* call is wrapped so a throw inside the
//    billing lib degrades gracefully (the UI never hard-crashes on a billing error). ──
function safeBilling(fn, fallback) { try { return fn(); } catch { return fallback; } }
async function safeBillingAsync(fn, fallback) { try { return await fn(); } catch { return fallback; } }

// ── Pending gated intent (resume-the-action after unlock/restore) ───────────
// When a gate opens the paywall, the tool stashes the exact action the user was
// trying to run (a zero-arg closure). After a successful unlock OR restore we run
// it once, then clear it — so the user lands back on their download instead of
// hunting for the button. Stored as a closure; guarded so it only ever runs once.
let pendingIntent = null;
function setPendingIntent(fn) { pendingIntent = (typeof fn === "function") ? fn : null; }
function clearPendingIntent() { pendingIntent = null; }
function runPendingIntent() {
  const fn = pendingIntent;
  pendingIntent = null; // clear BEFORE running so a re-entrant gate can't double-fire it
  if (fn) { try { fn(); } catch {} }
}

// Shared gate for a single Pro-gated button (the per-file ZIP buttons): show a
// busy "Checking…" state while the entitlement check runs, guard double-clicks,
// and on a miss stash `action` as the pending intent (so it auto-runs after
// unlock/restore) before opening the paywall. On a hit, run `action` now.
async function gateProAction(btn, restoreLabel, action) {
  if (btn.disabled) return;                        // guard double-click while checking
  if (safeBilling(() => Billing.isPro(), false)) { markWasPro(); action(); return; }
  btn.disabled = true; const prev = btn.textContent; btn.textContent = "Checking…";
  const pro = await safeBillingAsync(() => Billing.refreshProStatus(), false);
  btn.disabled = false; btn.textContent = restoreLabel || prev;
  if (pro) { markWasPro(); action(); return; }
  // Verified not-Pro after a real refresh: reconcile access (handles the kind
  // revocation notice + reset if this browser previously owned Pro), then paywall.
  reconcileProAccess();
  setPendingIntent(action);
  showProModal();
}

// ── Celebration / ownership moment (once per lifetime) ──────────────────────
const CELEBRATED_KEY = "localpdf.celebrated";
function hasCelebrated() { try { return localStorage.getItem(CELEBRATED_KEY) === "1"; } catch { return false; } }
function markCelebrated() { try { localStorage.setItem(CELEBRATED_KEY, "1"); } catch {} }

// ── Refund request (customer-initiated, request-only) ───────────────────────
// A refund is money movement, so the app NEVER executes it — this only makes
// ASKING effortless. It opens the user's own mail client (mailto:) with a warm,
// pre-filled note to support, including their restore code so a human (Eden /
// support) can find the purchase and process it manually.
const SUPPORT_EMAIL = "support@localpdfapp.com";
// True only inside the Capacitor iOS/Android shell. On iOS, Pro is bought via Apple
// In-App Purchase (Guideline 3.1.1) — so the paywall/success/restore UI must NOT reference
// Stripe checkout, email receipts, "your statement", or the web-only restore-CODE mechanism.
// Every use is `if (IS_NATIVE) {…} else {…exact existing web copy…}` so the live web build is
// byte-for-byte unchanged.
const IS_NATIVE = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
// iOS is an app, not a browser — rewrite the web-only "in your browser" hero + footer copy on
// native so it reads as an app (and never trips Apple's "repackaged website" review, Guideline 4.2).
// The live web build never enters this branch, so its copy is byte-for-byte unchanged.
if (IS_NATIVE) {
  const applyNativeCopy = () => {
    const acc = document.querySelector("#hub .hero h1 .accent");
    if (acc && /in your browser/i.test(acc.textContent)) acc.textContent = "100% on your device";
    const ft = document.querySelector("footer");
    if (ft && /in-browser/i.test(ft.innerHTML)) ft.innerHTML = ft.innerHTML.replace(/a private, in-browser PDF toolbox/i, "a private, on-device PDF toolbox");
    // The web trust band says "Works Offline … once loaded" because the web OCR engine is a
    // one-time download. On iOS the engine ships inside the app, so the full claim is true.
    const tb = Array.from(document.querySelectorAll(".trust-band .trust-text b")).find(b => /works offline/i.test(b.textContent));
    if (tb) {
      tb.textContent = "100% Offline";
      const sp = tb.nextElementSibling;
      if (sp && sp.tagName === "SPAN") sp.textContent = "No internet required — everything runs on your device.";
    }
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", applyNativeCopy);
  else applyNativeCopy();
}
const REFUND_EXPECTATION = "30-day money-back guarantee. Email us and a real person reviews it — no forms, no runaround. Once approved, your refund goes back to your original payment method and takes about 5–10 business days to appear on your statement.";
function buildRefundMailto() {
  const code = safeBilling(() => Billing.getRestoreCode(), null) || "(no code on this device)";
  const subject = "Refund request — Local PDF Pro";
  const body =
    "Hi Local PDF team,\n\n" +
    "I'd like to request a refund for my Local PDF Pro purchase.\n\n" +
    "My restore code: " + code + "\n" +
    "Reason (optional): \n\n" +
    "Thanks — I understand a real person will review this and reply.\n";
  return "mailto:" + SUPPORT_EMAIL +
    "?subject=" + encodeURIComponent(subject) +
    "&body=" + encodeURIComponent(body);
}
// Quiet, guilt-free "Need a refund?" block reused inside the license-card modal.
// One calm expectation line + one mailto button. No "are you sure?", no gauntlet.
function refundBlock() {
  const wrap = el("div", "refund-block");
  wrap.appendChild(txt("h4", "refund-head", "Need a refund?"));
  wrap.appendChild(txt("p", "hint refund-line", REFUND_EXPECTATION));
  const btn = txt("a", "btn ghost sm refund-btn", "Request a refund");
  btn.href = buildRefundMailto();
  wrap.appendChild(btn);
  return wrap;
}

// ── Pro access-stop tracking (was_pro) ──────────────────────────────────────
// "localpdf.was_pro" = "1" records that a VERIFIED Pro state was seen on this
// browser. It's the anchor for detecting a real, server-verified revocation
// (refund/expiry) later. Because Billing.refreshProStatus() fails OPEN offline
// for known owners, isPro() only flips to false after a genuine "not active"
// server answer — so a false reading while was_pro==="1" is a real revocation,
// never a network blip.
const WAS_PRO_KEY = "localpdf.was_pro";
function markWasPro() { try { localStorage.setItem(WAS_PRO_KEY, "1"); } catch {} }
function wasPro() { try { return localStorage.getItem(WAS_PRO_KEY) === "1"; } catch { return false; } }
function clearWasPro() { try { localStorage.setItem(WAS_PRO_KEY, "0"); } catch {} }

// Call after ANY entitlement refresh (boot + gate checks). If Pro is now truly
// gone but was previously owned here, this is a verified revocation → run the
// one-time kind notice + reset flags + re-lock gated surfaces. Otherwise, if Pro
// is currently active, remember it. NON-DESTRUCTIVE: never touches user content.
function reconcileProAccess() {
  const isPro = safeBilling(() => Billing.isPro(), false);
  if (isPro) { markWasPro(); return; }
  // Not Pro right now. Only treat as revocation if we had previously confirmed
  // ownership on this browser (was_pro==="1"). A never-Pro visitor is untouched.
  if (!wasPro()) return;
  clearWasPro();                     // 2. so the notice never repeats
  try { localStorage.removeItem(CELEBRATED_KEY); } catch {} // 3. celebration fires fresh if they rebuy
  showAccessEndedNotice();           // 1. one-time calm, dismissible notice
  refreshAfterProChange();           // 4. re-lock gated buttons; hide license link / self-heal nag
}

// One-time calm, dismissible notice shown after a verified revocation. Reassures
// that everything they made is safe and free features keep working. No guilt, no
// hard re-sell. Reuses the app's banner slot styling (.save-nag), like other nags.
function showAccessEndedNotice() {
  if ($("#accessEndedBanner")) return;
  const bar = el("div", "save-nag access-ended-nag"); bar.id = "accessEndedBanner";
  bar.setAttribute("role", "status");
  // Says WHY (a verified revocation is, in practice, a refund) and gives an in-banner
  // escape hatch, so a surprised owner isn't left guessing with no path to a human.
  bar.appendChild(txt("span", null, "Your Local PDF Pro access has ended — this usually follows a refund. If it's unexpected, email support@localpdfapp.com and we'll sort it out. Everything you made is safe and still here, and every free feature keeps working — you're always welcome back."));
  const x = txt("button", "save-nag-x", "×"); x.type = "button"; x.setAttribute("aria-label", "Dismiss");
  x.onclick = () => bar.remove();
  bar.append(x);
  document.body.insertBefore(bar, document.body.firstChild);
  // Same scroll-reveal dance as the other top-of-body banners.
  window.scrollTo({ top: 0 });
  requestAnimationFrame(() => window.scrollTo({ top: 0 }));
}

// Gentle, dependency-free confetti built with DOM + CSS (strict CSP, no libs).
// Respects prefers-reduced-motion: when reduced, it does nothing (the warm
// message alone carries the moment). Self-cleans after the animation.
function fireConfetti() {
  try {
    if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const layer = el("div", "confetti-layer"); layer.setAttribute("aria-hidden", "true");
    const colors = ["#e11d48", "#fb7185", "#fda4af", "#0f766e", "#fbbf24", "#fecdd3"];
    const N = 70;
    for (let i = 0; i < N; i++) {
      const p = el("div", "confetti-piece");
      const left = Math.random() * 100;
      const delay = Math.random() * 0.5;
      const dur = 2.4 + Math.random() * 1.6;
      const size = 6 + Math.random() * 6;
      const drift = (Math.random() * 2 - 1) * 60;
      p.style.left = left + "%";
      p.style.width = size + "px";
      p.style.height = (size * 0.6) + "px";
      p.style.background = colors[i % colors.length];
      p.style.animationDelay = delay + "s";
      p.style.animationDuration = dur + "s";
      p.style.setProperty("--drift", drift + "px");
      p.style.transform = "rotate(" + Math.floor(Math.random() * 360) + "deg)";
      layer.appendChild(p);
    }
    document.body.appendChild(layer);
    setTimeout(() => { layer.remove(); }, 4600);
  } catch {}
}

// The warm one-time ownership moment. Shows a headline, thank-you, a short list of
// what Pro just unlocked, then the existing save-your-code / license-card section.
// Fired only on the FIRST successful unlock (guarded by localpdf.celebrated) — never
// on later visits and never on restores. `code` may be null (mint failed); in that
// case the amber "create your restore code" flow (item 2) is shown instead of the box.
function showCelebrationModal(code) {
  markCelebrated();
  fireConfetti();
  const backdrop = el("div", "modal-backdrop");
  const modal = el("div", "modal pro-modal license-modal celebrate-modal");
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-modal", "true");
  modal.setAttribute("aria-labelledby", "celebrateTitle");
  const h = txt("h3", null, "It's yours — forever."); h.id = "celebrateTitle";
  modal.appendChild(h);
  modal.appendChild(txt("p", "hint", IS_NATIVE
    ? "Thank you for supporting Local PDF — Pro is unlocked on this device and it's yours to keep."
    : "Thank you for supporting Local PDF — Pro is unlocked on this browser and it's yours to keep."));
  const list = el("ul", "pro-features celebrate-unlocked");
  // Matches the paywall exactly. No "batch split" — batch is compress/convert only.
  // The ZIP bullet's "Split" is the legit single-file per-page "Download all as ZIP".
  [
    "Advanced compress — Light or Maximum levels to squeeze PDFs as small as they'll go",
    "Batch-process a whole folder — compress or convert dozens of PDFs at once, back in one ZIP",
    "“Download all as one ZIP” in Split and PDF → Images",
  ].forEach((f) => list.appendChild(txt("li", null, f)));
  modal.appendChild(txt("p", "hint celebrate-sub", "What you just unlocked:"));
  modal.appendChild(list);
  announce("Pro unlocked — it's yours forever.", "ok");

  const msgHost = el("div", "pro-msg");
  const codeSection = el("div", "celebrate-code-section");
  modal.appendChild(codeSection);

  if (code) {
    codeSection.appendChild(txt("h4", "celebrate-code-head", "Save your restore code"));
    codeSection.appendChild(txt("p", "hint", "Local PDF has no accounts, so this code is how you unlock Pro in another browser. Save it somewhere safe — photos, a password manager, or the license card below. (The iPhone and iPad app sells Pro separately through the App Store.)"));
    // The code on screen comes from memory (the purchase result), so it shows even when this
    // browser can't persist it — in that case it truly won't be here next visit: say so once.
    if (!storageProbeOk()) codeSection.appendChild(txt("p", "hint", "This browser isn't saving data, so this code won't be here on your next visit — copy or save it now."));
    const codeBox = el("div", "restore-code-box");
    codeBox.appendChild(txt("code", "restore-code-value", code));
    const copyBtn = txt("button", "btn ghost sm", "Copy"); copyBtn.type = "button";
    copyBtn.onclick = async () => {
      try { await navigator.clipboard.writeText(code); copyBtn.textContent = "Copied!"; }
      catch { copyBtn.textContent = "Couldn't copy — select and copy manually"; }
      setTimeout(() => { copyBtn.textContent = "Copy"; }, 2000);
    };
    codeBox.appendChild(copyBtn);
    codeSection.appendChild(codeBox);
    codeSection.appendChild(licenseCardBlock(code));
  } else if (IS_NATIVE) {
    // Apple IAP mints no restore CODE — cross-device restore is handled by the Apple ID +
    // "Restore Purchases", so skip the mint section entirely and show a clean success.
    codeSection.appendChild(txt("p", "hint", "Pro is unlocked on this device — and it restores free on your other Apple devices. Just tap “Restore Purchases” there, signed in with the same Apple Account."));
  } else {
    renderAmberMintFlow(codeSection);
  }

  const doneBtn = txt("button", "btn big", code ? "I've saved it" : "Done"); doneBtn.type = "button";
  doneBtn.onclick = () => { if (code) markCodeAcked(); backdrop.remove(); refreshAfterProChange(); };
  const actions = el("div", "pro-actions"); actions.append(doneBtn);
  modal.append(actions, msgHost);
  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);
  focusTrap(backdrop, modal, doneBtn, { escCloses: false });
}

// Amber, honest "we couldn't mint your code" flow — offered inside the celebration
// (or the plain post-purchase modal) when purchasePro() returns ok+restoreCode:null.
// Pro already works on this browser; this only creates the cross-device code.
function renderAmberMintFlow(host) {
  host.innerHTML = "";
  const note = el("div", "amber-note");
  note.appendChild(txt("p", null, "One thing — we couldn't create your restore code just now. Pro already works on this browser. Tap to create your code for other browsers."));
  const mintBtn = txt("button", "btn", "Create my restore code"); mintBtn.type = "button";
  mintBtn.onclick = async () => {
    mintBtn.disabled = true; mintBtn.textContent = "Creating…";
    const res = await safeBillingAsync(() => Billing.mintRestoreCode(), { ok: false, restoreCode: null });
    if (res && res.ok && res.restoreCode) {
      // Success — replace the amber flow with the normal save-code section in place.
      host.innerHTML = "";
      host.appendChild(txt("h4", "celebrate-code-head", "Save your restore code"));
      host.appendChild(txt("p", "hint", "This is how you unlock Pro in another browser. Save it somewhere safe."));
      const codeBox = el("div", "restore-code-box");
      codeBox.appendChild(txt("code", "restore-code-value", res.restoreCode));
      const copyBtn = txt("button", "btn ghost sm", "Copy"); copyBtn.type = "button";
      copyBtn.onclick = async () => {
        try { await navigator.clipboard.writeText(res.restoreCode); copyBtn.textContent = "Copied!"; }
        catch { copyBtn.textContent = "Couldn't copy — select and copy manually"; }
        setTimeout(() => { copyBtn.textContent = "Copy"; }, 2000);
      };
      codeBox.appendChild(copyBtn);
      host.appendChild(codeBox);
      host.appendChild(licenseCardBlock(res.restoreCode));
      refreshAfterProChange();
    } else {
      note.replaceChildren(txt("p", null, "No luck yet — Pro still works here; we'll offer again next visit, and support@localpdfapp.com + your receipt always work."));
    }
  };
  note.appendChild(mintBtn);
  host.appendChild(note);
}

// ── Self-heal nag (Pro on this browser, but no restore code yet) ────────────
// A slim banner offering to mint the cross-device code. Distinct from the
// save-your-card nag (#saveNagBanner), which nags to SAVE an existing code.
function maybeShowSelfHealNag() {
  if (IS_NATIVE) return; // iOS mints no restore code — cross-device restore is via the Apple ID
  if ($("#proHealBanner")) return;
  const isPro = safeBilling(() => Billing.isPro(), false);
  const code = safeBilling(() => Billing.getRestoreCode(), null);
  if (!isPro || code) return;
  const bar = el("div", "save-nag"); bar.id = "proHealBanner";
  bar.appendChild(txt("span", null, "You're Pro on this browser — create your restore code so you can unlock other browsers too."));
  const make = txt("button", "save-nag-view", "Create code"); make.type = "button";
  make.onclick = async () => {
    make.disabled = true; make.textContent = "Creating…";
    const res = await safeBillingAsync(() => Billing.mintRestoreCode(), { ok: false, restoreCode: null });
    if (res && res.ok && res.restoreCode) {
      bar.remove();
      showRestoreCodeModal(res.restoreCode); // normal save-code modal
      refreshAfterProChange();
    } else {
      make.disabled = false; make.textContent = "Create code";
    }
  };
  const x = txt("button", "save-nag-x", "×"); x.type = "button"; x.setAttribute("aria-label", "Dismiss for now");
  x.onclick = () => bar.remove();
  bar.append(make, x);
  document.body.insertBefore(bar, document.body.firstChild);
  window.scrollTo({ top: 0 });
  requestAnimationFrame(() => window.scrollTo({ top: 0 }));
}

// ── Modal focus management (a11y): move focus in, trap Tab, optional Esc-close ──
function focusTrap(backdrop, modal, initialFocus, opts) {
  const options = opts || {};
  const focusablesSel = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  const prevFocus = document.activeElement;
  const focusFirst = () => {
    const target = initialFocus && typeof initialFocus.focus === "function"
      ? initialFocus
      : modal.querySelector(focusablesSel);
    if (target) try { target.focus(); } catch {}
  };
  // Focus now (the modal is already in the DOM) AND again on the next frame — the
  // immediate call works even when rAF is throttled (backgrounded tab), while the
  // rAF retry catches layout that isn't ready on the same tick.
  focusFirst();
  requestAnimationFrame(focusFirst);
  const onKey = (e) => {
    if (e.key === "Escape" && options.escCloses) { e.preventDefault(); teardown(); backdrop.remove(); return; }
    if (e.key !== "Tab") return;
    const nodes = [...modal.querySelectorAll(focusablesSel)].filter((n) => n.offsetParent !== null || n === document.activeElement);
    if (!nodes.length) return;
    const first = nodes[0], last = nodes[nodes.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };
  document.addEventListener("keydown", onKey, true);
  function teardown() {
    document.removeEventListener("keydown", onKey, true);
    if (prevFocus && typeof prevFocus.focus === "function") { try { prevFocus.focus(); } catch {} }
  }
  // Tear down when the backdrop leaves the DOM (removed by any close path).
  const mo = new MutationObserver(() => {
    if (!document.body.contains(backdrop)) { teardown(); mo.disconnect(); }
  });
  mo.observe(document.body, { childList: true });
  return teardown;
}

// ── Pro license card (loss-proofing the restore code) ──────────────
// The restore code is the ONLY key to a Pro purchase (no accounts), so beyond the
// post-purchase modal the code is also offered as a downloadable PNG "license card"
// (rendered by Billing.renderLicenseCard — code + QR + warning). "localpdf.code_ack"
// records that the user explicitly said "I've saved it"; until then a slim banner
// nags at boot.
const CODE_ACK_KEY = "localpdf.code_ack";
function isCodeAcked() { try { return localStorage.getItem(CODE_ACK_KEY) === "1"; } catch { return true; } }
function markCodeAcked() {
  try { localStorage.setItem(CODE_ACK_KEY, "1"); } catch {}
  const banner = $("#saveNagBanner"); if (banner) banner.remove();
}

// Card canvas + "Download card (PNG)" button — shared by the post-purchase modal
// and the standalone license-card modal.
function licenseCardBlock(code) {
  const wrap = el("div", "license-card-wrap");
  const canvas = safeBilling(() => Billing.renderLicenseCard(code, "Local PDF"), null);
  if (!canvas) {
    // Degrade gracefully if the card renderer throws — the code is still shown
    // elsewhere in the modal; just note the card image couldn't be drawn.
    wrap.appendChild(txt("p", "hint", "Couldn't draw the license-card image here — your restore code above is all you need to restore Pro."));
    return wrap;
  }
  canvas.className = "license-card-canvas";
  wrap.appendChild(canvas);
  const dl = txt("button", "btn ghost sm", "Download card (PNG)"); dl.type = "button";
  dl.onclick = () => {
    canvas.toBlob(async (blob) => {
      if (!blob) return;
      // Reuse download() so the Capacitor native share-sheet path keeps working.
      await download(new Uint8Array(await blob.arrayBuffer()), "local-pdf-pro-license.png", "image/png");
    }, "image/png");
  };
  wrap.appendChild(dl);
  return wrap;
}

function showLicenseCardModal() {
  const code = safeBilling(() => Billing.getRestoreCode(), null);
  if (!code) { showRestoreEntryModal(); return; } // nothing to show — offer restore instead
  const backdrop = el("div", "modal-backdrop");
  const modal = el("div", "modal pro-modal license-modal");
  modal.setAttribute("role", "dialog"); modal.setAttribute("aria-modal", "true");
  modal.setAttribute("aria-labelledby", "licenseCardTitle");
  const _h = txt("h3", null, "Your Pro license card"); _h.id = "licenseCardTitle";
  modal.appendChild(_h);
  modal.appendChild(txt("p", "hint", IS_NATIVE
    ? "Save this card somewhere safe — photos, a password manager, or print it. It's your key to restoring Pro in any browser. Keep your App Store receipt email too as proof of purchase. Questions? support@localpdfapp.com."
    : "Save this card somewhere safe — photos, a password manager, or print it. It's your key to restoring Pro in any browser. Keep your receipt email too as proof of purchase. Questions? support@localpdfapp.com."));
  modal.appendChild(licenseCardBlock(code));
  if (!IS_NATIVE) modal.appendChild(refundBlock()); // quiet, guilt-free "Need a refund?" entry (owner surface). Web only — Apple owns IAP refunds (Report a Problem).
  const msgHost = el("div", "pro-msg");
  const savedBtn = txt("button", "btn big", "I've saved it"); savedBtn.type = "button";
  savedBtn.onclick = () => { markCodeAcked(); backdrop.remove(); };
  const copyBtn = txt("button", "btn ghost", "Copy code"); copyBtn.type = "button";
  copyBtn.onclick = async () => {
    try { await navigator.clipboard.writeText(code); copyBtn.textContent = "Copied!"; }
    catch { copyBtn.textContent = "Couldn't copy"; }
    setTimeout(() => { copyBtn.textContent = "Copy code"; }, 2000);
  };
  const actions = el("div", "pro-actions"); actions.append(savedBtn, copyBtn);
  modal.append(actions, msgHost);
  backdrop.appendChild(modal);
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) backdrop.remove(); });
  document.body.appendChild(backdrop);
  focusTrap(backdrop, modal, savedBtn, { escCloses: true }); // viewer — Esc may close
}

// Slim top-of-page reminder shown at boot until the code is acked. The × only hides
// it for this page load; "I've saved it" in the modal silences it permanently.
function showSaveNagBanner() {
  if (IS_NATIVE) return; // iOS has no restore CODE / license card to save — Apple restore covers cross-device
  if ($("#saveNagBanner")) return;
  const bar = el("div", "save-nag"); bar.id = "saveNagBanner";
  bar.appendChild(txt("span", null, "Keep your Pro safe — save your license card so you can restore it anytime."));
  const view = txt("button", "save-nag-view", "View card"); view.type = "button";
  view.onclick = () => showLicenseCardModal();
  const x = txt("button", "save-nag-x", "×"); x.type = "button"; x.setAttribute("aria-label", "Dismiss for now");
  x.onclick = () => bar.remove();
  bar.append(view, x);
  document.body.insertBefore(bar, document.body.firstChild);
  // Inserting a full-width bar at the very top of <body> after layout makes the
  // browser preserve the content's visual anchor — it silently scrolls the page
  // down by the bar's height, leaving the banner parked above the fold (top: -h)
  // behind the sticky topbar, so it never actually shows. The browser applies that
  // anchor adjustment on the next layout, so we scroll back to the top both now and
  // again on the next frame (after the adjustment lands) to reliably reveal it.
  window.scrollTo({ top: 0 });
  requestAnimationFrame(() => window.scrollTo({ top: 0 }));
}

function showRestoreCodeModal(code) {
  const backdrop = el("div", "modal-backdrop");
  const modal = el("div", "modal pro-modal license-modal");
  modal.setAttribute("role", "dialog"); modal.setAttribute("aria-modal", "true");
  modal.setAttribute("aria-labelledby", "saveCodeTitle");
  const _h = txt("h3", null, "You're Pro — save your restore code"); _h.id = "saveCodeTitle";
  modal.appendChild(_h);
  modal.appendChild(txt("p", "hint", "You're all set. Local PDF has no accounts, so this code is how you unlock Pro again in another browser — save it somewhere safe (photos, a password manager, or the license card below) and you're covered. (The iPhone and iPad app sells Pro separately through the App Store.)"));
  modal.appendChild(txt("p", "hint", "Keep your receipt email too — it's your proof of purchase. Questions? support@localpdfapp.com."));
  // The code on screen comes from memory (the purchase result), so it shows even when this
  // browser can't persist it — in that case it truly won't be here next visit: say so once.
  if (!storageProbeOk()) modal.appendChild(txt("p", "hint", "This browser isn't saving data, so this code won't be here on your next visit — copy or save it now."));
  const codeBox = el("div", "restore-code-box");
  const codeText = txt("code", "restore-code-value", code || "—");
  codeBox.appendChild(codeText);
  const copyBtn = txt("button", "btn ghost sm", "Copy"); copyBtn.type = "button";
  copyBtn.onclick = async () => {
    try { await navigator.clipboard.writeText(code); copyBtn.textContent = "Copied!"; }
    catch { copyBtn.textContent = "Couldn't copy — select and copy manually"; }
    setTimeout(() => { copyBtn.textContent = "Copy"; }, 2000);
  };
  codeBox.appendChild(copyBtn);
  modal.appendChild(codeBox);
  if (code) modal.appendChild(licenseCardBlock(code)); // downloadable card, same code
  const doneBtn = txt("button", "btn big", "I've saved it"); doneBtn.type = "button";
  doneBtn.onclick = () => { if (code) markCodeAcked(); backdrop.remove(); refreshAfterProChange(); };
  const actions = el("div", "pro-actions"); actions.append(doneBtn);
  modal.appendChild(actions);
  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);
  // A11y: focus into the modal + Tab trap. Escape does NOT close the code-save
  // modal (losing the code is worse than a stuck modal — the user must choose
  // "I've saved it"), per the paywall-vs-code-save distinction.
  focusTrap(backdrop, modal, doneBtn, { escCloses: false });
}

// Normalize a restore-code string as the user types/pastes: uppercase, strip any
// non-alphabet chars, then regroup as LPDF-XXXX-XXXX-XXXX. Billing normalizes on
// its side too (trim + uppercase); this just keeps the field visually correct.
// The alphabet mirrors billing.src.js's CODE_ALPHABET (no 0/O/1/I/L).
function formatRestoreCodeInput(raw) {
  // Leave a pasted raw account id ($RCAnonymousID:… or a legacy custom id — the Fix C fallback
  // restore code) untouched; those are case-sensitive and always carry a "_" or "$" marker
  // that a real minted code never has. The ":" of a "Code: LPDF-…" label paste is NOT such a
  // marker, so it's kept OUT of this guard — that lets a labeled paste get normalized instead
  // of slipping through raw.
  if (/[_$]/.test(String(raw || ""))) return String(raw || "").trim();
  let up = String(raw || "").toUpperCase();
  // A valid code body can NEVER contain "LPDF" (the L isn't in the code alphabet), so any
  // "LPDF" is a prefix marker — take everything after the LAST one. This peels a leading label
  // like "Code: LPDF-…" AND a doubled "LPDF-LPDF-…", where a single ^LPDF strip would leak the
  // stray P/D/F into the body.
  const pi = up.lastIndexOf("LPDF");
  if (pi >= 0) up = up.slice(pi + 4);
  // Keep only body chars (the alphabet), dropping the dashes + junk.
  const body = up.replace(/[^23456789ABCDEFGHJKMNPQRSTUVWXYZ]/g, "").slice(0, 12);
  let out = "LPDF-";
  for (let i = 0; i < body.length; i++) {
    out += body[i];
    if (i % 4 === 3 && i !== 11 && i !== body.length - 1) out += "-";
  }
  return out;
}

function showRestoreEntryModal() {
  const backdrop = el("div", "modal-backdrop");
  const modal = el("div", "modal pro-modal");
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-modal", "true");
  modal.setAttribute("aria-labelledby", "restoreTitle");
  const h = txt("h3", null, "Restore Pro"); h.id = "restoreTitle";
  modal.appendChild(h);
  modal.appendChild(txt("p", "hint", "Enter the restore code you saved when you unlocked Pro."));
  const input = document.createElement("input");
  input.type = "text"; input.placeholder = "LPDF-XXXX-XXXX-XXXX"; input.className = "restore-code-input";
  input.autocapitalize = "characters"; input.autocomplete = "off"; input.spellcheck = false; input.setAttribute("aria-label", "Restore code");
  // Uppercase as they type, but do NOT re-format destructively: the old auto
  // "LPDF-" prefix created a feedback loop that absorbed a manually-typed prefix's
  // P/D/F into the code body (owner typing their full code got locked out). Keep
  // the raw value (the "L" prefix marker intact) and normalize once, at submit.
  input.addEventListener("input", () => {
    // A pasted raw account id ($RCAnonymousID:… or a legacy custom id) is
    // case-sensitive — leave it exactly as pasted; the markers never appear in
    // a real minted code.
    if (/[_$]/.test(input.value)) return;
    const pos = input.selectionStart;
    const up = input.value.toUpperCase();
    if (up !== input.value) { input.value = up; try { input.setSelectionRange(pos, pos); } catch (e) { /* ignore */ } }
  });
  modal.appendChild(input);
  // Lost-code escape hatch INSIDE the entry modal — the answer previously lived only on
  // the Help page, which this modal never pointed at.
  modal.appendChild(txt("p", "hint", "Lost your code? Email support@localpdfapp.com and we'll help."));
  const msgHost = el("div", "pro-msg");
  const goBtn = txt("button", "btn big", "Restore"); goBtn.type = "button";
  const doRestore = async () => {
    goBtn.disabled = true; goBtn.textContent = "Checking…";
    // Normalize once here (raw value still has the "L" prefix marker intact), so a
    // typed full "LPDF-…" code is grouped correctly instead of leaking P/D/F into the body.
    const res = await safeBillingAsync(() => Billing.restoreWithCode(formatRestoreCodeInput(input.value)), { ok: false, error: "Couldn't restore — try again." });
    if (res && res.ok) {
      backdrop.remove();
      // Restore is NOT a first-purchase celebration — announce "Welcome back",
      // reveal the license link, and resume any pending gated intent.
      onProUnlocked({ announceRestore: true });
    } else {
      goBtn.disabled = false; goBtn.textContent = "Restore";
      const msg = res && res.offline
        ? "You're offline — restoring Pro needs a connection to verify your code. Everything else works offline."
        : (res && res.error) || "Couldn't restore — try again.";
      status(msgHost, msg, "err");
    }
  };
  goBtn.onclick = doRestore;
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); if (!goBtn.disabled) doRestore(); } });
  const closeBtn = txt("button", "btn ghost", "Cancel"); closeBtn.type = "button";
  closeBtn.onclick = () => backdrop.remove();
  const actions = el("div", "pro-actions"); actions.append(goBtn, closeBtn);
  modal.append(actions, msgHost);
  backdrop.appendChild(modal);
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) backdrop.remove(); });
  document.body.appendChild(backdrop);
  focusTrap(backdrop, modal, input, { escCloses: true });
}

// Shared "Pro just became active" handler for BOTH restore and (non-celebration)
// unlock paths. Announces success, reveals the license link, relabels gated
// buttons, shows the self-heal nag if needed, and resumes any pending gated intent.
function onProUnlocked(opts) {
  const options = opts || {};
  // A successful unlock/restore means Pro is verified-active here — anchor was_pro
  // so a later verified revocation (refund) is detectable, and clear any stale
  // access-ended notice from a prior cycle.
  if (safeBilling(() => Billing.isPro(), false)) markWasPro();
  const ended = $("#accessEndedBanner"); if (ended) ended.remove();
  refreshAfterProChange();
  if (options.announceRestore !== false) {
    showToast("Welcome back — Pro is unlocked on this device.");
    announce("Welcome back — Pro is unlocked on this device.", "ok");
  }
  runPendingIntent();
}

// Lightweight, self-dismissing toast (bottom-center). Text via textContent only.
// Optional `ms` lets a longer message stay up long enough to actually read
// (default 3.6s is right for the usual one-liners).
let toastTimer = null;
function showToast(msg, ms) {
  let host = $("#toastHost");
  if (!host) { host = el("div"); host.id = "toastHost"; host.className = "toast-host"; document.body.appendChild(host); }
  const t = el("div", "toast"); t.setAttribute("role", "status"); t.textContent = msg;
  host.innerHTML = ""; host.appendChild(t);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.classList.add("leaving"); setTimeout(() => t.remove(), 300); }, ms || 3600);
}

// Storage probe: can this browser actually persist data right now? (Hard private-browsing /
// storage-blocked profiles silently swallow writes — a buyer there must save their restore
// code by hand, so the paywall and code modals add one gentle heads-up when this fails.)
function storageProbeOk() {
  try {
    localStorage.setItem("localpdf.storage_probe", "1");
    localStorage.removeItem("localpdf.storage_probe");
    return true;
  } catch { return false; }
}

// Guard against two paywall backdrops stacking (double-clicked gate, etc.).
let proModalOpen = false;

// `context` optionally personalizes the modal's first line with the user's real
// number, e.g. { lead: "Process all 3 files at once" } from the batch button.
// Omitting it keeps the default modal unchanged for every other call site.
function showProModal(context) {
  if (proModalOpen) return;               // never stack two paywalls
  proModalOpen = true;
  const backdrop = el("div", "modal-backdrop");
  const modal = el("div", "modal pro-modal");
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-modal", "true");
  modal.setAttribute("aria-labelledby", "proModalTitle");
  // Decorative crown/PRO badge (design5 warmth) — constant developer markup,
  // purely presentational chrome above the existing title.
  const badge = el("div", "pro-badge",
    '<svg aria-hidden="true" viewBox="0 0 24 24" fill="currentColor"><path d="M3 8.5 7.5 12 12 5l4.5 7L21 8.5 19.2 17a1.5 1.5 0 0 1-1.47 1.19H6.27A1.5 1.5 0 0 1 4.8 17z"/></svg>' +
    '<span>PRO</span>');
  badge.setAttribute("aria-hidden", "true");
  modal.appendChild(badge);
  const h = txt("h3", null, "Local PDF Pro"); h.id = "proModalTitle";
  modal.appendChild(h);
  if (context && context.lead) modal.appendChild(txt("p", "hint pro-lead", context.lead)); // SAFE: textContent
  const price = el("div", "pro-price");
  const priceAmt = txt("span", "pro-price-amt", "$9.99");     // PRICE UNCHANGED
  price.appendChild(priceAmt);
  price.appendChild(txt("span", "pro-price-note", " one-time"));
  modal.appendChild(price);
  if (IS_NATIVE) {
    // Apple bills in the buyer's storefront currency, so the paywall must show the App
    // Store's real localized price, not a hardcoded USD string (a non-US buyer would see
    // the number change on Apple's sheet). Swap it in when it arrives; "$9.99" stays as
    // the instant placeholder and the fallback on any failure. Display-only — Apple's
    // sheet always shows the true charge — and the web paywall is unchanged (the web
    // genuinely charges USD $9.99).
    safeBillingAsync(() => Billing.getNativeLocalizedPrice(), null).then((p) => {
      if (p) priceAmt.textContent = p;
    });
  }
  modal.appendChild(txt("p", "pro-plus-head", "Everything in Free, plus:"));
  const list = el("ul", "pro-features");
  // Honest, outcome-framed Pro bullets. Single-file Compress at the default level is
  // FREE now, so the compress bullet advertises only the ADVANCED controls. No
  // "batch split" — Split's only Pro touch is the per-page "Download all as ZIP",
  // which the third bullet covers.
  [
    "Advanced compress — pick Light or Maximum to control quality vs. how small the file gets.",
    "Batch-process a whole folder — compress or convert dozens of PDFs at once and get them all back in one ZIP.",
    "Download all as one ZIP in Split and PDF → Images.",
  ].forEach((f) => list.appendChild(txt("li", null, f)));
  modal.appendChild(list);
  // Durable one-time reassurance (no "subscription"/"plan"/"trial"/"per month").
  modal.appendChild(txt("p", "hint pro-durable", "One-time unlock — yours forever. No subscription, no per-file fees."));
  // Pre-frame the checkout: reassure BEFORE the buy button so the pay moment feels
  // safe. Small muted hint text, consistent with the app's .hint styling.
  if (IS_NATIVE) {
    // Apple IAP: no Stripe, no email receipt, no "your statement" (Apple bills), no self-run
    // money-back (refunds go through Apple's Report a Problem). One clean line replaces all three.
    modal.appendChild(txt("p", "hint pro-reassure", "Payment is handled securely by the App Store, with the Apple Account you already use — it restores free on your other Apple devices."));
  } else {
    // "(via RevenueCat)" matches the checkout page's own header ("Secure checkout by
    // RevenueCat"), so the buyer never meets a third brand mid-payment unannounced.
    modal.appendChild(txt("p", "hint pro-reassure", "Secure checkout by Stripe (via RevenueCat). You'll enter an email for your receipt only — it's not an account, and we never see your card."));
    {
      const stmtNote = document.createElement("p");
      stmtNote.style.cssText = "margin:12px 0 0; font-size:13.5px; font-weight:500;";
      stmtNote.innerHTML = 'Shows on your statement as <strong>“Eden Apps”</strong>';
      modal.appendChild(stmtNote);
    }
    modal.appendChild(txt("p", "hint pro-reassure", "30-day money-back guarantee — email support@localpdfapp.com."));
    // Cross-store clarity BEFORE purchase, not only after: the web unlock is for browsers,
    // and an iPhone-intending buyer should know that before paying (previously said only
    // in the post-purchase code modals and the Help page).
    modal.appendChild(txt("p", "hint pro-reassure", "The iPhone and iPad app sells Pro separately through the App Store."));
    // Storage-blocked browsers can't remember a purchase — say so BEFORE checkout (web only),
    // so the buyer knows to keep their receipt + restore code themselves.
    if (!storageProbeOk()) {
      modal.appendChild(txt("p", "hint pro-reassure", "Heads up — this browser isn't saving data, so keep your receipt and restore code somewhere safe after you buy."));
    }
  }
  const msgHost = el("div", "pro-msg");
  const close = () => { if (backdrop.parentNode) backdrop.remove(); proModalOpen = false; };
  const buyBtn = txt("button", "btn big", "Unlock Pro"); buyBtn.type = "button";
  // The purchase flow, extracted so the polished error state's "Try again" button
  // can re-run the EXACT same path (same Billing.purchasePro() call, same
  // success/cancel/offline/error branching) — no billing logic is reimplemented.
  async function runPurchase() {
    buyBtn.disabled = true; buyBtn.textContent = "Processing…"; clearInfo(msgHost);
    const res = await safeBillingAsync(() => Billing.purchasePro(), { ok: false, error: "Something went wrong finishing up." });
    if (res && res.ok) {
      close();
      // First-purchase celebration once per lifetime; afterwards fall through to the
      // plain code-save modal / self-heal so owners never re-see a big moment.
      if (!hasCelebrated()) {
        showCelebrationModal(res.restoreCode || null);
      } else if (res.restoreCode) {
        showRestoreCodeModal(res.restoreCode);
      } else {
        showPostPurchaseAmberModal();
      }
      // Resume whatever they were trying to do, and refresh gated surfaces.
      onProUnlocked({ announceRestore: false });
      return;
    }
    // Not ok — branch on the specific failure shape (never a red "nothing charged"
    // claim on ambiguous failures).
    buyBtn.disabled = false; buyBtn.textContent = "Unlock Pro";
    if (res && res.inFlight) {
      // A purchase from a moment ago is still settling (entitlement attaching). Don't open a
      // second checkout or show an error card — reassure, and Pro unlocks itself when it lands.
      status(msgHost, "Your purchase is still going through — give it a moment and Pro will unlock automatically.", "info");
    } else if (res && res.cancelled) {
      // Neutral/grey, role=status — a deliberate close is NOT a failure. No red, no retry-nag.
      status(msgHost, "No charge was made — Pro will be here whenever you're ready.", "note");
    } else if (res && res.offline) {
      // "no charge was made just now" — scoped to THIS attempt; never a blanket claim
      // (an earlier ambiguous attempt could have charged).
      status(msgHost, "You're offline — buying Pro needs a connection for the secure checkout. Everything else works offline, and no charge was made just now.", "note");
    } else if (res && res.pending) {
      // PAID — the charge SUCCEEDED; the entitlement is only still attaching (a few seconds).
      // Never show the "purchase didn't start / you weren't charged" card or a re-buy button to
      // someone who just paid. Reassure, hand over the code, and auto-unlock when it lands.
      close();
      handlePurchasePending(res.restoreCode || null, res.error);
    } else {
      // Genuine error (not cancelled, not offline): polished, on-brand error STATE
      // that keeps the substance of the proven copy. "Try again" re-runs runPurchase.
      renderPurchaseError(msgHost, runPurchase);
    }
  }
  buyBtn.onclick = runPurchase;
  const closeBtn = txt("button", "btn ghost", "Not now"); closeBtn.type = "button";
  closeBtn.onclick = close;
  const restoreLink = txt("button", "restore-link", IS_NATIVE ? "Restore Purchases" : "Already Pro? Restore with a code"); restoreLink.type = "button";
  if (IS_NATIVE) {
    // Apple's required "Restore Purchases": re-syncs this Apple ID's receipt with the App Store.
    // No typed restore code on iOS — Apple carries the entitlement across the buyer's devices.
    restoreLink.onclick = async () => {
      const prev = restoreLink.textContent;
      restoreLink.disabled = true; restoreLink.textContent = "Restoring…";
      let res;
      try { res = await Billing.restorePurchases(); }
      catch (e) { console.error("Local PDF: restore threw", e); res = { ok: false }; }
      if (res && res.ok) { close(); onProUnlocked({ announceRestore: true }); }
      else {
        restoreLink.disabled = false; restoreLink.textContent = prev;
        // The web-buyer clause matters here: web Pro and App Store Pro are separate
        // purchases, so a web owner must not be sent hunting through Apple Accounts.
        status(msgHost, "No previous purchase found. Make sure you're signed in with the Apple Account you bought Pro with. Bought on the web? Web and App Store purchases are separate — your code works in your browser.", "note");
      }
    };
  } else {
    restoreLink.onclick = () => { close(); showRestoreEntryModal(); };
  }
  const actions = el("div", "pro-actions"); actions.append(buyBtn, closeBtn);
  modal.append(actions, msgHost, restoreLink);
  backdrop.appendChild(modal);
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) close(); });
  document.body.appendChild(backdrop);
  // A11y: dialog semantics + focus into the modal + Tab trap. Focus starts on the
  // primary Unlock button. Escape is handled here (so it also resets proModalOpen)
  // rather than via the trap's generic remove(); the trap keeps escCloses off.
  focusTrap(backdrop, modal, buyBtn, { escCloses: false });
  document.addEventListener("keydown", function onEsc(e) {
    if (!document.body.contains(backdrop)) { document.removeEventListener("keydown", onEsc, true); return; }
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); document.removeEventListener("keydown", onEsc, true); }
  }, true);
}

// Polished, on-brand error STATE shown inside the paywall's message host when a
// genuine purchase failure comes back (NOT cancelled, NOT offline). Keeps the
// substance of the proven copy but presents it as a tasteful card: a soft danger
// mark, a calm heading, the reassuring body, a "won't be charged" line, a support
// line, and a primary "Try again" that re-runs the SAME purchase flow (retry()).
// SVG is aria-hidden; the region is role="alert" so it's announced; all text is
// set via textContent (safe). No billing logic lives here.
function renderPurchaseError(host, retry) {
  clearInfo(host);                 // drop any lingering .status / SR text
  host.textContent = "";           // own the message host for the error card
  const card = el("div", "pro-err");
  card.setAttribute("role", "alert");
  // Soft danger circle + X, gentle glow, using the app's danger token (--err-ink).
  const mark = el("div", "pro-err-mark",
    '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
      '<circle cx="12" cy="12" r="11" fill="currentColor" fill-opacity="0.12" stroke="currentColor" stroke-opacity="0.35" stroke-width="1.5"/>' +
      '<path d="M8.5 8.5l7 7M15.5 8.5l-7 7" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>' +
    '</svg>');
  mark.setAttribute("aria-hidden", "true");
  card.appendChild(mark);
  card.appendChild(txt("h4", "pro-err-title", "Something went wrong"));
  // "no charge was made just now" — scoped to this attempt, honest both ways.
  card.appendChild(txt("p", "pro-err-body",
    "If your card was charged, your Pro will unlock automatically on your next visit — otherwise no charge was made just now."));
  // Secure / won't-be-charged reassurance line (mirrors the checkout tone).
  const secure = el("p", "pro-err-secure",
    '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 3l7 3v5c0 4.5-3 7.6-7 9-4-1.4-7-4.5-7-9V6l7-3z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M9 12l2 2 4-4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>');
  secure.appendChild(document.createTextNode("If a charge did go through, your Pro unlocks automatically — nothing is lost."));
  card.appendChild(secure);
  // Support line with THIS app's business email as a mailto: link (allowed).
  const support = el("p", "pro-err-support");
  support.appendChild(document.createTextNode("Still stuck? Email "));
  const mail = txt("a", "pro-err-mail", "support@localpdfapp.com");
  mail.href = "mailto:support@localpdfapp.com";
  support.appendChild(mail);
  support.appendChild(document.createTextNode(IS_NATIVE ? " with your App Store receipt and we'll sort it out." : " with your Stripe receipt and we'll sort it out."));
  card.appendChild(support);
  // Primary "Try again" — re-runs the exact same purchase flow.
  const tryBtn = txt("button", "btn big pro-err-retry", "Try again"); tryBtn.type = "button";
  tryBtn.onclick = () => { if (typeof retry === "function") retry(); };
  card.appendChild(tryBtn);
  host.appendChild(card);
  // Move focus to the retry control so keyboard/SR users land on the next action.
  try { tryBtn.focus(); } catch (_) {}
  announce("Something went wrong. If your card was charged, your Pro will unlock automatically on your next visit — otherwise no charge was made just now.", "err"); // mirrors the visible card's scoped wording
}

// Called when the charge SUCCEEDED but the entitlement is still attaching (billing
// returned { pending:true }). The customer HAS paid — so this must never read as a
// failure. Reassure, give them their restore code now, and quietly promote to a full
// unlock the moment the entitlement lands (no manual reload needed).
function handlePurchasePending(restoreCode, message) {
  const msg = message || "Your payment went through — your Pro is unlocking now. If it doesn't appear in a moment, reload this page.";
  announce(msg, "ok");
  showToast("Payment received — unlocking your Pro…");
  if (restoreCode) showRestoreCodeModal(restoreCode); // they paid; hand over their key straight away
  // Four quick polls cover normal attach lag (~10s). If Pro still hasn't landed by then,
  // don't go quiet on sighted users (the toast is long gone and the reload hint lives only
  // in the screen-reader live region): keep ONE gentle persistent status line up and keep
  // checking at a calmer pace, clearing it the moment Pro lands. Polling stops after ~6
  // minutes — the purchase_attempted flag already guarantees the next load re-checks, so
  // "appears automatically" stays true on reload too.
  let tries = 0;
  const poll = async () => {
    tries++;
    const pro = await safeBillingAsync(() => Billing.refreshProStatus(), false);
    if (pro) {
      const bar = $("#pendingUnlockBanner"); if (bar) bar.remove();
      markWasPro(); refreshAfterProChange();
      return;
    }
    if (tries === 4) showPendingUnlockLine(); // ~10s in: switch from silence to the persistent line
    if (tries < 40) setTimeout(poll, tries < 4 ? 2500 : 10000);
  };
  setTimeout(poll, 2500);
}

// Persistent, dismissible "still confirming" line for the paid-but-still-attaching case,
// in the same banner slot styling as the app's other top-of-body notices. role="status"
// so it's announced once without interrupting.
function showPendingUnlockLine() {
  if ($("#pendingUnlockBanner")) return;
  const bar = el("div", "save-nag"); bar.id = "pendingUnlockBanner";
  bar.setAttribute("role", "status");
  bar.appendChild(txt("span", null, "Still confirming your unlock with the payment provider — this can take a minute. Your Pro will appear automatically."));
  const x = txt("button", "save-nag-x", "×"); x.type = "button"; x.setAttribute("aria-label", "Dismiss");
  x.onclick = () => bar.remove();
  bar.append(x);
  document.body.insertBefore(bar, document.body.firstChild);
  // Same scroll-reveal dance as the other top-of-body banners.
  window.scrollTo({ top: 0 });
  requestAnimationFrame(() => window.scrollTo({ top: 0 }));
}

// Post-purchase modal for the ok+restoreCode:null case AFTER the celebration has
// already fired on a prior purchase (rare). Celebrate-free amber mint offer.
function showPostPurchaseAmberModal() {
  const backdrop = el("div", "modal-backdrop");
  const modal = el("div", "modal pro-modal");
  modal.setAttribute("role", "dialog"); modal.setAttribute("aria-modal", "true");
  modal.setAttribute("aria-labelledby", "amberTitle");
  const h = txt("h3", null, "You're Pro"); h.id = "amberTitle";
  modal.appendChild(h);
  if (IS_NATIVE) {
    // Apple IAP mints no restore CODE — cross-device restore is handled by the Apple ID +
    // "Restore Purchases", so skip the mint flow and show a clean success instead.
    modal.appendChild(txt("p", "hint", "Pro is unlocked on this device — and it restores free on your other Apple devices. Just tap “Restore Purchases” there, signed in with the same Apple Account."));
    const doneBtn = txt("button", "btn big", "Done"); doneBtn.type = "button";
    doneBtn.onclick = () => { backdrop.remove(); refreshAfterProChange(); };
    const actions = el("div", "pro-actions"); actions.append(doneBtn);
    modal.appendChild(actions);
    backdrop.appendChild(modal);
    backdrop.addEventListener("click", (e) => { if (e.target === backdrop) backdrop.remove(); });
    document.body.appendChild(backdrop);
    focusTrap(backdrop, modal, doneBtn, { escCloses: true });
    return;
  }
  const section = el("div"); modal.appendChild(section);
  renderAmberMintFlow(section);
  const doneBtn = txt("button", "btn big", "Done"); doneBtn.type = "button";
  doneBtn.onclick = () => { backdrop.remove(); refreshAfterProChange(); };
  const actions = el("div", "pro-actions"); actions.append(doneBtn);
  modal.appendChild(actions);
  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);
  focusTrap(backdrop, modal, doneBtn, { escCloses: false });
}
// Mirror status text into a persistent screen-reader live region so assistive
// tech announces it even though the visible .status node is created/removed per
// tool. Errors go to the assertive (role="alert") region; info/ok to polite.
// Text is set via textContent — safe for filenames/errors.
function announce(msg, kind) {
  const polite = $("#srPolite"), assertive = $("#srAssertive");
  if (kind === "err") { if (assertive) assertive.textContent = msg; if (polite) polite.textContent = ""; }
  else { if (polite) polite.textContent = msg; if (assertive) assertive.textContent = ""; }
}
// status message text is set via textContent — safe for filenames/errors.
// kind: "info" (in-progress, spinner) | "ok" | "err" | "note" (neutral/grey,
// role=status, NO spinner — used for benign outcomes like a cancelled checkout).
function status(host, msg, kind = "info") {
  let s = $(".status", host);
  if (!s) { s = el("div"); host.appendChild(s); }
  s.className = "status " + kind;
  s.textContent = "";
  if (kind === "info") s.appendChild(el("span", "spinner")); // only in-progress spins
  s.appendChild(document.createTextNode(msg));
  announce(msg, kind); // "err" → assertive; everything else (incl. "note") → polite
  return s;
}
// Remove any lingering status (info/ok/err) and clear the SR live region — used
// when a step finishes or the user switches tools/files so nothing stale is read.
function clearInfo(host) {
  const s = $(".status", host);
  if (s) s.remove();
  const polite = $("#srPolite"), assertive = $("#srAssertive");
  if (polite) polite.textContent = "";
  if (assertive) assertive.textContent = "";
}
// Never surface a raw library error message (it can contain file-derived text
// AND would leak internals). Map to a friendly, safe sentence.
function friendly(e) {
  const m = (e && e.message) || String(e);
  if (m === "PASSWORD_PROTECTED") return "This PDF is password-protected. Open it in your PDF app, remove the password, then try again.";
  if (m === "READ_FAILED") return "Couldn't read that file from your device.";
  if (m === "NO_PAGES") return "That produced an empty PDF — nothing to save.";
  return "Couldn't process that file — it may be corrupt or in an unexpected format.";
}

// ── Safe PDF loaders (detect encryption; CSP-safe pdf.js) ────────────
async function loadForEdit(bytes) { // pdf-lib
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  if (doc.isEncrypted) throw new Error("PASSWORD_PROTECTED"); // copyPages would emit garbage
  return doc;
}
async function loadForRender(bytes) { // pdf.js
  try { return await pdfjsLib.getDocument({ data: bytes.slice(), isEvalSupported: false }).promise; }
  catch (e) { if (e && (e.name === "PasswordException" || /password/i.test(e.message || ""))) throw new Error("PASSWORD_PROTECTED"); throw e; }
}

const ICONS = {
  merge: '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="8" height="8" rx="1.5"/><rect x="13" y="13" width="8" height="8" rx="1.5"/><path d="M11 7h4a2 2 0 0 1 2 2v4"/></svg>',
  split: '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v18"/><rect x="3" y="6" width="6" height="12" rx="1.5"/><rect x="15" y="6" width="6" height="12" rx="1.5"/></svg>',
  organize: '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>',
  img2pdf: '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9" r="1.6"/><path d="m5 18 5-5 4 4 3-3 2 2"/></svg>',
  pdf2img: '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><circle cx="10" cy="13" r="1.4"/><path d="m8 18 3-3 2 2"/></svg>',
  compress: '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8V5a1 1 0 0 1 1-1h3M20 8V5a1 1 0 0 0-1-1h-3M4 16v3a1 1 0 0 0 1 1h3M20 16v3a1 1 0 0 1-1 1h-3"/><path d="M9 12h6"/></svg>',
  search: '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>',
  extract: '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M8.5 13h7M8.5 16.5h5"/></svg>',
  ocr: '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2"/><path d="M7 9h10M7 12.5h10M7 16h6"/></svg>',
  pagenum: '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8"/><path d="M8 12h5"/><path d="M13.5 17.5h3M15 16v3"/></svg>',
  removemeta: '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="m9.5 12.5 5 5M14.5 12.5l-5 5"/></svg>',
  watermark: '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="3" width="16" height="18" rx="2"/><path d="M7.5 16.5 16.5 7.5" opacity=".55"/><path d="M9.5 18.5 18.5 9.5" opacity=".55"/></svg>',
  fillforms: '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9h6"/><path d="M7 13h4"/><path d="m14.5 15.5 2 2 3.5-4"/></svg>',
  sign: '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 19c3-1 4.5-2.5 5.5-5S10 8 11 8s.8 2 .3 4.5S10.5 17 12 17s2.5-2 3.5-2 1 1.5 2.5 1.5"/><path d="M18.5 6.5 20 8"/><path d="M16 21h5"/></svg>',
  redact: '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><rect x="7.5" y="12" width="9" height="3.4" rx=".6" fill="currentColor" stroke="none"/></svg>',
};

// Friendly inline-SVG illustration for the empty drop-zone (replaces a bare
// emoji glyph that rendered inconsistently). Decorative — aria-hidden on the
// wrapper. Uses currentColor so it inherits the brand-tinted .drop .big color.
const DROP_ILLUSTRATION = '<svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M18 10h18l12 12v30a4 4 0 0 1-4 4H18a4 4 0 0 1-4-4V14a4 4 0 0 1 4-4z" fill="var(--drop-illo-fill)" stroke="currentColor" stroke-width="2.4" stroke-linejoin="round"/><path d="M36 10v12h12" stroke="currentColor" stroke-width="2.4" stroke-linejoin="round" fill="none"/><path d="M31 46V32m0 0-6 6m6-6 6 6" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

// ── Reusable drop zone (static markup only) ─────────────────────────
function dropZone(accept, multiple, onFiles) {
  const zone = el("div", "drop");
  // Keyboard-operable: the dashed area itself is a button (Enter/Space open the
  // file chooser), not just mouse-clickable.
  zone.setAttribute("role", "button");
  zone.setAttribute("tabindex", "0");
  const kind = accept && accept.startsWith("image/") ? "image" : "PDF";
  const article = kind === "image" ? "an" : "a";
  zone.setAttribute("aria-label", multiple ? ("Choose " + kind + " files") : ("Choose a " + kind + " file"));
  const big = el("div", "big", DROP_ILLUSTRATION); big.setAttribute("aria-hidden", "true"); zone.appendChild(big);
  zone.appendChild(txt("h4", null, `Drop ${multiple ? "files" : "a file"} here`));
  zone.appendChild(txt("p", null, `or click to choose${multiple ? " — add as many as you like" : ""}. Nothing is uploaded.`));
  const input = el("input"); input.type = "file"; input.accept = accept; input.multiple = !!multiple; input.className = "hidden";
  const btn = txt("button", "btn", "Choose " + (multiple ? "files" : "file")); btn.type = "button";
  zone.appendChild(btn); zone.appendChild(input);
  const pick = () => input.click();
  zone.addEventListener("click", (e) => { if (e.target === zone || e.target === big || e.target.tagName === "H4" || e.target.tagName === "P") pick(); });
  // Enter/Space on the focused zone triggers the same chooser (skip when focus
  // is on the inner button, which handles its own activation).
  zone.addEventListener("keydown", (e) => { if (e.target !== zone) return; if (e.key === "Enter" || e.key === " " || e.key === "Spacebar") { e.preventDefault(); pick(); } });
  btn.addEventListener("click", (e) => { e.stopPropagation(); pick(); });
  // Wrong-type pick is no longer a silent no-op: if the user chose/dropped only
  // files that don't match `accept`, say so instead of doing nothing.
  const rejectWrongType = () => status(zone, `That's not ${article} ${kind} file — please choose ${article} ${kind}.`, "err");
  input.addEventListener("change", () => {
    const raw = [...input.files]; const kept = raw.filter(f => matchAccept(f, accept));
    if (kept.length) { clearInfo(zone); onFiles(kept); } else if (raw.length) { rejectWrongType(); }
    input.value = "";
  });
  zone.addEventListener("dragover", (e) => { e.preventDefault(); zone.classList.add("drag"); });
  zone.addEventListener("dragleave", () => zone.classList.remove("drag"));
  zone.addEventListener("drop", (e) => {
    e.preventDefault(); zone.classList.remove("drag");
    const raw = [...e.dataTransfer.files]; const fs = raw.filter(f => matchAccept(f, accept));
    if (fs.length) { clearInfo(zone); onFiles(multiple ? fs : [fs[0]]); } else if (raw.length) { rejectWrongType(); }
  });
  return zone;
}
function matchAccept(file, accept) {
  if (accept === "application/pdf") return /\.pdf$/i.test(file.name) || file.type === "application/pdf";
  if (accept.startsWith("image/")) return /^image\/(png|jpe?g|webp|gif|bmp)$/i.test(file.type) || /\.(png|jpe?g|webp|gif|bmp)$/i.test(file.name);
  return true;
}

async function renderThumb(pdfDoc, pageNum, targetW = 140) {
  const page = await pdfDoc.getPage(pageNum);
  const vp0 = page.getViewport({ scale: 1 });
  const vp = page.getViewport({ scale: targetW / vp0.width });
  const canvas = el("canvas"); canvas.width = Math.ceil(vp.width); canvas.height = Math.ceil(vp.height);
  await page.render({ canvasContext: canvas.getContext("2d"), viewport: vp }).promise;
  return canvas;
}
// canvas.cloneNode() copies the element but never its drawn pixels — this
// actually copies the bitmap so a thumbnail can be reused across re-paints.
function copyCanvas(src) {
  const c = el("canvas"); c.width = src.width; c.height = src.height;
  c.getContext("2d").drawImage(src, 0, 0);
  return c;
}

// ── App shell ───────────────────────────────────────────────────────
const TOOLS = [
  { id: "merge", name: "Merge PDFs", desc: "Combine several PDFs into one file, in your preferred order.", open: toolMerge },
  { id: "split", name: "Split / Extract", desc: "Extract pages or split a PDF into multiple files.", open: toolSplit },
  { id: "organize", name: "Organize Pages", desc: "Reorder, rotate, and delete pages with live thumbnails.", open: toolOrganize },
  { id: "img2pdf", name: "Images → PDF", desc: "Convert JPGs or PNGs into a single PDF, in your order.", open: toolImg2Pdf },
  { id: "pdf2img", name: "PDF → Images", desc: "Save each page as a PNG or JPG image — or batch many at once.", open: toolPdf2Img },
  { id: "compress", name: "Compress PDF", desc: "Shrink a big PDF to fit email or upload limits — all on your device, nothing uploaded.", pro: false, open: toolCompress },
  { id: "search", name: "Search text", desc: "Find any word across a PDF — jump to every page it appears on.", open: toolSearch },
  { id: "extract", name: "Extract text", desc: "Pull all text out of a PDF as a .txt file.", open: toolExtractText },
  { id: "ocr", name: "Scan to text (OCR)", desc: "Read text off scanned or image-only PDFs — recognized on your device, never uploaded.", open: toolOcr },
  { id: "pagenum", name: "Add page numbers", desc: "Stamp page numbers onto a PDF — choose the position, format, and size.", open: toolAddPageNumbers },
  { id: "removemeta", name: "Remove metadata", desc: "Strip hidden author, title, and app info before you share — a quick privacy clean-up.", open: toolRemoveMetadata },
  { id: "watermark", name: "Watermark / stamp", desc: "Stamp “DRAFT”, “CONFIDENTIAL”, or your name across every page — pick the position, size, and opacity.", open: toolWatermark },
  { id: "fillforms", name: "Fill & flatten forms", desc: "Fill in a PDF form and bake the answers in so they can’t be changed later.", open: toolFillForms },
  { id: "sign", name: "Sign PDF", desc: "Draw or upload your signature and place it on any page — sign without uploading your document anywhere.", open: toolSign },
  { id: "redact", name: "Redact", desc: "Black out sensitive areas and permanently destroy what’s underneath — the hidden text and data are gone for good.", pro: false, open: toolRedact },
];

// ── Hub categories (design4 grouping) — presentation only; every tool keeps
//    its existing open() flow and click handler. Icons are developer-constant
//    markup (safe for el()'s html param).
const TOOL_CATEGORIES = [
  { id: "cat-organize", name: "Organize PDF", desc: "Reorder, split, and combine pages easily.", tools: ["merge", "split", "organize"] },
  { id: "cat-convert", name: "Convert", desc: "Convert PDFs to and from images — or shrink them down.", tools: ["img2pdf", "pdf2img", "compress"] },
  { id: "cat-extract", name: "Extract & Search", desc: "Find and extract content from your PDFs.", tools: ["search", "extract", "ocr"] },
  { id: "cat-secure", name: "Edit & secure", desc: "Stamp, clean up, and fill your PDFs before you share them.", tools: ["watermark", "removemeta", "fillforms", "sign", "redact"] },
  { id: "cat-other", name: "Other tools", desc: "More helpful tools to round out your PDFs.", tools: ["pagenum"] },
];
const CAT_ICONS = {
  "cat-organize": '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
  "cat-convert": '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9h12l-3.5-3.5"/><path d="M20 15H8l3.5 3.5"/></svg>',
  "cat-extract": '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M8.5 13h7M8.5 16.5h5"/></svg>',
  "cat-secure": '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3 5 6v5c0 4.2 2.9 7.4 7 8.5 4.1-1.1 7-4.3 7-8.5V6z"/><path d="m9.2 12 2 2 3.6-3.8"/></svg>',
  "cat-other": '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 8.98 19.4a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.6 8.98a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34H9a1.7 1.7 0 0 0 1.03-1.56V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87V9c.22.63.8 1.03 1.56 1.03H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51.97z"/></svg>',
};
const TOOL_GO_ARROW = '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="m13 6 6 6-6 6"/></svg>';

const App = {
  showHub() { $("#workspace").classList.add("hidden"); $("#hub").classList.remove("hidden"); window.scrollTo({ top: 0 }); },
  openTool(id) {
    const tool = TOOLS.find(t => t.id === id);
    const ws = $("#workspace"); ws.innerHTML = "";
    const head = el("div", "ws-head");
    const back = txt("button", "back", "← All tools"); back.onclick = () => App.showHub();
    head.appendChild(back); ws.appendChild(head);
    ws.appendChild(txt("div", "ws-title", tool.name));
    ws.appendChild(txt("div", "ws-sub", tool.desc));
    const body = el("div"); ws.appendChild(body);
    $("#hub").classList.add("hidden"); ws.classList.remove("hidden"); window.scrollTo({ top: 0 });
    tool.open(body);
  },
};
function buildHub() {
  const grid = $("#toolGrid");
  TOOL_CATEGORIES.forEach(cat => {
    const section = el("section", "cat-section");
    const head = el("div", "cat-head");
    head.appendChild(el("span", "cat-ico " + cat.id, CAT_ICONS[cat.id]));
    const headText = el("div", "cat-head-text");
    headText.appendChild(txt("h2", "cat-name", cat.name));
    headText.appendChild(txt("p", "cat-desc", cat.desc));
    head.appendChild(headText);
    section.appendChild(head);
    const row = el("div", "grid");
    cat.tools.forEach(id => {
      const t = TOOLS.find(x => x.id === id);
      if (!t) return;
      const card = el("button", "tool");
      card.type = "button";
      card.appendChild(el("div", "ico", ICONS[t.id]));
      card.appendChild(txt("h3", null, t.name));
      card.appendChild(txt("p", null, t.desc));
      // Pro-gated tools carry a small "Pro" badge — but never for an owner (they've
      // already unlocked it, so the upsell tag would be noise). Constant markup.
      if (t.pro && !safeBilling(() => Billing.isPro(), false)) {
        const tag = txt("span", "tool-pro-tag", "Pro");
        tag.setAttribute("aria-hidden", "true");
        card.appendChild(tag);
      }
      const go = el("span", "go", TOOL_GO_ARROW);
      go.setAttribute("aria-hidden", "true");
      card.appendChild(go);
      card.onclick = () => App.openTool(t.id);
      // In-memory search index: name + description, lowercased once at build.
      card.dataset.search = (t.name + " " + t.desc).toLowerCase();
      row.appendChild(card);
    });
    section.appendChild(row);
    grid.appendChild(section);
  });
  // Client-side tool search: plain substring filter over name+description.
  // Hides non-matching cards, collapses emptied categories, and shows the
  // "no results" line (role=status announces it) when nothing matches.
  const searchInput = $("#toolSearch");
  const emptyMsg = $("#toolSearchEmpty");
  if (searchInput) {
    searchInput.addEventListener("input", () => {
      const q = searchInput.value.trim().toLowerCase();
      let anyVisible = false;
      grid.querySelectorAll(".cat-section").forEach(sec => {
        let visible = 0;
        sec.querySelectorAll(".tool").forEach(cardEl => {
          const hit = !q || (cardEl.dataset.search || "").includes(q);
          cardEl.classList.toggle("hidden", !hit);
          if (hit) visible++;
        });
        sec.classList.toggle("hidden", visible === 0);
        if (visible) anyVisible = true;
      });
      if (emptyMsg) emptyMsg.classList.toggle("hidden", anyVisible);
    });
  }
  $("#logo").onclick = () => App.showHub();
}

// ── Shared: build a file row safely (name via textContent) ──────────
function fileRow(name, subText, onRemove, thumbUrl) {
  const row = el("div", "fileitem"); row.draggable = true;
  row.appendChild(txt("span", "grip", "⠿"));
  if (thumbUrl) { const im = el("img", "thumb"); im.src = thumbUrl; row.appendChild(im); }
  const meta = el("div", "meta");
  meta.appendChild(txt("div", "name", name));      // SAFE: textContent
  meta.appendChild(txt("div", "sub", subText));
  row.appendChild(meta);
  const x = txt("button", "x", "✕"); x.type = "button"; x.setAttribute("aria-label", "Remove file"); x.title = "Remove file"; x.onclick = onRemove; row.appendChild(x);
  return row;
}

// ── TOOL: Merge ─────────────────────────────────────────────────────
function toolMerge(host) {
  const items = [];
  const zone = dropZone("application/pdf", true, addFiles);
  const list = el("div", "filelist");
  const actions = el("div", "controls hidden");
  const merged = txt("button", "btn", "Merge & download"); merged.onclick = doMerge;
  const clear = txt("button", "btn ghost sm", "Clear all"); clear.onclick = () => { items.length = 0; render(); };
  actions.append(clear, el("div", "spacer"), merged);
  host.append(zone, list, actions);

  async function addFiles(files) {
    for (const file of files) {
      try { const bytes = await readBytes(file); const doc = await loadForEdit(bytes); items.push({ file, bytes, pages: doc.getPageCount() }); }
      catch (e) { status(host, `"${file.name}" — ${friendly(e)}`, "err"); }
    }
    render();
  }
  function render() {
    list.innerHTML = "";
    items.forEach((it, i) => {
      const row = fileRow(it.file.name, `${it.pages} page${it.pages !== 1 ? "s" : ""} · ${fmtBytes(it.bytes.length)}`, () => { items.splice(i, 1); render(); });
      row.dataset.i = i; dragReorder(row, list, () => i, items, render); list.appendChild(row);
    });
    actions.classList.toggle("hidden", items.length === 0);
    merged.disabled = items.length < 1;
    merged.textContent = items.length > 1 ? `Merge ${items.length} PDFs & download` : "Merge & download";
  }
  async function doMerge() {
    if (!items.length) return;
    merged.disabled = true; status(host, "Merging on your device…");
    try {
      const out = await PDFDocument.create();
      for (const it of items) { const src = await loadForEdit(it.bytes); const pages = await out.copyPages(src, src.getPageIndices()); pages.forEach(p => out.addPage(p)); }
      const bytes = await out.save();
      await download(bytes, "merged.pdf");
      status(host, `Done — merged ${out.getPageCount()} pages (${fmtBytes(bytes.length)}). ${IS_NATIVE ? "Saved to your device." : "Saved to your downloads."}`, "ok");
    } catch (e) { status(host, friendly(e), "err"); }
    merged.disabled = false;
  }
}

// ── Shared: load one PDF, then call ready(bytes, name). Errors keep
//    the drop zone so the user can retry; no stuck spinner. ──────────
function singleFileStage(host, ready) {
  const zone = dropZone("application/pdf", false, async (files) => {
    status(host, "Opening…");
    let bytes;
    try { bytes = await readBytes(files[0]); } catch (e) { return status(host, friendly(e), "err"); }
    try { await ready(bytes, files[0].name); zone.remove(); clearInfo(host); }
    catch (e) { status(host, friendly(e), "err"); } // zone stays → user can try another file
  });
  host.appendChild(zone);
}

// ── Shared: multi-file staging for the batch-capable tools ──────────
// Reuses the SAME plumbing as Merge (a multi-select dropZone + fileRow list).
// With exactly ONE file loaded it hands off to the tool's existing single-file
// panel via cfg.single(host, bytes, name) — so 1-file behavior is byte-for-byte
// today's (free, unchanged). With 2+ files it shows the list and a Pro-gated
// "Process all N files" button that runs cfg.perFile over each file sequentially,
// isolates per-file errors, and delivers every result as one ZIP.
//
// cfg = {
//   single(host, bytes, name)              — the tool's existing single-file panel
//   perFile(bytes, name, opts, onProgress) — one file → {name,bytes} OR array of them
//   batchVerb: "compress" | "convert"      — used in the button + status wording
//   zipName: "local-pdf-batch-*.zip"
//   levelOptions?: innerHTML for a Level <select> in the batch bar (Compress)
//   batchFields?: () => ({ nodes:[…], read: () => opts })  (PDF→Images format/quality)
// }
function batchFileStage(host, cfg) {
  const items = []; // { file, bytes, name }
  const zone = dropZone("application/pdf", true, addFiles);
  const list = el("div", "filelist");
  const single = el("div"); // filled by cfg.single when exactly one file is loaded
  const bar = el("div", "controls hidden");
  const clear = txt("button", "btn ghost sm", "Clear all"); clear.type = "button";
  clear.onclick = () => { items.length = 0; render(); };

  // Optional per-tool controls in the batch bar (level, or format/quality).
  let readOpts = () => undefined;
  const fieldNodes = [];
  if (cfg.levelOptions) {
    const fLvl = el("div", "field"); fLvl.appendChild(txt("label", null, "Level"));
    const lvl = el("select"); lvl.innerHTML = cfg.levelOptions; fLvl.appendChild(lvl);
    fieldNodes.push(fLvl); readOpts = () => lvl.value;
  } else if (cfg.batchFields) {
    const bf = cfg.batchFields();
    bf.nodes.forEach((n) => fieldNodes.push(n)); readOpts = bf.read;
  }
  const batchBtn = txt("button", "btn js-pro-gated", "Process all files (Pro)"); batchBtn.type = "button";
  bar.append(clear, ...fieldNodes, el("div", "spacer"), batchBtn);
  batchBtn.onclick = runBatch;

  host.append(zone, list, single, bar);

  async function addFiles(files) {
    for (const file of files) {
      try { const bytes = await readBytes(file); items.push({ file, bytes, name: file.name }); }
      catch (e) { status(host, `"${file.name}" — ${friendly(e)}`, "err"); }
    }
    render();
  }

  function render() {
    // ONE file → today's single-file experience: no list, no batch bar, hand off
    // to the tool's own panel. (Re-rendering the panel each add is fine — a fresh
    // add of a single file is the same as dropping one on the original zone.)
    single.innerHTML = "";
    if (items.length === 1) {
      list.innerHTML = ""; bar.classList.add("hidden"); zone.classList.add("hidden");
      clearInfo(host); clearInfo(single);
      const it = items[0];
      // Render the tool's existing single-file panel into its own container, so
      // status/messages attach there and it clears cleanly if the file changes.
      // On load failure (e.g. password-protected), drop the file and restore the
      // drop zone so the user can pick another — matching singleFileStage.
      Promise.resolve(cfg.single(single, it.bytes, it.name)).catch((e) => {
        items.length = 0; single.innerHTML = ""; zone.classList.remove("hidden");
        status(host, friendly(e), "err");
      });
      return;
    }
    // Zero files → bare drop zone. 2+ files → keep the zone (so more can be added)
    // plus the list + batch bar below it.
    zone.classList.remove("hidden");
    list.innerHTML = "";
    items.forEach((it, i) => {
      const row = fileRow(it.name, fmtBytes(it.bytes.length), () => { items.splice(i, 1); render(); });
      row.draggable = false; const grip = $(".grip", row); if (grip) grip.remove();
      list.appendChild(row);
    });
    bar.classList.toggle("hidden", items.length < 2);
    // Owners never see the "(Pro)" upsell suffix on the batch button.
    const proTag = safeBilling(() => Billing.isPro(), false) ? "" : " (Pro)";
    batchBtn.textContent = items.length >= 2 ? `Process all ${items.length} files${proTag}` : `Process all files${proTag}`;
    if (items.length >= 2) clearInfo(host);
  }

  async function runBatch() {
    const n = items.length;
    if (n < 2) return;
    // Gate: busy-state during the entitlement check, guard double-clicks, and on a
    // miss remember this exact batch as the pending intent so it auto-runs after
    // unlock/restore. Billing.isPro() fast-path → refreshProStatus() re-check.
    if (batchBtn.disabled) return;                 // guard double-click while checking
    const label = batchBtn.textContent;
    if (!safeBilling(() => Billing.isPro(), false)) {
      batchBtn.disabled = true; batchBtn.textContent = "Checking…";
      const pro = await safeBillingAsync(() => Billing.refreshProStatus(), false);
      batchBtn.disabled = false; batchBtn.textContent = label;
      if (!pro) {
        setPendingIntent(() => { if (items.length >= 2) doBatch(); });
        showProModal({ lead: `Process all ${n} files at once` });
        return;
      }
    }
    doBatch();
  }

  async function doBatch() {
    const n = items.length;
    if (n < 2) return;
    batchBtn.disabled = true; clear.disabled = true;
    const opts = readOpts();
    const out = []; let failed = 0;
    for (let k = 0; k < n; k++) {
      const it = items[k];
      try {
        status(host, `${cfg.batchVerb === "compress" ? "Compressing" : "Converting"} file ${k + 1} of ${n}…`);
        const res = await cfg.perFile(it.bytes, it.name, opts, (pi, pn) =>
          status(host, `${cfg.batchVerb === "compress" ? "Compressing" : "Converting"} file ${k + 1} of ${n} — page ${pi} of ${pn}…`));
        (Array.isArray(res) ? res : [res]).forEach((f) => out.push(f));
      } catch (e) { failed++; } // per-file isolation: note it, keep going
    }
    if (!out.length) {
      status(host, `Couldn't process ${failed === 1 ? "that file" : "any of those files"} — they may be corrupt, password-protected, or in an unexpected format.`, "err");
      batchBtn.disabled = false; clear.disabled = false; return;
    }
    try {
      status(host, "Zipping…");
      const zipSize = await downloadAsZip(out, cfg.zipName);
      const okCount = n - failed;
      const note = failed ? ` (${failed} file${failed !== 1 ? "s" : ""} skipped — couldn't be read)` : "";
      status(host, `Done — ${okCount} file${okCount !== 1 ? "s" : ""} in one ZIP (${fmtBytes(zipSize)})${note}.`, failed ? "info" : "ok");
    } catch (e) { status(host, friendly(e), "err"); }
    batchBtn.disabled = false; clear.disabled = false;
  }
}

// ── TOOL: Split / Extract ───────────────────────────────────────────
function toolSplit(host) {
  singleFileStage(host, async (bytes, name) => {
    const src = await loadForEdit(bytes);
    const total = src.getPageCount();
    const panel = el("div");
    const hint = el("div", "hint"); hint.style.marginBottom = "14px";
    hint.append(document.createTextNode("Loaded "), txt("b", null, name), document.createTextNode(` — ${total} pages.`));
    const radios = el("div", "radios");
    radios.innerHTML = `<label><input type="radio" name="mode" value="range" checked> Extract page range into one PDF</label>
      <label><input type="radio" name="mode" value="each"> Split into one PDF per page</label>`;
    const ctl = el("div", "controls"); ctl.style.border = "0"; ctl.style.paddingTop = "14px";
    const rangeF = el("div", "field");
    rangeF.appendChild(txt("label", null, "Pages (e.g. 1-3, 5, 8-10)"));
    const rangeIn = el("input"); rangeIn.type = "text"; rangeIn.value = `1-${total}`; rangeIn.style.width = "220px"; rangeF.appendChild(rangeIn);
    const go = txt("button", "btn", "Extract & download");
    const zipBtn = txt("button", "btn ghost hidden js-pro-gated", "Download all as ZIP (Pro)");
    ctl.append(rangeF, el("div", "spacer"), go, zipBtn);
    // Per-page mode fires one download per page, so Chrome asks the user to
    // "allow multiple downloads" — forewarn on that mode only (ZIP is one file).
    const multiHint = txt("div", "hint hidden", IS_NATIVE ? "Each page is saved to your device." : "Your browser may ask to allow multiple downloads.");
    multiHint.style.marginTop = "10px";
    panel.append(hint, radios, ctl, multiHint); host.appendChild(panel);
    radios.querySelectorAll('input[name=mode]').forEach(r => r.onchange = () => {
      const mode = radios.querySelector('input[name=mode]:checked').value;
      rangeF.style.visibility = mode === "range" ? "visible" : "hidden";
      go.textContent = mode === "range" ? "Extract & download" : "Split all & download each";
      zipBtn.classList.toggle("hidden", mode !== "each");
      multiHint.classList.toggle("hidden", mode !== "each");
    });
    go.onclick = async () => {
      const mode = radios.querySelector('input[name=mode]:checked').value; go.disabled = true;
      try {
        if (mode === "range") {
          const idx = parseRanges(rangeIn.value, total);
          if (!idx.length) throw new Error("No valid pages in that range.");
          const out = await PDFDocument.create();
          (await out.copyPages(src, idx)).forEach(p => out.addPage(p));
          const b = await out.save(); await download(b, `${safeName(name)}-pages.pdf`);
          status(host, `Extracted ${idx.length} page${idx.length !== 1 ? "s" : ""} (${fmtBytes(b.length)}).`, "ok");
        } else {
          for (let i = 0; i < total; i++) {
            status(host, `Preparing file ${i + 1} of ${total}…`);
            const out = await PDFDocument.create(); const [pg] = await out.copyPages(src, [i]); out.addPage(pg);
            await download(await out.save(), `${safeName(name)}-p${String(i + 1).padStart(2, "0")}.pdf`);
            await new Promise(r => setTimeout(r, 250));
          }
          status(host, `Split into ${total} files. ${IS_NATIVE ? "Saved to your device." : "Check your downloads folder."}`, "ok");
        }
      } catch (e) { status(host, e.message && e.message.startsWith("No valid") ? e.message : friendly(e), "err"); }
      go.disabled = false;
    };
    const runSplitZip = async () => {
      zipBtn.disabled = true;
      try {
        const files = [];
        for (let i = 0; i < total; i++) {
          status(host, `Preparing file ${i + 1} of ${total}…`);
          const out = await PDFDocument.create(); const [pg] = await out.copyPages(src, [i]); out.addPage(pg);
          files.push({ name: `${safeName(name)}-p${String(i + 1).padStart(2, "0")}.pdf`, bytes: await out.save() });
        }
        status(host, "Zipping…");
        const zipSize = await downloadAsZip(files, `${safeName(name)}-split.zip`);
        status(host, `Downloaded a ZIP with ${total} files (${fmtBytes(zipSize)}).`, "ok");
      } catch (e) { status(host, friendly(e), "err"); }
      zipBtn.disabled = false;
    };
    zipBtn.onclick = () => gateProAction(zipBtn, "Download all as ZIP (Pro)", runSplitZip);
  });
}
function parseRanges(str, total) {
  const set = new Set();
  for (const part of String(str).split(",")) {
    const m = part.trim().match(/^(\d+)\s*-\s*(\d+)$/);
    if (m) { let a = +m[1], b = +m[2]; if (a > b) [a, b] = [b, a]; for (let p = a; p <= b; p++) if (p >= 1 && p <= total) set.add(p - 1); }
    else { const t = part.trim(); if (/^\d+$/.test(t)) { const p = +t; if (p >= 1 && p <= total) set.add(p - 1); } }
  }
  return [...set].sort((a, b) => a - b);
}

// ── TOOL: Organize (reorder / rotate / delete) ──────────────────────
function toolOrganize(host) {
  singleFileStage(host, async (bytes, name) => {
    const js = await loadForRender(bytes);
    const order = []; for (let i = 0; i < js.numPages; i++) order.push({ src: i, rot: 0 });
    const thumbs = {}; // src -> canvas (filled progressively)
    const grid = el("div", "pagegrid");
    const actions = el("div", "controls");
    const hint = txt("div", "hint", `${name} — drag to reorder · ⟳ to rotate · ✕ to delete`);
    const save = txt("button", "btn", "Save PDF"); save.onclick = doSave;
    actions.append(hint, el("div", "spacer"), save);
    host.append(grid, actions);
    paint(); // shows structure immediately with placeholders
    status(host, `Rendering thumbnails… (0/${js.numPages})`);
    for (let i = 1; i <= js.numPages; i++) {
      thumbs[i - 1] = await renderThumb(js, i, 140);
      if (i % 5 === 0 || i === js.numPages) { paint(); status(host, `Rendering thumbnails… (${i}/${js.numPages})`); await new Promise(r => setTimeout(r, 0)); }
    }
    clearInfo(host);

    function paint() {
      grid.innerHTML = "";
      order.forEach((o, i) => {
        const cell = el("div", "page"); cell.draggable = true; cell.dataset.i = i;
        if (thumbs[o.src]) { const c = copyCanvas(thumbs[o.src]); c.style.transform = `rotate(${o.rot}deg)`; if (o.rot % 180 !== 0) { c.style.width = "auto"; c.style.maxHeight = "140px"; c.style.margin = "12px auto"; } cell.appendChild(c); }
        else { const ph = el("div"); ph.style.cssText = "height:170px;display:flex;align-items:center;justify-content:center;color:#c4c8d4;font-size:12px"; ph.textContent = "…"; cell.appendChild(ph); }
        cell.appendChild(txt("span", "num", i + 1));
        const ctlx = el("div", "ctl");
        const rot = txt("button", null, "⟳"); rot.type = "button"; rot.title = "Rotate page " + (i + 1); rot.setAttribute("aria-label", "Rotate page " + (i + 1)); rot.onclick = (e) => { e.stopPropagation(); o.rot = (o.rot + 90) % 360; paint(); };
        const del = txt("button", null, "✕"); del.type = "button"; del.title = "Delete page " + (i + 1); del.setAttribute("aria-label", "Delete page " + (i + 1)); del.onclick = (e) => { e.stopPropagation(); order.splice(i, 1); paint(); };
        ctlx.append(rot, del); cell.appendChild(ctlx);
        dragReorder(cell, grid, () => order.indexOf(o), order, paint);
        grid.appendChild(cell);
      });
      save.disabled = order.length === 0;
      save.textContent = `Save PDF (${order.length} page${order.length !== 1 ? "s" : ""})`;
    }
    async function doSave() {
      if (!order.length) return;
      save.disabled = true; status(host, "Building your PDF…");
      try {
        const src = await loadForEdit(bytes);
        const out = await PDFDocument.create();
        const copied = await out.copyPages(src, order.map(o => o.src));
        copied.forEach((pg, i) => { const base = pg.getRotation().angle || 0; pg.setRotation(degrees((base + order[i].rot) % 360)); out.addPage(pg); });
        const b = await out.save(); await download(b, `${safeName(name)}-organized.pdf`);
        status(host, `Saved — ${order.length} pages (${fmtBytes(b.length)}).`, "ok");
      } catch (e) { status(host, friendly(e), "err"); }
      save.disabled = false;
    }
  });
}

// ── TOOL: Images → PDF ──────────────────────────────────────────────
function toolImg2Pdf(host) {
  const items = [];
  const zone = dropZone("image/*", true, addFiles);
  const list = el("div", "filelist");
  const actions = el("div", "controls hidden");
  const make = txt("button", "btn", "Create PDF"); make.onclick = build;
  const clear = txt("button", "btn ghost sm", "Clear"); clear.onclick = () => { items.forEach(it => URL.revokeObjectURL(it.url)); items.length = 0; render(); };
  actions.append(clear, el("div", "spacer"), make);
  host.append(zone, list, actions);

  async function addFiles(files) {
    let skipped = 0;
    for (const file of files) { try { const bytes = await readBytes(file); items.push({ file, bytes, url: URL.createObjectURL(new Blob([bytes])) }); } catch { skipped++; } }
    if (skipped) status(host, `Skipped ${skipped} image${skipped !== 1 ? "s" : ""} that couldn't be read.`, "err");
    render();
  }
  function render() {
    list.innerHTML = "";
    items.forEach((it, i) => {
      const row = fileRow(it.file.name, fmtBytes(it.bytes.length), () => { URL.revokeObjectURL(it.url); items.splice(i, 1); render(); }, it.url);
      dragReorder(row, list, () => i, items, render); list.appendChild(row);
    });
    actions.classList.toggle("hidden", !items.length);
    make.disabled = !items.length; make.textContent = items.length ? `Create PDF from ${items.length} image${items.length !== 1 ? "s" : ""}` : "Create PDF";
  }
  async function build() {
    make.disabled = true; status(host, "Building PDF on your device…");
    try {
      const out = await PDFDocument.create(); let skipped = 0;
      for (const it of items) {
        try {
          const isPng = /\.png$/i.test(it.file.name) || it.file.type === "image/png";
          let img;
          try { img = isPng ? await out.embedPng(it.bytes) : await out.embedJpg(it.bytes); }
          catch { img = await embedViaCanvas(out, it.url); }
          const page = out.addPage([img.width, img.height]);
          page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
        } catch { skipped++; }
      }
      if (out.getPageCount() === 0) throw new Error("NO_PAGES");
      const b = await out.save(); await download(b, "images.pdf");
      const note = skipped ? ` (${skipped} image${skipped !== 1 ? "s" : ""} skipped — unsupported format)` : "";
      status(host, `Created a ${out.getPageCount()}-page PDF (${fmtBytes(b.length)})${note}.`, skipped ? "info" : "ok");
    } catch (e) { status(host, e.message === "NO_PAGES" ? "None of those images could be added — try PNG or JPG." : friendly(e), "err"); }
    make.disabled = false;
  }
}
async function embedViaCanvas(out, url) {
  const im = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error("IMG")); i.src = url; });
  const cv = el("canvas"); cv.width = im.naturalWidth; cv.height = im.naturalHeight; cv.getContext("2d").drawImage(im, 0, 0);
  const jpg = await new Promise((r, j) => cv.toBlob(b => b ? b.arrayBuffer().then(a => r(new Uint8Array(a))) : j(new Error("IMG")), "image/jpeg", 0.92));
  return out.embedJpg(jpg);
}

// Core PDF→Images pipeline for ONE PDF's bytes → array of { name, bytes } image
// files. Shared by the single-file tool and the batch path. `f`=png|jpg, `sc`=scale.
// `prefix` names the output files; `onProgress(i,n)` (optional) reports per-page.
async function pdfToImageFiles(bytes, f, sc, prefix, onProgress) {
  const js = await loadForRender(bytes);
  const files = [];
  for (let i = 1; i <= js.numPages; i++) {
    if (onProgress) onProgress(i, js.numPages);
    const page = await js.getPage(i); const vp = page.getViewport({ scale: sc });
    const cv = el("canvas"); cv.width = Math.ceil(vp.width); cv.height = Math.ceil(vp.height);
    const cx = cv.getContext("2d"); if (f === "jpg") { cx.fillStyle = "#fff"; cx.fillRect(0, 0, cv.width, cv.height); }
    await page.render({ canvasContext: cx, viewport: vp }).promise;
    const type = f === "jpg" ? "image/jpeg" : "image/png";
    const blob = await new Promise(r => cv.toBlob(r, type, 0.9));
    files.push({ name: `${prefix}-p${String(i).padStart(2, "0")}.${f}`, bytes: new Uint8Array(await blob.arrayBuffer()), type });
  }
  return files;
}

// ── TOOL: PDF → Images ──────────────────────────────────────────────
// 1 file  → exactly today's behavior (free export + existing per-file ZIP gate).
// 2+ files → a file list + a Pro-gated batch button that renders every page of
//            every file and delivers them all as one ZIP.
function toolPdf2Img(host) {
  batchFileStage(host, {
    batchVerb: "convert",
    zipName: "local-pdf-batch-images.zip",
    // Format/quality selectors for the batch bar; mirror the single-file panel.
    batchFields: () => {
      const fFmt = el("div", "field"); fFmt.appendChild(txt("label", null, "Format"));
      const fmt = el("select"); fmt.innerHTML = `<option value="png">PNG (sharp)</option><option value="jpg">JPG (smaller)</option>`; fFmt.appendChild(fmt);
      const fSc = el("div", "field"); fSc.appendChild(txt("label", null, "Quality"));
      const scale = el("select"); scale.innerHTML = `<option value="1.5">Standard</option><option value="2" selected>High</option><option value="3">Very high</option>`; fSc.appendChild(scale);
      return { nodes: [fFmt, fSc], read: () => ({ f: fmt.value, sc: +scale.value }) };
    },
    perFile: async (bytes, name, opts, onProgress) =>
      await pdfToImageFiles(bytes, opts.f, opts.sc, safeName(name), onProgress),
    single: singlePdf2ImgPanel,
  });
}

// The original single-file PDF→Images panel (export + per-file ZIP gate),
// unchanged in behavior. Extracted so the multi-file stage reuses it for 1 file.
async function singlePdf2ImgPanel(host, bytes, name) {
  const js = await loadForRender(bytes);
  const panel = el("div");
  const ctl = el("div", "controls"); ctl.style.border = "0"; ctl.style.paddingTop = "0";
  const fFmt = el("div", "field"); fFmt.appendChild(txt("label", null, "Format"));
  const fmt = el("select"); fmt.innerHTML = `<option value="png">PNG (sharp)</option><option value="jpg">JPG (smaller)</option>`; fFmt.appendChild(fmt);
  const fSc = el("div", "field"); fSc.appendChild(txt("label", null, "Quality"));
  const scale = el("select"); scale.innerHTML = `<option value="1.5">Standard</option><option value="2" selected>High</option><option value="3">Very high</option>`; fSc.appendChild(scale);
  const go = txt("button", "btn", `Export ${js.numPages} image${js.numPages !== 1 ? "s" : ""}`);
  const zipBtn = txt("button", "btn ghost js-pro-gated", "Download all as ZIP (Pro)");
  ctl.append(fFmt, fSc, el("div", "spacer"), go, zipBtn);
  // Multi-page export fires one download per page, so Chrome asks the user to
  // "allow multiple downloads" — forewarn only when there's more than one page.
  const note = txt("div", "hint", IS_NATIVE ? `${name} — one image per page, saved to your device.` : `${name} — one image per page, saved to your downloads.${js.numPages > 1 ? " Your browser may ask to allow multiple downloads." : ""}`);
  panel.append(ctl, note); host.appendChild(panel);
  go.onclick = async () => {
    go.disabled = true; const f = fmt.value, sc = +scale.value;
    try {
      const files = await pdfToImageFiles(bytes, f, sc, safeName(name), (i, n) => status(host, `Rendering page ${i} of ${n}…`));
      for (const file of files) {
        await download(file.bytes, file.name, file.type);
        await new Promise(r => setTimeout(r, 220));
      }
      status(host, `Exported ${js.numPages} image${js.numPages !== 1 ? "s" : ""}. ${IS_NATIVE ? "Saved to your device." : "Check your downloads."}`, "ok");
    } catch (e) { status(host, friendly(e), "err"); }
    go.disabled = false;
  };
  const runImgZip = async () => {
    zipBtn.disabled = true; const f = fmt.value, sc = +scale.value;
    try {
      const files = await pdfToImageFiles(bytes, f, sc, safeName(name), (i, n) => status(host, `Rendering page ${i} of ${n}…`));
      status(host, "Zipping…");
      const zipSize = await downloadAsZip(files, `${safeName(name)}-images.zip`);
      status(host, `Downloaded a ZIP with ${js.numPages} image${js.numPages !== 1 ? "s" : ""} (${fmtBytes(zipSize)}).`, "ok");
    } catch (e) { status(host, friendly(e), "err"); }
    zipBtn.disabled = false;
  };
  zipBtn.onclick = () => gateProAction(zipBtn, "Download all as ZIP (Pro)", runImgZip);
}

// Core compress pipeline for ONE PDF's bytes → compressed PDF bytes. Shared by
// the single-file Compress tool and the multi-file batch path. `onProgress(i,n)`
// (optional) reports per-page progress so callers can drive their own status().
const COMPRESS_PRESETS = { high: { s: 1.1, q: 0.55 }, medium: { s: 1.5, q: 0.7 }, low: { s: 2.0, q: 0.82 } };
async function compressPdfBytes(bytes, level, onProgress) {
  const preset = COMPRESS_PRESETS[level] || COMPRESS_PRESETS.medium;
  const js = await loadForRender(bytes);
  const out = await PDFDocument.create();
  for (let i = 1; i <= js.numPages; i++) {
    if (onProgress) onProgress(i, js.numPages);
    const page = await js.getPage(i); const vp = page.getViewport({ scale: preset.s });
    const cv = el("canvas"); cv.width = Math.ceil(vp.width); cv.height = Math.ceil(vp.height);
    const cx = cv.getContext("2d"); cx.fillStyle = "#fff"; cx.fillRect(0, 0, cv.width, cv.height);
    await page.render({ canvasContext: cx, viewport: vp }).promise;
    const blob = await new Promise(r => cv.toBlob(r, "image/jpeg", preset.q));
    const jpg = await out.embedJpg(new Uint8Array(await blob.arrayBuffer()));
    const pg = out.addPage([vp.width / preset.s, vp.height / preset.s]);
    pg.drawImage(jpg, { x: 0, y: 0, width: pg.getWidth(), height: pg.getHeight() });
  }
  return await out.save();
}

// ── TOOL: Compress ──────────────────────────────────────────────────
// 1 file  → exactly today's behavior (free, single-file panel below).
// 2+ files → a file list + a Pro-gated "Process all N files" batch button that
//            runs compressPdfBytes() over each file and delivers one ZIP.
function toolCompress(host) {
  batchFileStage(host, {
    levelOptions: `<option value="low">Light — best quality, smaller shrink</option><option value="medium" selected>Recommended — balanced size &amp; quality</option><option value="high">Maximum — smallest file, lower quality</option>`,
    batchVerb: "compress",
    zipName: "local-pdf-batch-compress.zip",
    perFile: (bytes, name, level, onProgress) =>
      compressPdfBytes(bytes, level, onProgress).then((b) => ({ name: `${safeName(name)}-compressed.pdf`, bytes: b })),
    single: singleCompressPanel,
  });
}

// The flagship single-file Compress panel. Shrinks a PDF on-device to fit
// email/upload limits — no upload, ever. A "compression level" control maps to the
// existing scale+quality presets (Light / Recommended / Maximum). On run it
// computes the result IN MEMORY first so it can show BEFORE and AFTER sizes and the
// % saved, and — honestly — if the result isn't actually smaller it says so and
// offers to keep the untouched original instead of a bigger "compressed" file.
//
// FREE vs PRO split: compressing a single file at the DEFAULT "Recommended" level
// is FREE for everyone — no paywall, produces output. The ADVANCED level chooser
// (Light / Maximum) is the Pro control: a free user who picks a non-default level
// trips the EXISTING paywall. That gate mirrors Redact exactly: Billing.isPro()
// fast-path → refreshProStatus() (fails-open offline) → on a miss, revert the
// choice to "Recommended", stash re-applying their pick as the pending intent, and
// open the EXISTING paywall (showProModal). Batch stays Pro (see runBatch).
//
// Level labels map to the SAME preset keys used by the batch path (unchanged):
//   Light → "low"  ·  Recommended → "medium"  ·  Maximum → "high".
async function singleCompressPanel(host, bytes, name) {
  const js = await loadForRender(bytes);
  const totalPages = js.numPages;
  const beforeLen = bytes.length;

  const DEFAULT_LEVEL = "medium"; // "Recommended" — the free, unlocked level.

  const panel = el("div");
  const note = txt("div", "hint",
    `${name} — ${totalPages} page${totalPages !== 1 ? "s" : ""} · ${fmtBytes(beforeLen)}. Compressing re-renders each page as an image to shrink it, so it works best on scans and image-heavy PDFs. Selectable text becomes part of the image (no longer selectable), and everything runs on your device — nothing is uploaded.`);
  note.style.marginBottom = "12px";

  const ctl = el("div", "controls"); ctl.style.border = "0"; ctl.style.paddingTop = "0";
  const fLvl = el("div", "field"); fLvl.appendChild(txt("label", null, "Compression level"));
  const lvl = el("select");
  lvl.setAttribute("aria-label", "Compression level");
  // Order: gentlest → strongest. Value = the existing preset key so the shared
  // compressPdfBytes()/batch path is untouched. "Recommended" is the default and
  // the only level free users can run; the others carry a "(Pro)" hint in the label.
  lvl.innerHTML =
    `<option value="low">Light — best quality, smaller shrink (Pro)</option>` +
    `<option value="medium" selected>Recommended — balanced size &amp; quality</option>` +
    `<option value="high">Maximum — smallest file, lower quality (Pro)</option>`;
  fLvl.appendChild(lvl);
  const go = txt("button", "btn", "Compress"); go.type = "button";
  ctl.append(fLvl, el("div", "spacer"), go);
  panel.append(note, ctl); host.appendChild(panel);

  // Owner sees the advanced levels as plain (no "(Pro)" hint) since they're unlocked.
  if (safeBilling(() => Billing.isPro(), false)) {
    lvl.innerHTML =
      `<option value="low">Light — best quality, smaller shrink</option>` +
      `<option value="medium" selected>Recommended — balanced size &amp; quality</option>` +
      `<option value="high">Maximum — smallest file, lower quality</option>`;
  }

  // Where the before/after result card renders (below the controls).
  const resultHost = el("div"); panel.appendChild(resultHost);

  // The actual compress work. FREE at the default level; advanced levels only reach
  // here after the Pro gate on the level chooser has passed.
  async function runCompress() {
    // Enforce the Pro gate at the ACTION, not only on the level chooser. Closes a
    // TOCTOU race: picking an advanced level fires an async onchange gate, but the
    // Compress button stayed live during that round-trip, so a fast pick-then-click
    // could reach runCompress() with lvl.value still on the advanced preset before
    // the gate reverted it. Re-checking here means the aggressive output can never
    // be produced for a non-Pro user regardless of click timing. Mirrors the
    // chooser's own revert+paywall so the free flow (medium) and owners are unaffected.
    const chosenLevel = lvl.value;
    if (chosenLevel !== DEFAULT_LEVEL && !safeBilling(() => Billing.isPro(), false)) {
      go.disabled = true; lvl.disabled = true;
      const pro = await safeBillingAsync(() => Billing.refreshProStatus(), false);
      go.disabled = false; lvl.disabled = false;
      if (!pro) {
        lvl.value = DEFAULT_LEVEL; lvl.dataset.prev = DEFAULT_LEVEL;
        reconcileProAccess();
        setPendingIntent(() => { lvl.value = chosenLevel; lvl.dataset.prev = chosenLevel; });
        showProModal({ lead: "Choose an advanced compression level" });
        return;
      }
      markWasPro();
    }
    go.disabled = true; lvl.disabled = true; resultHost.innerHTML = "";
    try {
      const out = await compressPdfBytes(bytes, lvl.value, (i, n) => status(host, `Compressing page ${i} of ${n} on your device…`));
      const afterLen = out.length;
      clearInfo(host);
      const smaller = afterLen < beforeLen;
      const pct = Math.max(0, Math.round((1 - afterLen / beforeLen) * 100));
      renderCompressResult(resultHost, {
        name, beforeLen, afterLen, smaller, pct,
        onSaveCompressed: () => download(out, `${safeName(name)}-compressed.pdf`),
        onKeepOriginal: () => download(bytes, `${safeName(name)}.pdf`),
      });
    } catch (e) { status(host, friendly(e), "err"); }
    go.disabled = false; lvl.disabled = false;
  }

  // ADVANCED-control Pro gate — fires when a free user picks a non-default level.
  // Shape mirrors Redact's: fast-path isPro(); on a miss re-check via
  // refreshProStatus() (fails-open offline). Still not Pro → revert to the free
  // "Recommended" level, stash re-applying their pick as the pending intent (so it
  // sticks after unlock), and open the EXISTING paywall. Never unlocks silently.
  lvl.dataset.prev = DEFAULT_LEVEL;
  lvl.onchange = async () => {
    const chosen = lvl.value;
    if (chosen === DEFAULT_LEVEL) { lvl.dataset.prev = chosen; return; } // free level, no gate
    if (safeBilling(() => Billing.isPro(), false)) { markWasPro(); lvl.dataset.prev = chosen; return; }
    lvl.disabled = true;
    const pro = await safeBillingAsync(() => Billing.refreshProStatus(), false);
    lvl.disabled = false;
    if (pro) { markWasPro(); lvl.dataset.prev = chosen; return; }
    // Verified not-Pro: revert to the free default and paywall the advanced pick.
    lvl.value = DEFAULT_LEVEL; lvl.dataset.prev = DEFAULT_LEVEL;
    reconcileProAccess();
    setPendingIntent(() => { lvl.value = chosen; lvl.dataset.prev = chosen; });
    showProModal({ lead: "Choose an advanced compression level" });
  };

  // Compress runs freely — the level chooser is the only gated control here.
  go.onclick = () => { if (!go.disabled) runCompress(); };
}

// Render the before/after outcome of a compress run. Honest: when the result is
// NOT smaller, it leads with that and only offers the original — never a bigger
// "compressed" file. All values are numbers/derived strings (safe), and the
// filename shows only inside the download handler, never injected here.
function renderCompressResult(host, r) {
  host.innerHTML = "";
  const card = el("div", "compress-result");

  const stats = el("div", "compress-stats");
  const stat = (label, value, cls) => {
    const box = el("div", "compress-stat" + (cls ? " " + cls : ""));
    box.appendChild(txt("span", "compress-stat-label", label));
    box.appendChild(txt("span", "compress-stat-value", value));
    return box;
  };
  stats.appendChild(stat("Before", fmtBytes(r.beforeLen)));
  const arrow = el("div", "compress-arrow", '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="m13 6 6 6-6 6"/></svg>');
  arrow.setAttribute("aria-hidden", "true");
  stats.appendChild(arrow);
  stats.appendChild(stat("After", fmtBytes(r.afterLen)));
  if (r.smaller) stats.appendChild(stat("Saved", r.pct + "%", "compress-stat-saved"));
  card.appendChild(stats);

  // Honest headline + the right action(s).
  const actions = el("div", "compress-actions");
  if (r.smaller) {
    card.appendChild(txt("p", "compress-headline ok",
      `Nice — ${fmtBytes(r.beforeLen)} → ${fmtBytes(r.afterLen)}, ${r.pct}% smaller.`));
    const save = txt("button", "btn", "Download compressed PDF"); save.type = "button";
    save.onclick = () => r.onSaveCompressed();
    const keep = txt("button", "btn ghost", "Keep the original instead"); keep.type = "button";
    keep.onclick = () => r.onKeepOriginal();
    actions.append(save, keep);
  } else {
    card.appendChild(txt("p", "compress-headline",
      `This PDF was already well-optimized — compressing it wouldn't make it smaller (it would be ${fmtBytes(r.afterLen)} vs ${fmtBytes(r.beforeLen)}). Your original is best kept as-is.`));
    const keep = txt("button", "btn", "Keep the original"); keep.type = "button";
    keep.onclick = () => r.onKeepOriginal();
    actions.append(keep);
  }
  card.appendChild(actions);
  host.appendChild(card);
}

// ── TOOL: Search text (full-text search inside a PDF) ───────────────
// Extracts text per page with pdf.js getTextContent(), then does a live,
// case-insensitive substring search and lists every match as
// page number + a short in-context snippet, grouped by filename.
// Multiple files are supported (bonus): search runs across all of them.
// SECURITY: query text and snippets are attacker/file-derived, so they are
// ALWAYS written via textContent — the highlighted <mark> is built from
// DOM text nodes, never innerHTML.
function toolSearch(host) {
  const docs = []; // { name, pages: [pageText, …] }  (index 0 = page 1)
  const zone = dropZone("application/pdf", true, addFiles);
  const list = el("div", "filelist");

  // Search bar (hidden until at least one PDF is loaded).
  const bar = el("div", "controls hidden"); bar.style.paddingTop = "18px";
  const qF = el("div", "field"); qF.style.flex = "1"; qF.style.minWidth = "220px";
  qF.appendChild(txt("label", null, "Search for"));
  const qIn = el("input"); qIn.type = "search"; qIn.placeholder = "Type a word or phrase…"; qIn.autocomplete = "off";
  qF.appendChild(qIn);
  const clearBtn = txt("button", "btn ghost sm", "Clear all"); clearBtn.type = "button";
  clearBtn.onclick = () => { docs.length = 0; qIn.value = ""; renderFiles(); runSearch(); };
  bar.append(qF, el("div", "spacer"), clearBtn);

  const results = el("div", "search-results");
  host.append(zone, list, bar, results);

  async function addFiles(files) {
    let failed = false;
    for (const file of files) {
      status(host, `Reading "${file.name}"…`);
      try {
        const bytes = await readBytes(file);
        const pages = await extractPageText(bytes);
        docs.push({ name: file.name, pages });
      } catch (e) { status(host, `"${file.name}" — ${friendly(e)}`, "err"); failed = true; }
    }
    // clearInfo only exists to drop the transient "Reading…" spinner — it must
    // NOT wipe a real error. If any file failed (corrupt / password-protected /
    // one bad file in a batch), keep the error visible instead of going silent.
    if (!failed) clearInfo(host);
    renderFiles();
    runSearch();
  }

  // Read every page's text once so subsequent searches are instant.
  async function extractPageText(bytes) {
    const js = await loadForRender(bytes);
    const pages = [];
    for (let i = 1; i <= js.numPages; i++) {
      const page = await js.getPage(i);
      const content = await page.getTextContent();
      pages.push(content.items.map((it) => it.str).join(" "));
    }
    return pages;
  }

  function renderFiles() {
    list.innerHTML = "";
    docs.forEach((d, i) => {
      const total = d.pages.length;
      const row = fileRow(d.name, `${total} page${total !== 1 ? "s" : ""} · text loaded`, () => { docs.splice(i, 1); renderFiles(); runSearch(); });
      row.draggable = false;                    // order is irrelevant for search
      const grip = $(".grip", row); if (grip) grip.remove();
      list.appendChild(row);
    });
    bar.classList.toggle("hidden", docs.length === 0);
  }

  function runSearch() {
    results.innerHTML = "";
    const raw = qIn.value.trim();
    if (!docs.length || !raw) return;           // nothing loaded, or empty query
    const needle = raw.toLowerCase();

    let totalMatches = 0;
    const groups = []; // { name, hits: [{ page, snippets: [{before,match,after}] }] }
    for (const d of docs) {
      const hits = [];
      d.pages.forEach((text, pi) => {
        const spans = findMatches(text, needle);
        if (spans.length) { totalMatches += spans.length; hits.push({ page: pi + 1, snippets: spans.map((s) => snippet(text, s.start, s.end)) }); }
      });
      if (hits.length) groups.push({ name: d.name, hits });
    }

    // Summary line up top.
    const summary = el("div", "search-summary");
    if (totalMatches === 0) {
      summary.classList.add("none");
      summary.appendChild(txt("span", null, "No matches"));
      summary.appendChild(txt("span", "search-sum-sub", "That word or phrase isn't in "  + (docs.length > 1 ? "any of these PDFs." : "this PDF.")));
      results.appendChild(summary);
      return;
    }
    const pageCount = groups.reduce((n, g) => n + g.hits.length, 0);
    summary.appendChild(txt("span", null, `${totalMatches} match${totalMatches !== 1 ? "es" : ""} on ${pageCount} page${pageCount !== 1 ? "s" : ""}`));
    results.appendChild(summary);

    // Grouped results.
    for (const g of groups) {
      if (docs.length > 1) {
        const gh = el("div", "search-group-head");
        gh.appendChild(txt("span", "search-file", g.name)); // SAFE: textContent
        results.appendChild(gh);
      }
      for (const hit of g.hits) {
        for (const sn of hit.snippets) {
          const item = el("div", "search-hit");
          const badge = txt("span", "search-page", `Page ${hit.page}`);
          const line = el("span", "search-snippet");
          line.appendChild(document.createTextNode(sn.before));   // SAFE
          const mark = txt("mark", null, sn.match);               // SAFE: highlighted term
          line.appendChild(mark);
          line.appendChild(document.createTextNode(sn.after));    // SAFE
          item.append(badge, line);
          results.appendChild(item);
        }
      }
    }
  }

  // All (case-insensitive) occurrences of needle in text → [{start,end}].
  // needle is already lower-cased; text is lower-cased once for scanning while
  // offsets index back into the ORIGINAL text so the snippet keeps real casing.
  function findMatches(text, needle) {
    const spans = [];
    if (!needle) return spans;
    const hay = text.toLowerCase();
    let from = 0;
    while (true) {
      const at = hay.indexOf(needle, from);
      if (at === -1) break;
      spans.push({ start: at, end: at + needle.length });
      from = at + needle.length;               // non-overlapping, forward-progressing
    }
    return spans;
  }

  // ~40 chars of context on each side, trimmed to word-ish boundaries with ellipses.
  function snippet(text, start, end) {
    const PAD = 40;
    let a = Math.max(0, start - PAD), b = Math.min(text.length, end + PAD);
    let before = text.slice(a, start), match = text.slice(start, end), after = text.slice(end, b);
    before = (a > 0 ? "…" : "") + before.replace(/\s+/g, " ").replace(/^\S*\s/, a > 0 ? "" : "$&");
    after = after.replace(/\s+/g, " ").replace(/\s\S*$/, b < text.length ? "" : "$&") + (b < text.length ? "…" : "");
    return { before, match, after };
  }

  // Live search as the user types (debounced so long docs stay responsive).
  let t = null;
  qIn.addEventListener("input", () => { clearTimeout(t); t = setTimeout(runSearch, 120); });
  qIn.addEventListener("search", runSearch);   // fires on the native "search" clear (×)
}

// ── TOOL: Extract text → .txt ───────────────────────────────────────
// Pulls every page's text out of a PDF with pdf.js getTextContent() (the same
// extractor the Search tool uses), joins the pages with a "--- Page N ---"
// separator, and saves it as <name>.txt. FREE — no Pro gate. The extracted text
// is the user's own file data and never leaves the device; it is only ever put
// into DOM via textContent (status strings), never innerHTML, so it is XSS-safe.
function toolExtractText(host) {
  singleFileStage(host, async (bytes, name) => {
    const js = await loadForRender(bytes);
    const panel = el("div");
    const note = txt("div", "hint", `${name} — ${js.numPages} page${js.numPages !== 1 ? "s" : ""}. Pulls all selectable text into a plain .txt file. Scanned PDFs with no text layer will come out empty.`);
    note.style.marginBottom = "12px";
    const ctl = el("div", "controls"); ctl.style.border = "0"; ctl.style.paddingTop = "0";
    const go = txt("button", "btn", "Extract text & download");
    ctl.append(el("div", "spacer"), go);
    panel.append(note, ctl); host.appendChild(panel);
    go.onclick = async () => {
      go.disabled = true;
      try {
        const parts = [];
        for (let i = 1; i <= js.numPages; i++) {
          status(host, `Extracting text — page ${i} of ${js.numPages}…`);
          const page = await js.getPage(i);
          const content = await page.getTextContent();
          // Same join pdf.js text extraction uses in Search; page separator marks each page.
          parts.push(`--- Page ${i} ---\n\n` + content.items.map((it) => it.str).join(" "));
        }
        const text = parts.join("\n\n");
        // Reuse download(): it forces application/octet-stream internally (Safari
        // workaround) and the .txt extension makes it open as plain text.
        await download(new TextEncoder().encode(text), `${safeName(name)}.txt`, "text/plain");
        status(host, `Extracted text from ${js.numPages} page${js.numPages !== 1 ? "s" : ""} (~${text.length.toLocaleString()} characters). ${IS_NATIVE ? "Saved to your device." : "Saved to your downloads."}`, "ok");
      } catch (e) { status(host, friendly(e), "err"); }
      go.disabled = false;
    };
  });
}

// ── TOOL: Add page numbers ──────────────────────────────────────────
// Stamps a running page number onto every page of a PDF using pdf-lib's
// page.drawText with an embedded StandardFonts.Helvetica. FREE — no Pro gate.
// The number is placed at the chosen VISUAL corner with a fixed margin; each
// page's own rotation and size are respected so the stamp reads upright and
// sits in the right corner even on rotated/mixed-size pages. Nothing about the
// user's file leaves the device — everything runs through the same in-browser
// pdf-lib the other tools use, and the output goes out via download().
const PAGENUM_MARGIN = 28;                                   // pt from each edge
const PAGENUM_SIZES = { small: 9, medium: 12, large: 16 };  // font size in pt

// One page-number string for page `i` (1-based within the run) of `total`,
// starting at `start`. Pure/string-only so the live hint and the actual stamp
// share the exact same wording.
function pageNumberLabel(fmt, i, total, start) {
  const n = start + (i - 1);
  const last = start + total - 1;
  if (fmt === "page") return "Page " + n;
  if (fmt === "n-of-n") return n + " of " + last;
  if (fmt === "n-slash-n") return n + " / " + last;
  return String(n);                                          // "plain"
}

// Given an unrotated page box (pw×ph), its rotation, the measured text extent
// (tw×th), and a VISUAL position like "bottom-right", return the unrotated
// drawText anchor (x,y) plus the text angle so the glyphs read upright in the
// viewer's frame. Kept separate + pure so it's easy to reason about/verify.
function pageNumberPlacement(pw, ph, rot, tw, th, pos) {
  const [vert, horiz] = pos.split("-");                     // e.g. ["bottom","right"]
  const r = ((rot % 360) + 360) % 360;
  const swap = (r === 90 || r === 270);
  const vw = swap ? ph : pw;                                 // visual (post-rotation) dims
  const vh = swap ? pw : ph;
  const m = PAGENUM_MARGIN;
  // Baseline-left anchor of the text in the VISUAL frame (origin bottom-left).
  const vx = horiz === "left" ? m : horiz === "right" ? vw - m - tw : (vw - tw) / 2;
  const vy = vert === "top" ? vh - m - th : m;
  // Map the visual anchor back into unrotated page coordinates.
  if (r === 90)  return { x: vy,       y: ph - vx,  angle: 90 };
  if (r === 180) return { x: pw - vx,  y: ph - vy,  angle: 180 };
  if (r === 270) return { x: pw - vy,  y: vx,       angle: 270 };
  return { x: vx, y: vy, angle: 0 };
}

function toolAddPageNumbers(host) {
  singleFileStage(host, async (bytes, name) => {
    // Load once to learn the page count for the live hint; the actual stamp
    // re-loads fresh bytes at run time (same pattern as the other edit tools).
    const probe = await loadForEdit(bytes);
    const total = probe.getPageCount();

    const panel = el("div");
    const note = el("div", "hint");
    note.style.marginBottom = "14px";
    note.append(document.createTextNode("Loaded "), txt("b", null, name),
      document.createTextNode(` — ${total} page${total !== 1 ? "s" : ""}. Numbers are drawn onto every page and saved as a new PDF; your original file is untouched.`));

    const ctl = el("div", "controls"); ctl.style.border = "0"; ctl.style.paddingTop = "0";

    const fPos = el("div", "field"); fPos.appendChild(txt("label", null, "Position"));
    const pos = el("select");
    pos.innerHTML = `<option value="bottom-center" selected>Bottom center</option>` +
      `<option value="bottom-right">Bottom right</option>` +
      `<option value="bottom-left">Bottom left</option>` +
      `<option value="top-center">Top center</option>` +
      `<option value="top-right">Top right</option>` +
      `<option value="top-left">Top left</option>`;
    fPos.appendChild(pos);

    const fFmt = el("div", "field"); fFmt.appendChild(txt("label", null, "Format"));
    const fmt = el("select");
    fmt.innerHTML = `<option value="plain" selected>1</option>` +
      `<option value="page">Page 1</option>` +
      `<option value="n-of-n">1 of N</option>` +
      `<option value="n-slash-n">1 / N</option>`;
    fFmt.appendChild(fmt);

    const fStart = el("div", "field"); fStart.appendChild(txt("label", null, "Start at"));
    const start = el("input"); start.type = "number"; start.min = "0"; start.step = "1"; start.value = "1";
    start.style.width = "90px"; start.inputMode = "numeric";
    fStart.appendChild(start);

    const fSize = el("div", "field"); fSize.appendChild(txt("label", null, "Font size"));
    const size = el("select");
    size.innerHTML = `<option value="small">Small</option><option value="medium" selected>Medium</option><option value="large">Large</option>`;
    fSize.appendChild(size);

    const go = txt("button", "btn", "Add page numbers & download");
    ctl.append(fPos, fFmt, fStart, fSize, el("div", "spacer"), go);

    // Live preview hint: "N pages — numbers will read like '<preview>'".
    const preview = el("div", "hint"); preview.style.marginTop = "12px";
    function startNum() { const v = parseInt(start.value, 10); return Number.isFinite(v) ? v : 1; }
    function updatePreview() {
      const s = startNum();
      const sample = pageNumberLabel(fmt.value, 1, total, s);
      preview.textContent = "";
      preview.append(
        document.createTextNode(`${total} page${total !== 1 ? "s" : ""} — numbers will read like `),
        txt("b", null, `“${sample}”`),               // SAFE: textContent
        document.createTextNode(total > 1 ? `, up to “${pageNumberLabel(fmt.value, total, total, s)}”.` : ".")
      );
    }
    [pos, fmt, size].forEach((n) => n.addEventListener("change", updatePreview));
    start.addEventListener("input", updatePreview);
    updatePreview();

    panel.append(note, ctl, preview); host.appendChild(panel);

    go.onclick = async () => {
      go.disabled = true;
      try {
        status(host, "Stamping page numbers on your device…");
        const doc = await loadForEdit(bytes);
        const font = await doc.embedFont(StandardFonts.Helvetica);
        const fontSize = PAGENUM_SIZES[size.value] || PAGENUM_SIZES.medium;
        const th = font.heightAtSize(fontSize);
        const s = startNum();
        const positionVal = pos.value, fmtVal = fmt.value;
        const pages = doc.getPages();
        pages.forEach((page, idx) => {
          const label = pageNumberLabel(fmtVal, idx + 1, total, s);
          const tw = font.widthOfTextAtSize(label, fontSize);
          const { width, height } = page.getSize();          // unrotated MediaBox
          const rotAngle = page.getRotation().angle || 0;
          const { x, y, angle } = pageNumberPlacement(width, height, rotAngle, tw, th, positionVal);
          page.drawText(label, {
            x, y, size: fontSize, font,
            color: rgb(0.1, 0.1, 0.12),
            rotate: degrees(angle),
          });
        });
        const out = await doc.save();
        await download(out, `${safeName(name)}-numbered.pdf`);
        status(host, `Done — numbered ${total} page${total !== 1 ? "s" : ""} (${fmtBytes(out.length)}). ${IS_NATIVE ? "Saved to your device." : "Saved to your downloads."}`, "ok");
      } catch (e) { status(host, friendly(e), "err"); }
      go.disabled = false;
    };
  });
}

// ── TOOL: Remove metadata (privacy clean-up) ────────────────────────
// Loads the PDF and clears the identifying document-info fields (title,
// author, subject, keywords, producer, creator) plus the creation/mod dates,
// then saves a fresh "-clean.pdf". This scrubs the hidden metadata a viewer or
// "Document Properties" panel would otherwise reveal — a quick privacy win.
// FREE — no Pro gate. Nothing about the file leaves the device; it runs through
// the same in-browser pdf-lib as every other edit tool, and the download goes
// out via download(). The user's page content is untouched — only the metadata.
function toolRemoveMetadata(host) {
  singleFileStage(host, async (bytes, name) => {
    const probe = await loadForEdit(bytes);
    const total = probe.getPageCount();

    const panel = el("div");
    const note = el("div", "hint"); note.style.marginBottom = "14px";
    note.append(document.createTextNode("Loaded "), txt("b", null, name),
      document.createTextNode(` — ${total} page${total !== 1 ? "s" : ""}. This clears hidden document info — author, title, subject, keywords, and the app that created it — then saves a clean copy. Your pages and your original file are untouched.`));

    const ctl = el("div", "controls"); ctl.style.border = "0"; ctl.style.paddingTop = "0";
    const go = txt("button", "btn", "Remove metadata & download"); go.type = "button";
    ctl.append(el("div", "spacer"), go);
    panel.append(note, ctl); host.appendChild(panel);

    go.onclick = async () => {
      go.disabled = true;
      try {
        status(host, "Clearing metadata on your device…");
        // Re-load fresh bytes (same pattern as the other edit tools).
        const doc = await loadForEdit(bytes);
        // Clear every identifying document-info field.
        doc.setTitle("");
        doc.setAuthor("");
        doc.setSubject("");
        doc.setKeywords([]);
        doc.setProducer("");
        doc.setCreator("");
        // The timestamps are metadata too — neutralize them to the same instant so
        // no create/modify history leaks. (pdf-lib always writes a ModDate on save.)
        const epoch = new Date(0);
        try { doc.setCreationDate(epoch); doc.setModificationDate(epoch); } catch {}
        const out = await doc.save();
        await download(out, `${safeName(name)}-clean.pdf`);
        status(host, `Done — metadata cleared and saved as a clean copy (${fmtBytes(out.length)}). Your original file is unchanged.`, "ok");
      } catch (e) { status(host, friendly(e), "err"); }
      go.disabled = false;
    };
  });
}

// ── TOOL: Watermark / stamp ─────────────────────────────────────────
// Stamps a user-typed watermark (e.g. "DRAFT", "CONFIDENTIAL", a name) onto
// EVERY page using pdf-lib's page.drawText with a chosen size, opacity, and
// layout (centered horizontally, or a large diagonal band across the page).
// FREE — no Pro gate. The watermark text is the user's own input and is only
// ever passed to pdf-lib's drawText (which draws glyphs, not markup) and to the
// live preview via textContent — never innerHTML. Everything runs in-browser and
// the output goes out via download(); the original file is untouched.
const WATERMARK_SIZES = { small: 28, medium: 48, large: 72 };
const WATERMARK_OPACITIES = { light: 0.12, medium: 0.22, strong: 0.38 };

function toolWatermark(host) {
  singleFileStage(host, async (bytes, name) => {
    const probe = await loadForEdit(bytes);
    const total = probe.getPageCount();

    const panel = el("div");
    const note = el("div", "hint"); note.style.marginBottom = "14px";
    note.append(document.createTextNode("Loaded "), txt("b", null, name),
      document.createTextNode(` — ${total} page${total !== 1 ? "s" : ""}. Your text is stamped onto every page and saved as a new PDF; your original file is untouched.`));

    const fText = el("div", "field"); fText.style.flex = "1"; fText.style.minWidth = "200px";
    fText.appendChild(txt("label", null, "Watermark text"));
    const textIn = el("input"); textIn.type = "text"; textIn.value = "DRAFT";
    textIn.maxLength = 60; textIn.autocomplete = "off"; textIn.spellcheck = false;
    textIn.setAttribute("aria-label", "Watermark text");
    fText.appendChild(textIn);

    const ctl = el("div", "controls"); ctl.style.border = "0"; ctl.style.paddingTop = "0";
    const fPos = el("div", "field"); fPos.appendChild(txt("label", null, "Position"));
    const pos = el("select");
    pos.innerHTML = `<option value="diagonal" selected>Diagonal band</option><option value="center">Center</option>`;
    fPos.appendChild(pos);

    const fSize = el("div", "field"); fSize.appendChild(txt("label", null, "Size"));
    const size = el("select");
    size.innerHTML = `<option value="small">Small</option><option value="medium" selected>Medium</option><option value="large">Large</option>`;
    fSize.appendChild(size);

    const fOpacity = el("div", "field"); fOpacity.appendChild(txt("label", null, "Opacity"));
    const opacity = el("select");
    opacity.innerHTML = `<option value="light">Light</option><option value="medium" selected>Medium</option><option value="strong">Strong</option>`;
    fOpacity.appendChild(opacity);

    const go = txt("button", "btn", "Add watermark & download"); go.type = "button";
    ctl.append(fPos, fSize, fOpacity, el("div", "spacer"), go);

    // Live preview line so the user sees exactly what will be stamped.
    const preview = el("div", "hint"); preview.style.marginTop = "12px";
    function updatePreview() {
      const t = textIn.value.trim();
      preview.textContent = "";
      if (!t) { preview.append(document.createTextNode("Type some watermark text to stamp on every page.")); return; }
      preview.append(
        document.createTextNode(`Every page will be stamped with `),
        txt("b", null, `“${t}”`),                       // SAFE: textContent
        document.createTextNode(pos.value === "diagonal" ? " on a diagonal band." : " centered on the page.")
      );
    }
    [pos].forEach((n) => n.addEventListener("change", updatePreview));
    textIn.addEventListener("input", updatePreview);
    updatePreview();

    panel.append(fText, ctl, preview); host.appendChild(panel);

    go.onclick = async () => {
      const label = textIn.value.trim();
      if (!label) { status(host, "Type some watermark text first.", "err"); return; }
      go.disabled = true;
      try {
        status(host, "Stamping watermark on your device…");
        const doc = await loadForEdit(bytes);
        const font = await doc.embedFont(StandardFonts.HelveticaBold);
        const fontSize = WATERMARK_SIZES[size.value] || WATERMARK_SIZES.medium;
        const op = WATERMARK_OPACITIES[opacity.value] || WATERMARK_OPACITIES.medium;
        const diagonal = pos.value === "diagonal";
        const th = font.heightAtSize(fontSize);
        const pages = doc.getPages();
        pages.forEach((page) => {
          const { width, height } = page.getSize();     // unrotated MediaBox
          const tw = font.widthOfTextAtSize(label, fontSize);
          if (diagonal) {
            // Place along the page diagonal, centered: rotate 45° about the page
            // center and offset back by half the text extent so it reads centered.
            const angle = Math.atan2(height, width);    // radians, bottom-left → top-right
            const cx = width / 2, cy = height / 2;
            const x = cx - (tw / 2) * Math.cos(angle) + (th / 2) * Math.sin(angle);
            const y = cy - (tw / 2) * Math.sin(angle) - (th / 2) * Math.cos(angle);
            page.drawText(label, {
              x, y, size: fontSize, font,
              color: rgb(0.5, 0.5, 0.55), opacity: op,
              rotate: radians(angle),
            });
          } else {
            page.drawText(label, {
              x: (width - tw) / 2, y: (height - th) / 2, size: fontSize, font,
              color: rgb(0.5, 0.5, 0.55), opacity: op,
            });
          }
        });
        const out = await doc.save();
        await download(out, `${safeName(name)}-watermarked.pdf`);
        status(host, `Done — watermarked ${total} page${total !== 1 ? "s" : ""} (${fmtBytes(out.length)}). ${IS_NATIVE ? "Saved to your device." : "Saved to your downloads."}`, "ok");
      } catch (e) { status(host, friendly(e), "err"); }
      go.disabled = false;
    };
  });
}

// ── TOOL: Fill & flatten forms ──────────────────────────────────────
// Loads the PDF's AcroForm via pdf-lib's getForm(), renders each fillable field
// as a native control (text field → text input, checkbox → checkbox, dropdown /
// option-list → select), lets the user fill them in, then writes the values back
// and calls form.flatten() so the answers are baked into the page and no longer
// editable. Saves "<name>-filled.pdf". FREE — no Pro gate. Field names and option
// text are file-derived, so they are ALWAYS written via textContent, never
// innerHTML. Everything runs in-browser; the original file is untouched.
function toolFillForms(host) {
  singleFileStage(host, async (bytes, name) => {
    const doc = await loadForEdit(bytes);
    const form = doc.getForm();
    const fields = form.getFields();

    const panel = el("div");
    const note = el("div", "hint"); note.style.marginBottom = "14px";

    // No fillable fields → clear, honest message and stop (no controls, no button).
    if (!fields.length) {
      note.append(document.createTextNode("Loaded "), txt("b", null, name),
        document.createTextNode(" — this PDF has no fillable form fields, so there's nothing to fill in here. If you need to add text on top of the page, try the Watermark / stamp or Add page numbers tools."));
      panel.append(note); host.appendChild(panel);
      return;
    }

    note.append(document.createTextNode("Loaded "), txt("b", null, name),
      document.createTextNode(` — ${fields.length} form field${fields.length !== 1 ? "s" : ""}. Fill them in below, then flatten to bake your answers into the PDF so they can no longer be edited. Your original file is untouched.`));
    panel.append(note);

    // Build a control per field. `readers` collects apply-callbacks run at save time.
    const formEl = el("div", "fillform");
    const readers = [];            // () => void  — writes the UI value back into the field
    let controlIndex = 0;

    // Detect field type by FEATURE (which methods exist), not constructor.name —
    // the vendored pdf-lib is minified, so class names are mangled and unreliable.
    // Checkbox → isChecked/check ; text → setText ; choice (dropdown/list/radio)
    // → getOptions/select. Anything unrecognized degrades to a read-only note.
    const has = (f, m) => { try { return typeof f[m] === "function"; } catch { return false; } };

    fields.forEach((field) => {
      const isCheckbox = has(field, "isChecked") && has(field, "check");
      const isText = !isCheckbox && has(field, "setText");
      const isChoice = !isCheckbox && !isText && has(field, "getOptions") && has(field, "select");
      const fieldName = (() => { try { return field.getName(); } catch { return ""; } })();
      controlIndex++;
      const rowId = "fillfield-" + controlIndex;

      const row = el("div", "field fillfield-row");
      const lbl = txt("label", null, fieldName || ("Field " + controlIndex));  // SAFE: textContent
      lbl.setAttribute("for", rowId);

      if (isCheckbox) {
        const wrap = el("div", "fillfield-check");
        const cb = el("input"); cb.type = "checkbox"; cb.id = rowId;
        try { if (field.isChecked()) cb.checked = true; } catch {}
        cb.setAttribute("aria-label", fieldName || ("Checkbox " + controlIndex));
        wrap.append(cb);
        // For checkboxes the label sits beside the box, so append it after.
        row.append(wrap, lbl);
        readers.push(() => { try { cb.checked ? field.check() : field.uncheck(); } catch {} });
      } else if (isChoice) {
        // Dropdowns, option lists, and radio groups all expose getOptions()/select();
        // a single <select> covers all three. getSelected() returns an array for
        // dropdown/list and a string for radio, so handle both shapes.
        const sel = el("select"); sel.id = rowId;
        sel.setAttribute("aria-label", fieldName || ("Choice " + controlIndex));
        let options = [];
        try { options = field.getOptions() || []; } catch { options = []; }
        // Leading blank so "no selection" is possible.
        sel.appendChild(txt("option", null, ""));                  // value "" via textContent
        options.forEach((opt) => { const o = txt("option", null, String(opt)); o.value = String(opt); sel.appendChild(o); }); // SAFE: textContent
        let current = "";
        try { const s = field.getSelected && field.getSelected(); if (s != null) current = String(Array.isArray(s) ? (s[0] || "") : s); } catch {}
        if (current) sel.value = current;
        row.append(lbl, sel);
        readers.push(() => { try { if (sel.value) field.select(sel.value); } catch {} });
      } else if (isText) {
        const inp = el("input"); inp.type = "text"; inp.id = rowId;
        inp.autocomplete = "off";
        inp.setAttribute("aria-label", fieldName || ("Text field " + controlIndex));
        try { const v = field.getText && field.getText(); if (v) inp.value = v; } catch {}
        row.append(lbl, inp);
        readers.push(() => { try { field.setText(inp.value); } catch {} });
      } else {
        // Unrecognized field kind (e.g. a signature or button field): show it,
        // read-only, so the user still sees it exists but we don't guess a control.
        row.append(lbl);
        row.appendChild(txt("span", "hint", "(this field type can't be filled here — it will be kept as-is)"));
      }
      formEl.appendChild(row);
    });
    panel.appendChild(formEl);

    const ctl = el("div", "controls"); ctl.style.paddingTop = "16px";
    const go = txt("button", "btn", "Fill, flatten & download"); go.type = "button";
    ctl.append(el("div", "spacer"), go);
    panel.appendChild(ctl);
    host.appendChild(panel);

    go.onclick = async () => {
      go.disabled = true;
      try {
        status(host, "Filling and flattening on your device…");
        // Write every UI value back into its field, then flatten so the values are
        // painted into the page content and the interactive fields are removed.
        readers.forEach((apply) => apply());
        try { form.flatten(); } catch (e) { /* flatten can throw on exotic forms */ throw e; }
        const out = await doc.save();
        await download(out, `${safeName(name)}-filled.pdf`);
        status(host, `Done — filled and flattened ${fields.length} field${fields.length !== 1 ? "s" : ""} (${fmtBytes(out.length)}). The values are now baked in and can't be edited.`, "ok");
      } catch (e) { status(host, friendly(e), "err"); }
      go.disabled = false;
    };
  });
}

// ── TOOL: Sign PDF ──────────────────────────────────────────────────
// The user creates a signature two ways — DRAW it on a small canvas (pointer /
// touch), or UPLOAD a PNG/JPG signature image — then picks the target page and a
// position (click a live page preview to drop it, or choose a corner) plus a
// size, and it's embedded onto that page via pdf-lib (embedPng/embedJpg +
// page.drawImage). Saves "<name>-signed.pdf". FREE — no Pro gate. Privacy-framed:
// the whole thing runs in-browser, so you sign without uploading your document
// anywhere. The filename is only ever written via textContent, never innerHTML.
function toolSign(host) {
  singleFileStage(host, async (bytes, name) => {
    const js = await loadForRender(bytes);          // pdf.js — for the page preview
    const probe = await loadForEdit(bytes);         // pdf-lib — page count / sizes
    const total = probe.getPageCount();

    const panel = el("div");
    const note = el("div", "hint"); note.style.marginBottom = "14px";
    note.append(document.createTextNode("Loaded "), txt("b", null, name),
      document.createTextNode(` — ${total} page${total !== 1 ? "s" : ""}. Draw or upload your signature, then click the page preview (or pick a corner) to place it. Sign without uploading your document anywhere — everything happens on your device.`));
    panel.appendChild(note);

    // ── Signature source: DRAW or UPLOAD (segmented) ──────────────────
    // sigImage holds the current signature as an HTMLImage- or canvas-sourced
    // bitmap plus its natural aspect ratio; sigBytes/sigIsPng feed pdf-lib.
    let sigBytes = null;     // Uint8Array (PNG for drawn, original for uploaded)
    let sigIsPng = true;     // true → embedPng, false → embedJpg
    let sigAspect = 3;       // width / height of the signature bitmap
    let sigPreviewURL = null;

    const modeWrap = el("div", "sign-modes"); modeWrap.setAttribute("role", "group");
    modeWrap.setAttribute("aria-label", "Signature source");
    const drawBtn = txt("button", "seg-btn", "Draw"); drawBtn.type = "button";
    const upBtn = txt("button", "seg-btn", "Upload image"); upBtn.type = "button";
    drawBtn.setAttribute("aria-pressed", "true"); upBtn.setAttribute("aria-pressed", "false");
    modeWrap.append(drawBtn, upBtn);
    panel.appendChild(modeWrap);

    // Draw surface (a small signature pad). Coordinates are captured with pointer
    // events so it works for mouse, pen, and touch alike.
    const drawWrap = el("div", "sign-draw-wrap");
    const pad = el("canvas", "sign-pad");
    pad.width = 480; pad.height = 160;
    pad.setAttribute("role", "img");
    pad.setAttribute("aria-label", "Signature drawing pad — draw your signature here");
    pad.setAttribute("tabindex", "0");
    const pctx = pad.getContext("2d");
    pctx.lineWidth = 2.6; pctx.lineCap = "round"; pctx.lineJoin = "round";
    // Ink colour is a fixed dark ink (not themed) — the signature is baked into the
    // PDF, so it must stay dark on white regardless of the app's light/dark theme.
    function padStroke() { pctx.strokeStyle = "#111318"; }
    padStroke();
    let drawing = false, hasInk = false, lastX = 0, lastY = 0;
    function padPos(e) {
      const r = pad.getBoundingClientRect();
      return { x: (e.clientX - r.left) * (pad.width / r.width), y: (e.clientY - r.top) * (pad.height / r.height) };
    }
    function startDraw(e) { drawing = true; const p = padPos(e); lastX = p.x; lastY = p.y; e.preventDefault(); }
    function moveDraw(e) {
      if (!drawing) return;
      const p = padPos(e);
      pctx.beginPath(); pctx.moveTo(lastX, lastY); pctx.lineTo(p.x, p.y); pctx.stroke();
      lastX = p.x; lastY = p.y; hasInk = true; e.preventDefault();
      captureDrawn();
    }
    function endDraw() { drawing = false; }
    pad.addEventListener("pointerdown", startDraw);
    pad.addEventListener("pointermove", moveDraw);
    window.addEventListener("pointerup", endDraw);
    const padRow = el("div", "sign-pad-row");
    const clearPad = txt("button", "btn ghost sm", "Clear"); clearPad.type = "button";
    clearPad.onclick = () => { pctx.clearRect(0, 0, pad.width, pad.height); padStroke(); hasInk = false; sigBytes = null; refreshPlaceUI(); };
    padRow.append(clearPad);
    drawWrap.append(pad, padRow);
    panel.appendChild(drawWrap);

    // Turn the current pad drawing into PNG bytes for embedding. Called live as the
    // user draws so a placement is always ready.
    function captureDrawn() {
      if (!hasInk) { sigBytes = null; return; }
      const url = pad.toDataURL("image/png");
      // dataURL → bytes without a network round-trip.
      const b64 = url.split(",")[1];
      const bin = atob(b64); const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      sigBytes = arr; sigIsPng = true; sigAspect = pad.width / pad.height;
      refreshPlaceUI();
    }

    // Upload surface (hidden until "Upload image" chosen).
    const upWrap = el("div", "sign-upload-wrap hidden");
    const upInput = el("input"); upInput.type = "file"; upInput.accept = "image/png,image/jpeg";
    upInput.className = "hidden"; upInput.setAttribute("aria-label", "Upload a signature image (PNG or JPG)");
    const upPick = txt("button", "btn ghost", "Choose signature image"); upPick.type = "button";
    upPick.onclick = () => upInput.click();
    const upThumbWrap = el("div", "sign-up-thumb");
    upWrap.append(upPick, upInput, upThumbWrap);
    panel.appendChild(upWrap);

    upInput.addEventListener("change", async () => {
      const f = upInput.files && upInput.files[0]; upInput.value = "";
      if (!f) return;
      try {
        const b = await readBytes(f);
        const isPng = /\.png$/i.test(f.name) || f.type === "image/png";
        // Measure natural aspect + render a small preview.
        const url = URL.createObjectURL(new Blob([b]));
        const im = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error("IMG")); i.src = url; });
        sigAspect = (im.naturalWidth || 3) / (im.naturalHeight || 1);
        sigBytes = b; sigIsPng = isPng;
        if (sigPreviewURL) URL.revokeObjectURL(sigPreviewURL);
        sigPreviewURL = url;
        upThumbWrap.textContent = "";
        const timg = el("img", "sign-up-thumb-img"); timg.src = url; timg.alt = "Your signature preview";
        upThumbWrap.appendChild(timg);
        refreshPlaceUI();
      } catch (e) { status(host, "Couldn't read that image — try a PNG or JPG.", "err"); }
    });

    function setMode(mode) {
      const draw = mode === "draw";
      drawBtn.setAttribute("aria-pressed", draw ? "true" : "false");
      upBtn.setAttribute("aria-pressed", draw ? "false" : "true");
      drawBtn.classList.toggle("active", draw); upBtn.classList.toggle("active", !draw);
      drawWrap.classList.toggle("hidden", !draw);
      upWrap.classList.toggle("hidden", draw);
      // Switching source clears any staged signature so we don't mix them.
      sigBytes = null;
      if (draw) captureDrawn();
      refreshPlaceUI();
    }
    drawBtn.onclick = () => setMode("draw");
    upBtn.onclick = () => setMode("upload");

    // ── Placement controls: page, corner/click position, size ─────────
    const ctl = el("div", "controls"); ctl.style.paddingTop = "16px";

    const fPage = el("div", "field"); fPage.appendChild(txt("label", null, "Page"));
    const pageSel = el("select"); pageSel.setAttribute("aria-label", "Page to sign");
    for (let i = 1; i <= total; i++) { const o = txt("option", null, "Page " + i); o.value = String(i); pageSel.appendChild(o); }
    fPage.appendChild(pageSel);

    const fPos = el("div", "field"); fPos.appendChild(txt("label", null, "Position"));
    const posSel = el("select"); posSel.setAttribute("aria-label", "Signature position");
    posSel.innerHTML = `<option value="click">Click on the page</option>` +
      `<option value="bottom-right" selected>Bottom right</option>` +
      `<option value="bottom-left">Bottom left</option>` +
      `<option value="bottom-center">Bottom center</option>` +
      `<option value="top-right">Top right</option>` +
      `<option value="top-left">Top left</option>`;
    fPos.appendChild(posSel);

    const fSize = el("div", "field"); fSize.appendChild(txt("label", null, "Size"));
    const sizeSel = el("select"); sizeSel.setAttribute("aria-label", "Signature size");
    sizeSel.innerHTML = `<option value="small">Small</option><option value="medium" selected>Medium</option><option value="large">Large</option>`;
    fSize.appendChild(sizeSel);

    const go = txt("button", "btn", "Place signature & download"); go.type = "button";
    ctl.append(fPage, fPos, fSize, el("div", "spacer"), go);
    panel.appendChild(ctl);

    // Live page preview (pdf.js → canvas). A click drops the signature at that
    // point when Position = "Click on the page". clickFrac holds the normalized
    // {x,y} of the click (top-left origin, 0..1) for the chosen page.
    let clickFrac = null;
    const previewWrap = el("div", "sign-preview-wrap");
    const previewHint = txt("div", "hint", "Tip: choose “Click on the page”, then click where you want your signature.");
    previewHint.style.margin = "14px 0 8px";
    const previewCanvas = el("canvas", "sign-preview-canvas");
    previewCanvas.setAttribute("role", "img");
    previewCanvas.setAttribute("aria-label", "Page preview — click to place your signature");
    const marker = el("div", "sign-marker hidden"); marker.setAttribute("aria-hidden", "true");
    previewWrap.append(previewCanvas, marker);
    panel.append(previewHint, previewWrap);
    host.appendChild(panel);

    // Render the currently-selected page into the preview canvas (scaled to fit a
    // sensible width). Re-rendered whenever the page selector changes.
    let previewPageNum = 0;
    async function renderPreview() {
      const pn = parseInt(pageSel.value, 10) || 1;
      previewPageNum = pn;
      clickFrac = null; marker.classList.add("hidden");
      const page = await js.getPage(pn);
      const vp0 = page.getViewport({ scale: 1 });
      const targetW = Math.min(560, vp0.width);
      const vp = page.getViewport({ scale: targetW / vp0.width });
      previewCanvas.width = Math.ceil(vp.width); previewCanvas.height = Math.ceil(vp.height);
      const cx = previewCanvas.getContext("2d");
      cx.fillStyle = "#fff"; cx.fillRect(0, 0, previewCanvas.width, previewCanvas.height);
      await page.render({ canvasContext: cx, viewport: vp }).promise;
    }
    pageSel.addEventListener("change", renderPreview);
    await renderPreview();

    // Clicking the preview records a normalized position and shows a marker (only
    // meaningful when Position = "Click on the page").
    previewCanvas.addEventListener("click", (e) => {
      if (posSel.value !== "click") return;
      const r = previewCanvas.getBoundingClientRect();
      const fx = (e.clientX - r.left) / r.width;
      const fy = (e.clientY - r.top) / r.height;
      clickFrac = { x: Math.max(0, Math.min(1, fx)), y: Math.max(0, Math.min(1, fy)) };
      marker.style.left = (clickFrac.x * 100) + "%";
      marker.style.top = (clickFrac.y * 100) + "%";
      marker.classList.remove("hidden");
    });
    posSel.addEventListener("change", () => {
      if (posSel.value !== "click") { marker.classList.add("hidden"); clickFrac = null; }
    });

    function refreshPlaceUI() { go.disabled = !sigBytes; }
    refreshPlaceUI();

    const SIGN_SIZES = { small: 0.22, medium: 0.34, large: 0.5 }; // fraction of page width

    go.onclick = async () => {
      if (!sigBytes) { status(host, "Draw or upload your signature first.", "err"); return; }
      if (posSel.value === "click" && !clickFrac) { status(host, "Click on the page preview to choose where your signature goes.", "err"); return; }
      go.disabled = true;
      try {
        status(host, "Placing your signature on your device…");
        const doc = await loadForEdit(bytes);
        const pages = doc.getPages();
        const pn = parseInt(pageSel.value, 10) || 1;
        const page = pages[pn - 1];
        const { width: pw, height: ph } = page.getSize();

        let img;
        try { img = sigIsPng ? await doc.embedPng(sigBytes) : await doc.embedJpg(sigBytes); }
        catch { throw new Error("SIG_EMBED"); }

        // Target width as a fraction of the page; height keeps the signature's aspect.
        const sw = pw * (SIGN_SIZES[sizeSel.value] || SIGN_SIZES.medium);
        const sh = sw / (sigAspect || (img.width / img.height) || 3);

        const margin = Math.min(pw, ph) * 0.04;
        let x, y; // pdf-lib origin is BOTTOM-left
        if (posSel.value === "click" && clickFrac) {
          // clickFrac is top-left origin; center the signature on the click point.
          const cxp = clickFrac.x * pw;
          const cyTop = clickFrac.y * ph;
          x = cxp - sw / 2;
          y = ph - cyTop - sh / 2;
        } else {
          const pos = posSel.value;
          const right = pos.includes("right"), left = pos.includes("left"), center = pos.includes("center");
          const top = pos.includes("top");
          x = center ? (pw - sw) / 2 : right ? pw - sw - margin : /*left/default*/ margin;
          y = top ? ph - sh - margin : margin;
        }
        // Keep the signature fully on the page.
        x = Math.max(0, Math.min(x, pw - sw));
        y = Math.max(0, Math.min(y, ph - sh));

        page.drawImage(img, { x, y, width: sw, height: sh });
        const out = await doc.save();
        await download(out, `${safeName(name)}-signed.pdf`);
        status(host, `Done — signature placed on page ${pn} (${fmtBytes(out.length)}). ${IS_NATIVE ? "Saved to your device." : "Saved to your downloads."}`, "ok");
      } catch (e) {
        status(host, e && e.message === "SIG_EMBED" ? "Couldn't use that signature image — try a PNG or JPG." : friendly(e), "err");
      }
      go.disabled = false;
    };
  });
}

// ── TOOL: Redact (PRO) ──────────────────────────────────────────────
// Renders each page to a canvas via the existing pdf.js pipeline and lets the
// user draw one or more black rectangles over sensitive areas. On export, every
// AFFECTED page is PERMANENTLY flattened: the page image + its black boxes are
// drawn onto a canvas and that raster replaces the page (rebuilt from the
// flattened image via pdf-lib), so no hidden text or vector survives under the
// box. Unaffected pages are copied through untouched. Saves "<name>-redacted.pdf".
// PRO — gated by Billing.isPro() + refreshProStatus(); on a miss we open the
// existing paywall via showProModal() instead of running. All rendering is
// in-browser; the filename is only ever written via textContent.
function toolRedact(host) {
  singleFileStage(host, async (bytes, name) => {
    const js = await loadForRender(bytes);
    const total = js.numPages;

    const panel = el("div");
    const note = el("div", "hint"); note.style.marginBottom = "12px";
    note.append(document.createTextNode("Loaded "), txt("b", null, name),
      document.createTextNode(` — ${total} page${total !== 1 ? "s" : ""}. Draw black boxes over anything sensitive, then export. Redaction permanently destroys the data under each box by rasterizing affected pages, so text there becomes an image — nothing stays hidden underneath. Everything runs on your device.`));
    panel.appendChild(note);

    // Per-page rectangle store. Keyed by page number → array of normalized rects
    // {x,y,w,h} in 0..1 page-fraction coordinates (top-left origin), so they map
    // cleanly onto the full-resolution render at export time regardless of preview scale.
    const rectsByPage = {};

    // Navigation + drawing surface.
    const nav = el("div", "redact-nav");
    const prevBtn = txt("button", "btn ghost sm", "‹ Prev"); prevBtn.type = "button";
    const nextBtn = txt("button", "btn ghost sm", "Next ›"); nextBtn.type = "button";
    const pageLabel = txt("span", "redact-page-label", `Page 1 of ${total}`);
    pageLabel.setAttribute("role", "status");
    const undoBtn = txt("button", "btn ghost sm", "Undo box"); undoBtn.type = "button";
    const clearBtn = txt("button", "btn ghost sm", "Clear page"); clearBtn.type = "button";
    nav.append(prevBtn, pageLabel, nextBtn, el("div", "spacer"), undoBtn, clearBtn);
    panel.appendChild(nav);

    const stage = el("div", "redact-stage");
    const canvas = el("canvas", "redact-canvas");
    canvas.setAttribute("role", "img");
    canvas.setAttribute("aria-label", "Page — drag to draw a redaction box over sensitive areas");
    canvas.setAttribute("tabindex", "0");
    const overlay = el("div", "redact-overlay"); overlay.setAttribute("aria-hidden", "true");
    stage.append(canvas, overlay);
    panel.appendChild(stage);

    const ctl = el("div", "controls"); ctl.style.paddingTop = "16px";
    const go = txt("button", "btn", "Redact & download"); go.type = "button";
    ctl.append(el("div", "spacer"), go);
    panel.appendChild(ctl);
    host.appendChild(panel);

    let cur = 1;
    let scale = 1; // preview canvas px per full-render px, for mapping (not persisted)

    async function renderPage() {
      cur = Math.max(1, Math.min(total, cur));
      pageLabel.textContent = `Page ${cur} of ${total}`;
      prevBtn.disabled = cur <= 1; nextBtn.disabled = cur >= total;
      const page = await js.getPage(cur);
      const vp0 = page.getViewport({ scale: 1 });
      const targetW = Math.min(620, vp0.width);
      scale = targetW / vp0.width;
      const vp = page.getViewport({ scale });
      canvas.width = Math.ceil(vp.width); canvas.height = Math.ceil(vp.height);
      const cx = canvas.getContext("2d");
      cx.fillStyle = "#fff"; cx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: cx, viewport: vp }).promise;
      drawRects();
    }

    // Paint the stored rectangles for the current page as visible black boxes in
    // the overlay (absolutely-positioned divs, percentage coords so they track the
    // canvas's rendered size responsively).
    function drawRects() {
      overlay.innerHTML = "";
      overlay.style.width = canvas.offsetWidth + "px";
      overlay.style.height = canvas.offsetHeight + "px";
      const list = rectsByPage[cur] || [];
      list.forEach((r) => {
        const box = el("div", "redact-box");
        box.style.left = (r.x * 100) + "%"; box.style.top = (r.y * 100) + "%";
        box.style.width = (r.w * 100) + "%"; box.style.height = (r.h * 100) + "%";
        overlay.appendChild(box);
      });
      undoBtn.disabled = !list.length; clearBtn.disabled = !list.length;
    }

    // Drag to draw a rectangle. Pointer events cover mouse/pen/touch. Coordinates
    // are normalized against the canvas's on-screen box so they survive scaling.
    let dragging = false, sx = 0, sy = 0;
    const live = el("div", "redact-box redact-box-live hidden"); overlay.appendChild(live);
    function normPt(e) {
      const r = canvas.getBoundingClientRect();
      return { x: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)),
               y: Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)) };
    }
    canvas.addEventListener("pointerdown", (e) => {
      dragging = true; const p = normPt(e); sx = p.x; sy = p.y;
      live.classList.remove("hidden");
      live.style.left = (sx * 100) + "%"; live.style.top = (sy * 100) + "%";
      live.style.width = "0%"; live.style.height = "0%";
      overlay.style.width = canvas.offsetWidth + "px"; overlay.style.height = canvas.offsetHeight + "px";
      e.preventDefault();
    });
    canvas.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      const p = normPt(e);
      const x = Math.min(sx, p.x), y = Math.min(sy, p.y), w = Math.abs(p.x - sx), h = Math.abs(p.y - sy);
      live.style.left = (x * 100) + "%"; live.style.top = (y * 100) + "%";
      live.style.width = (w * 100) + "%"; live.style.height = (h * 100) + "%";
      e.preventDefault();
    });
    function finishDrag(e) {
      if (!dragging) return;
      dragging = false; live.classList.add("hidden");
      const p = normPt(e);
      const x = Math.min(sx, p.x), y = Math.min(sy, p.y), w = Math.abs(p.x - sx), h = Math.abs(p.y - sy);
      // Ignore accidental micro-drags (a click, not a box).
      if (w < 0.01 || h < 0.01) return;
      (rectsByPage[cur] || (rectsByPage[cur] = [])).push({ x, y, w, h });
      drawRects();
    }
    canvas.addEventListener("pointerup", finishDrag);
    canvas.addEventListener("pointerleave", (e) => { if (dragging) finishDrag(e); });

    prevBtn.onclick = () => { cur--; renderPage(); };
    nextBtn.onclick = () => { cur++; renderPage(); };
    undoBtn.onclick = () => { const l = rectsByPage[cur]; if (l && l.length) { l.pop(); if (!l.length) delete rectsByPage[cur]; drawRects(); } };
    clearBtn.onclick = () => { delete rectsByPage[cur]; drawRects(); };

    await renderPage();

    // The actual destructive export. Runs ONLY after the Pro gate passes.
    async function runRedact() {
      const affected = Object.keys(rectsByPage).filter((k) => (rectsByPage[k] || []).length).map(Number);
      if (!affected.length) { status(host, "Draw at least one black box over something to redact first.", "err"); return; }
      go.disabled = true;
      try {
        status(host, "Redacting on your device — flattening affected pages…");
        const affectedSet = new Set(affected);
        // Start from a fresh copy of the source so unaffected pages are byte-preserved.
        const out = await loadForEdit(bytes);

        for (const pn of affected) {
          status(host, `Rasterizing page ${pn} to destroy the data underneath…`);
          const page = await js.getPage(pn);
          // Render at a high scale so the flattened raster stays crisp.
          const vp = page.getViewport({ scale: 2 });
          const cv = el("canvas"); cv.width = Math.ceil(vp.width); cv.height = Math.ceil(vp.height);
          const cx = cv.getContext("2d");
          cx.fillStyle = "#fff"; cx.fillRect(0, 0, cv.width, cv.height);
          await page.render({ canvasContext: cx, viewport: vp }).promise;
          // Paint the black boxes onto the raster — this is what permanently
          // destroys the content underneath (it's now a flat image, no text/vector).
          cx.fillStyle = "#000";
          (rectsByPage[pn] || []).forEach((r) => {
            cx.fillRect(Math.round(r.x * cv.width), Math.round(r.y * cv.height),
              Math.round(r.w * cv.width), Math.round(r.h * cv.height));
          });
          const blob = await new Promise((res) => cv.toBlob(res, "image/jpeg", 0.92));
          const jpg = await out.embedJpg(new Uint8Array(await blob.arrayBuffer()));
          // TRUE redaction: DISCARD the original page — including its text/vector
          // content stream — and rebuild it as an image-only page holding just the
          // flattened raster. Merely drawing the box OVER the page would leave the
          // original text intact and extractable underneath; removing the page and
          // inserting a fresh one in its place destroys it. Page size comes from the
          // scale-1 viewport (rotation-aware), so the raster maps 1:1 and upright.
          const vp1 = page.getViewport({ scale: 1 });
          const pw = vp1.width, ph = vp1.height;
          out.removePage(pn - 1);
          const fresh = out.insertPage(pn - 1, [pw, ph]);
          fresh.drawImage(jpg, { x: 0, y: 0, width: pw, height: ph });
        }
        const saved = await out.save();
        await download(saved, `${safeName(name)}-redacted.pdf`);
        status(host, `Done — redacted ${affected.length} page${affected.length !== 1 ? "s" : ""} (${fmtBytes(saved.length)}). The data under each box is permanently gone; those pages are now flattened images.`, "ok");
      } catch (e) { status(host, friendly(e), "err"); }
      go.disabled = false;
    }

    // FREE tool: redaction is a privacy-safety essential (it stops sensitive data
    // from leaking in a shared PDF), so it runs for everyone — no Pro gate.
    go.onclick = () => {
      if (go.disabled) return;
      const affected = Object.keys(rectsByPage).filter((k) => (rectsByPage[k] || []).length);
      if (!affected.length) { status(host, "Draw at least one black box over something to redact first.", "err"); return; }
      runRedact();
    };
  });
}

// Optical character recognition for scanned / image-only PDFs, powered by
// Tesseract.js running 100% on-device (WASM). Everything is vendored locally in
// lib/tesseract/ — the ~13MB engine + English model lazy-load only on first run,
// never from a CDN, so a scanned document's text never leaves the device. FREE.
// Each page is rendered to a canvas via pdf.js, then recognized; recognized text
// is only ever placed in the DOM via textContent (status strings), never innerHTML.
async function makeOcrWorker(onProgress) {
  // Paths are relative to index.html at the site root. workerBlobURL:false keeps
  // the worker a same-origin script (worker-src 'self') rather than a blob.
  return await Tesseract.createWorker("eng", 1, {
    workerPath: "lib/tesseract/worker.min.js",
    langPath: "lib/tesseract/",
    corePath: "lib/tesseract/",
    workerBlobURL: false,
    logger: onProgress || (() => {}),
  });
}

function toolOcr(host) {
  singleFileStage(host, async (bytes, name) => {
    const js = await loadForRender(bytes);
    const panel = el("div");
    const note = txt("div", "hint",
      `${name} — ${js.numPages} page${js.numPages !== 1 ? "s" : ""}. Reads text off scanned or photographed pages using on-device OCR (English). ` +
      (IS_NATIVE
        ? `The engine is built into the app — everything runs on this device, offline. Best on clear, upright scans.`
        : `The first run downloads the recognition engine (~13 MB, one time) — after that it works offline. Best on clear, upright scans.`));
    note.style.marginBottom = "12px";
    const ctl = el("div", "controls"); ctl.style.border = "0"; ctl.style.paddingTop = "0";
    const go = txt("button", "btn", "Run OCR & download text");
    ctl.append(el("div", "spacer"), go);
    panel.append(note, ctl); host.appendChild(panel);

    go.onclick = async () => {
      go.disabled = true;
      let worker = null;
      try {
        status(host, IS_NATIVE ? "Loading the OCR engine…" : "Loading the OCR engine (one-time, ~13 MB)…");
        // Coarse per-page recognition progress from Tesseract's logger.
        let curPage = 0;
        worker = await makeOcrWorker((m) => {
          if (m && m.status === "recognizing text" && curPage) {
            status(host, `Reading page ${curPage} of ${js.numPages}… ${Math.round((m.progress || 0) * 100)}%`);
          }
        });
        const parts = [];
        for (let i = 1; i <= js.numPages; i++) {
          curPage = i;
          status(host, `Rendering page ${i} of ${js.numPages}…`);
          const page = await js.getPage(i);
          // ~2.5x ≈ 180 dpi — a good accuracy/speed tradeoff for OCR.
          const vp = page.getViewport({ scale: 2.5 });
          const cv = el("canvas"); cv.width = Math.ceil(vp.width); cv.height = Math.ceil(vp.height);
          await page.render({ canvasContext: cv.getContext("2d"), viewport: vp }).promise;
          const { data } = await worker.recognize(cv);
          parts.push(`--- Page ${i} ---\n\n` + (data.text || "").trim());
          // Release the canvas promptly so many-page scans don't balloon memory.
          cv.width = cv.height = 0;
        }
        const text = parts.join("\n\n");
        await download(new TextEncoder().encode(text), `${safeName(name)}-ocr.txt`, "text/plain");
        const chars = text.replace(/--- Page \d+ ---/g, "").trim().length;
        status(host, chars
          ? `Recognized ~${chars.toLocaleString()} characters across ${js.numPages} page${js.numPages !== 1 ? "s" : ""}. ${IS_NATIVE ? "Saved to your device." : "Saved to your downloads."}`
          : `Finished, but no text was recognized — the pages may be blank, very low-resolution, or not text.`, chars ? "ok" : "err");
      } catch (e) {
        status(host, friendly(e), "err");
      } finally {
        if (worker) { try { await worker.terminate(); } catch {} }
        go.disabled = false;
      }
    };
  });
}

// ── Drag-to-reorder. indexOf() is read live (getIndex) so stale
//    render-time indexes can't move the wrong item. ──────────────────
let dragData = null; // {arr, from}
function dragReorder(node, container, getIndex, arr, rerender) {
  node.addEventListener("dragstart", (e) => { node.classList.add("dragging"); dragData = { arr, from: getIndex() }; e.dataTransfer.effectAllowed = "move"; try { e.dataTransfer.setData("text/plain", "1"); } catch {} });
  node.addEventListener("dragend", () => node.classList.remove("dragging"));
  node.addEventListener("dragover", (e) => e.preventDefault());
  node.addEventListener("drop", (e) => {
    e.preventDefault();
    if (!dragData || dragData.arr !== arr) return;
    const from = dragData.from, to = getIndex();
    dragData = null;
    if (from == null || to == null || from === to || from < 0 || to < 0) return;
    const [moved] = arr.splice(from, 1); arr.splice(to, 0, moved); rerender();
  });
}

Theme.init();
buildHub();
if (IS_NATIVE) {
  // iOS: no typed restore code — this becomes Apple's "Restore Purchases", re-syncing
  // this Apple ID's receipt with the App Store.
  const footerRestore = $("#footerRestoreLink");
  footerRestore.textContent = "Restore Purchases";
  footerRestore.onclick = async () => {
    const prev = footerRestore.textContent;
    footerRestore.disabled = true; footerRestore.textContent = "Restoring…";
    let res;
    try { res = await Billing.restorePurchases(); }
    catch (e) { console.error("Local PDF: restore threw", e); res = { ok: false }; }
    footerRestore.disabled = false; footerRestore.textContent = prev;
    if (res && res.ok) { onProUnlocked({ announceRestore: true }); }
    // Web-buyer clause: web Pro and App Store Pro are separate purchases, so a web owner
    // must not be sent hunting through Apple Accounts. Longer toast so it's readable.
    else { showToast("No previous purchase found for this Apple Account. Bought on the web? Web and App Store purchases are separate — your code works in your browser.", 9000); }
  };
} else {
  $("#footerRestoreLink").onclick = () => showRestoreEntryModal();
}
// Quiet topbar "Unlock Pro" front door → the app's existing paywall opener.
// Native <button>, so click covers Enter/Space. Owner-state is handled by
// syncUnlockProAffordance() (called from refreshAfterProChange + boot).
{ const upb = $("#unlockProBtn"); if (upb) upb.onclick = () => showProModal(); }
if (IS_NATIVE) {
  // The topbar card's "$9.99 · one-time" is a hardcoded USD string, but Apple bills in
  // the buyer's storefront currency — swap in the App Store's real localized price when
  // it arrives (the hardcoded string stays as the instant placeholder and the fallback
  // on any failure). Display-only; the web topbar is unchanged (web charges USD $9.99).
  safeBillingAsync(() => Billing.getNativeLocalizedPrice(), null).then((p) => {
    if (!p) return;
    const upb = $("#unlockProBtn");
    if (!upb) return;
    const priceEl = upb.querySelector(".unlock-pro-price");
    if (priceEl) priceEl.textContent = p + " · one-time";
    upb.title = "Batch-process a whole folder into one ZIP — " + p + " · one-time";
    upb.setAttribute("aria-label", "Unlock Pro — batch-process a whole folder into one ZIP, " + p + " one-time");
  });
}

// ── Boot entitlement check ──────────────────────────────────────────────────
// Only browsers that might already own Pro make a billing network call at boot
// (Billing.shouldCheckAtBoot() returns false for a brand-new visitor, so fresh
// loads still make ZERO billing calls). This recovers the "paid then closed the
// tab too early stays locked" case. If the refresh finds Pro but there's no
// restore code on this browser, surface the self-heal nag.
async function initBilling() {
  let didRefresh = false;
  try {
    if (safeBilling(() => Billing.shouldCheckAtBoot(), false)) {
      await safeBillingAsync(() => Billing.refreshProStatus(), false);
      didRefresh = true;
    }
  } catch {}
  // Reveal owner surfaces (footer license link, drop "(Pro)" labels) after the check.
  refreshAfterProChange();
  // Access-stop reconciliation: only meaningful after a genuine verified refresh.
  // reconcileProAccess() either remembers current Pro (was_pro=1) or, if Pro is now
  // truly gone but was owned here, runs the one-time kind notice + resets. When we
  // skipped the boot check (brand-new visitor), still remember Pro if it's already
  // true, but never treat a skipped check as a revocation.
  if (didRefresh) {
    reconcileProAccess();
  } else if (safeBilling(() => Billing.isPro(), false)) {
    markWasPro();
  }
  // If Pro is active but no restore code exists on this browser, offer to mint one.
  if (safeBilling(() => Billing.isPro(), false) && !safeBilling(() => Billing.getRestoreCode(), null)) {
    maybeShowSelfHealNag();
  }
  // Pro AND has a code AND not yet acked → surface the save-card nag now (post-check),
  // since initLicenseCard's synchronous pass ran before this verified check resolved.
  if (safeBilling(() => Billing.isPro(), false) && safeBilling(() => Billing.getRestoreCode(), null) && !isCodeAcked()) {
    showSaveNagBanner();
  }
}

// License-card surfaces: a permanent footer link whenever a restore code exists,
// plus the save-your-card nag banner until the user has confirmed "I've saved it".
(function initLicenseCard() {
  const code = safeBilling(() => Billing.getRestoreCode(), null);
  if (!code) return; // no purchase on this browser — footer link stays hidden
  const link = $("#footerLicenseLink");
  // The footer license link is an OWNER surface: reveal it only when a code exists AND
  // Pro is verified-active, so a refunded/hollow-code browser isn't handed a card for a
  // dead code. On this synchronous boot pass isPro() reflects the pro_seen seed (set only
  // by a past VERIFIED entitlement), so known owners get the link at once; initBilling()
  // re-runs refreshAfterProChange() after the verified refreshProStatus() (offline owners
  // fail OPEN and keep it), which corrects it either way.
  if (link && safeBilling(() => Billing.isPro(), false)) { link.classList.remove("hidden"); link.onclick = () => showLicenseCardModal(); }
  // Only nag to save the card when this browser is ACTUALLY Pro — a stale/refunded/
  // hollow code shouldn't show "Keep your Pro safe" next to the Unlock-Pro paywall.
  // On this synchronous boot pass isPro() reflects the pro_seen seed (verified-before
  // owners only); initBilling() re-runs the nag after the verified refreshProStatus()
  // (offline owners fail OPEN and keep it), and a revocation removes it.
  if (!isCodeAcked() && safeBilling(() => Billing.isPro(), false)) showSaveNagBanner();
})();

initBilling();


/* Offline support (progressive enhancement): register the service worker ONLY
   on the real https web deployment. Never in the Capacitor native shell
   (localhost) or local dev, where assets already load offline and a SW could
   interfere. Fails silently. */
(function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  var h = location.hostname;
  var webOK = location.protocol === "https:" && h !== "localhost" && h !== "127.0.0.1" && !h.endsWith(".local");
  if (!webOK) return;
  window.addEventListener("load", function () {
    navigator.serviceWorker.register("/sw.js").catch(function () {});
  });
})();

// ── QR deep-link restore (?restore=CODE) ───────────────────────────────────
// The license card's QR encodes https://localpdfapp.com/?restore=<code> so a
// phone camera scan opens the app and restores Pro in one step (a bare-text QR
// would just land the user in a web search). Handle the param once, then scrub
// it from the URL and history — the code is a secret and shouldn't linger there.
(async () => {
  let code = null;
  try { code = new URLSearchParams(location.search).get("restore"); } catch (e) {}
  if (!code || !code.trim()) return;
  try { history.replaceState(null, "", location.pathname + location.hash); } catch (e) {}
  const normalized = formatRestoreCodeInput(code);
  const res = await safeBillingAsync(() => Billing.restoreWithCode(normalized), { ok: false });
  if (res && res.ok) {
    // Restore, not a first purchase — "Welcome back" + license link + pending intent.
    onProUnlocked({ announceRestore: true });
  } else {
    // Couldn't restore from the scan (offline, refunded, or an odd code) — open
    // the restore modal prefilled so the user can see the code and retry.
    showRestoreEntryModal();
    const inp = document.querySelector(".restore-code-input");
    if (inp) inp.value = normalized || String(code).trim();
  }
})();
