/*!
 * tour.js — first-run guided tour (spotlight walkthrough) for NakliTechie apps
 *
 * A self-contained onboarding component: a dimmed overlay, a spotlight ring
 * around one target element at a time, and a step card with Skip / Back / Next.
 * No dependencies, no network, no build step — vendor it inline like naklios.js
 * and keep the single-file ethos. It injects its own <style> once and styles
 * its own controls, so it never depends on the app's button classes.
 *
 *   <script src="https://naklios.dev/sdk/tour.js"></script>   // or inline it
 *   <script>
 *     naklTour.start({
 *       key: 'myapp.v1.tour-complete',        // localStorage flag; shows once
 *       steps: [
 *         { target: '#sources', title: 'Pick sources',
 *           body: 'Toggle what you capture. Everything stays in this browser.' },
 *         { target: '#record',  title: 'Record',
 *           body: 'A 3-2-1 countdown, then capture begins.' },
 *         { target: '#help',    title: 'Help is here',
 *           body: 'Reopen this button to replay the tour anytime.' },
 *       ],
 *     });
 *     // Replay from a "Take the tour" button in the help modal:
 *     helpTourBtn.addEventListener('click', () => naklTour.replay());
 *   </script>
 *
 * Design notes
 * - Steps whose target is missing or not visible are filtered out, so the same
 *   step list works across modes (a Studio-only panel simply drops out in a
 *   minimal mode). If none are visible, nothing shows.
 * - Theme-aware by CSS custom properties with fallbacks: it reads --accent,
 *   --tour-bg / --bg-2, --tour-ink / --text, --tour-border / --border-2 from the
 *   host, so it inherits the app's palette with no configuration.
 * - Completion sets one localStorage flag (the `key`). Nothing else is stored,
 *   nothing is sent anywhere. A private window or cleared storage just re-shows.
 * - Keyboard: ← / → step, Enter/Space activate a focused button, Esc finishes.
 *   The tour owns keydown while open (capture + stopPropagation) so the app's
 *   own shortcuts don't also fire.
 *
 * Vendor it inline in each app to keep the no-network-dependency ethos.
 * License: MIT.
 */
(function () {
  var STYLE_ID = 'nakl-tour-style';
  var CSS =
    '.nakl-tour-layer{position:fixed;inset:0;z-index:4000;pointer-events:auto}' +
    '.nakl-tour-spot{position:fixed;z-index:4001;border:2px solid var(--accent,#d8482a);' +
    'border-radius:10px;box-shadow:0 0 0 4px color-mix(in srgb,var(--accent,#d8482a) 26%,transparent),' +
    '0 0 0 9999px rgba(0,0,0,.72);pointer-events:none;' +
    'transition:top .28s ease,left .28s ease,width .28s ease,height .28s ease}' +
    '.nakl-tour-card{position:fixed;z-index:4002;width:min(340px,calc(100vw - 24px));padding:20px;' +
    'border:1px solid var(--tour-border,var(--border-2,#2c3a52));border-radius:14px;' +
    'background:var(--tour-bg,var(--bg-2,#0e1824));color:var(--tour-ink,var(--text,#e8eef4));' +
    'box-shadow:0 20px 48px rgba(0,0,0,.6);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif}' +
    '.nakl-tour-progress{margin:0 0 8px;color:var(--accent,#d8482a);font-size:11px;font-weight:700;' +
    'letter-spacing:.06em;text-transform:uppercase}' +
    '.nakl-tour-card h2{margin:0 0 8px;font-size:17px;font-weight:700}' +
    '.nakl-tour-card p{margin:0;font-size:13px;line-height:1.6;opacity:.85}' +
    '.nakl-tour-actions{display:flex;align-items:center;gap:8px;margin-top:18px}' +
    '.nakl-tour-actions button{font:inherit;font-size:12px;font-weight:600;padding:7px 12px;border-radius:8px;' +
    'border:1px solid var(--tour-border,var(--border-2,#2c3a52));background:transparent;' +
    'color:inherit;cursor:pointer}' +
    '.nakl-tour-actions button:hover{border-color:var(--accent,#d8482a)}' +
    '.nakl-tour-actions button:disabled{opacity:.4;cursor:default}' +
    '.nakl-tour-skip{margin-right:auto}' +
    '.nakl-tour-next{background:var(--accent,#d8482a)!important;border-color:var(--accent,#d8482a)!important;color:#fff!important}' +
    '@media(max-width:520px){.nakl-tour-card{padding:14px}.nakl-tour-actions{flex-wrap:wrap}}';

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var s = document.createElement('style');
    s.id = STYLE_ID; s.textContent = CSS;
    document.head.appendChild(s);
  }

  var layer = null, steps = [], active = [], idx = 0, prevFocus = null, cfgKey = null, lastCfg = null;
  var clamp = function (v, min, max) { return Math.max(min, Math.min(max, v)); };

  function visible(step) {
    var t = document.querySelector(step.target);
    if (!t) return false;
    var r = t.getBoundingClientRect(), st = getComputedStyle(t);
    return r.width > 0 && r.height > 0 && st.display !== 'none' && st.visibility !== 'hidden';
  }
  function target() { return document.querySelector(active[idx].target) || document.body; }

  function position() {
    if (!layer) return;
    var el = target();
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    var rect = el.getBoundingClientRect(), pad = 6;
    var spot = layer.querySelector('.nakl-tour-spot');
    spot.style.top = Math.max(4, rect.top - pad) + 'px';
    spot.style.left = Math.max(4, rect.left - pad) + 'px';
    spot.style.width = Math.max(24, Math.min(innerWidth - 8, rect.width + pad * 2)) + 'px';
    spot.style.height = Math.max(24, Math.min(innerHeight - 8, rect.height + pad * 2)) + 'px';
    var card = layer.querySelector('.nakl-tour-card'), cr = card.getBoundingClientRect();
    var gap = 18, margin = 12, top, left;
    if (rect.bottom + gap + cr.height <= innerHeight - margin) {
      top = rect.bottom + gap; left = rect.left + rect.width / 2 - cr.width / 2;
    } else if (rect.top - gap - cr.height >= margin) {
      top = rect.top - gap - cr.height; left = rect.left + rect.width / 2 - cr.width / 2;
    } else if (rect.left - gap - cr.width >= margin) {
      top = rect.top + rect.height / 2 - cr.height / 2; left = rect.left - gap - cr.width;
    } else if (rect.right + gap + cr.width <= innerWidth - margin) {
      top = rect.top + rect.height / 2 - cr.height / 2; left = rect.right + gap;
    } else {
      top = innerHeight - cr.height - margin; left = innerWidth / 2 - cr.width / 2;
    }
    card.style.top = clamp(top, margin, innerHeight - cr.height - margin) + 'px';
    card.style.left = clamp(left, margin, innerWidth - cr.width - margin) + 'px';
    card.style.visibility = 'visible';
  }

  function render() {
    if (!layer) return;
    var step = active[idx];
    layer.querySelector('.nakl-tour-progress').textContent = 'Quick tour · ' + (idx + 1) + ' of ' + active.length;
    layer.querySelector('.nakl-tour-title').textContent = step.title || '';
    layer.querySelector('.nakl-tour-body').textContent = step.body || '';
    layer.querySelector('.nakl-tour-back').disabled = idx === 0;
    layer.querySelector('.nakl-tour-next').textContent = idx === active.length - 1 ? 'Finish' : 'Next';
    layer.querySelector('.nakl-tour-card').style.visibility = 'hidden';
    requestAnimationFrame(function () { position(); layer && layer.querySelector('.nakl-tour-next').focus(); });
  }

  function finish() { try { if (cfgKey) localStorage.setItem(cfgKey, '1'); } catch (e) {} close(); }
  function close() {
    if (!layer) return;
    var old = layer; layer = null;
    window.removeEventListener('resize', position);
    document.removeEventListener('keydown', onKey, true);
    old.remove();
    if (prevFocus && prevFocus.isConnected) prevFocus.focus();
    prevFocus = null;
  }
  function next() { if (idx < active.length - 1) { idx++; render(); } else finish(); }
  function back() { if (idx > 0) { idx--; render(); } }

  function onKey(e) {
    if (!layer) return;
    e.stopPropagation();
    if ((e.key === 'Enter' || e.key === ' ') && e.target instanceof Element && e.target.closest('.nakl-tour-actions button')) {
      e.preventDefault(); e.target.click(); return;
    }
    if (e.key === 'Escape') { e.preventDefault(); finish(); return; }
    if (e.key === 'ArrowRight') { e.preventDefault(); next(); return; }
    if (e.key === 'ArrowLeft') { e.preventDefault(); back(); return; }
  }

  // Show the tour. Returns true if it opened. Honours the once-per-machine flag
  // unless { force:true }. Filters to visible steps; opens nothing if none are.
  function show(opts) {
    opts = opts || {};
    var seen = false; try { seen = !!(cfgKey && localStorage.getItem(cfgKey)); } catch (e) {}
    if (layer || (!opts.force && seen)) return false;
    active = steps.filter(visible);
    if (!active.length) return false;
    injectStyle();
    prevFocus = document.activeElement;
    idx = 0;
    layer = document.createElement('div');
    layer.className = 'nakl-tour-layer';
    layer.innerHTML =
      '<div class="nakl-tour-spot" aria-hidden="true"></div>' +
      '<section class="nakl-tour-card" role="dialog" aria-modal="true" aria-labelledby="nakl-tour-title" aria-describedby="nakl-tour-body">' +
      '<div class="nakl-tour-progress"></div>' +
      '<h2 class="nakl-tour-title" id="nakl-tour-title"></h2>' +
      '<p class="nakl-tour-body" id="nakl-tour-body" aria-live="polite"></p>' +
      '<div class="nakl-tour-actions">' +
      '<button type="button" class="nakl-tour-skip">Skip</button>' +
      '<button type="button" class="nakl-tour-back">Back</button>' +
      '<button type="button" class="nakl-tour-next">Next</button>' +
      '</div></section>';
    document.body.appendChild(layer);
    layer.querySelector('.nakl-tour-skip').addEventListener('click', finish);
    layer.querySelector('.nakl-tour-back').addEventListener('click', back);
    layer.querySelector('.nakl-tour-next').addEventListener('click', next);
    window.addEventListener('resize', position);
    document.addEventListener('keydown', onKey, true);
    render();
    return true;
  }

  // Register a tour and auto-show it once. Call once at startup.
  //   start({ key, steps, auto })  — auto defaults to true (show on first run)
  function start(config) {
    config = config || {};
    steps = Array.isArray(config.steps) ? config.steps : [];
    cfgKey = config.key || null;
    lastCfg = config;
    if (config.auto === false) return false;
    // Defer one paint so late-laid-out targets (sidebars, async panels) exist.
    var run = function () { setTimeout(function () { show({ force: false }); }, config.delay || 400); };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run, { once: true });
    else run();
    return true;
  }

  // Force-replay the registered tour (e.g. from a help modal button).
  function replay() { return show({ force: true }); }

  window.naklTour = { start: start, show: show, replay: replay };
})();
