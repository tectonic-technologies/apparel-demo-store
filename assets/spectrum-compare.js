/*
 * Spectrum Virtual Compare — PLP "add for compare" tray controller.
 *
 * Collects 2–4 products the shopper picks from product-card CTAs into a floating
 * tray, then links to the Virtual Compare page with ?products=<handle>,… The
 * selection lives in sessionStorage so it survives pagination and navigation
 * across the storefront. Card CTAs and tray controls are handled by delegation,
 * so cards loaded later (infinite scroll / AJAX pagination) work without rewiring.
 *
 * Contract with the markup:
 *   - Card CTA:  [data-spectrum-compare-btn] with data-handle/title/image/category,
 *                wrapping a .spectrum-cmp-btn button and a [data-cmp-label] span.
 *   - Tray:      [data-spectrum-compare-tray] with data-compare-url/min/max,
 *                containing [data-cmp-count], [data-cmp-items], [data-cmp-go],
 *                [data-cmp-clear].
 */
(function () {
  'use strict';

  var KEY = 'spectrum:compare:v1';
  var tray, itemsEl, countEl, goBtn;
  var MIN = 2;
  var MAX = 4;
  // Handle of the item just added. The tray rebuilds every item on each change,
  // so this flags the one node that should play the enter animation. Cleared as
  // soon as it's applied so unrelated re-renders don't re-animate the whole row.
  var enterHandle = null;

  function prefersReducedMotion() {
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  function read() {
    try {
      var v = JSON.parse(sessionStorage.getItem(KEY));
      return Array.isArray(v) ? v : [];
    } catch (e) {
      return [];
    }
  }

  function write(list) {
    try {
      sessionStorage.setItem(KEY, JSON.stringify(list));
    } catch (e) {
      /* storage unavailable (private mode / quota) — tray still works this session */
    }
  }

  function indexOf(list, handle) {
    for (var i = 0; i < list.length; i++) {
      if (list[i].handle === handle) return i;
    }
    return -1;
  }

  /* Reflect the current selection onto every card CTA in the DOM (including cards
     added after load). When the set is full, non-selected CTAs are disabled. */
  function syncButtons(list) {
    var selected = {};
    for (var i = 0; i < list.length; i++) selected[list[i].handle] = true;
    var full = list.length >= MAX;
    var nodes = document.querySelectorAll('[data-spectrum-compare-btn]');
    for (var j = 0; j < nodes.length; j++) {
      var el = nodes[j];
      var on = !!selected[el.getAttribute('data-handle')];
      el.classList.toggle('is-selected', on);
      el.classList.toggle('is-disabled', !on && full);
      var btn = el.querySelector('.spectrum-cmp-btn');
      var label = el.querySelector('[data-cmp-label]');
      var blocked = !on && full;
      var text = on ? 'Remove from compare' : 'Add to compare';
      var announced = blocked ? 'Compare is full (max ' + MAX + ')' : text;
      if (btn) {
        // Never use the `disabled` attribute or pointer-events:none here — a
        // dead button lets the click reach the card's product link and open the
        // PDP. Keep it clickable; onClick() swallows it and no-ops when full.
        btn.setAttribute('aria-pressed', on ? 'true' : 'false');
        btn.setAttribute('aria-disabled', blocked ? 'true' : 'false');
        btn.setAttribute('aria-label', announced);
        btn.setAttribute('title', announced);
      }
      if (label) label.textContent = announced;
    }
  }

  function renderTray(list) {
    if (tray) {
      if (list.length === 0) {
        tray.hidden = true;
      } else {
        tray.hidden = false;
        if (countEl) countEl.textContent = String(list.length);
        if (goBtn) goBtn.disabled = list.length < MIN;
        if (itemsEl) {
          itemsEl.textContent = '';
          for (var i = 0; i < list.length; i++) {
            itemsEl.appendChild(buildItem(list[i]));
          }
        }
      }
    }
    syncButtons(list);
  }

  function buildItem(p) {
    var item = document.createElement('div');
    item.className = 'spectrum-cmp-tray__item';
    item.setAttribute('data-cmp-item-handle', p.handle);
    if (enterHandle && p.handle === enterHandle) {
      item.classList.add('spectrum-cmp-tray__item--enter');
      enterHandle = null;
    }

    var img = document.createElement('img');
    img.src = p.image || '';
    img.alt = p.title || '';
    img.loading = 'lazy';
    item.appendChild(img);

    var rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'spectrum-cmp-tray__remove';
    rm.setAttribute('data-cmp-remove', p.handle);
    rm.setAttribute('aria-label', 'Remove ' + (p.title || 'product') + ' from compare');
    rm.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
      '<path d="M6 6l12 12M18 6 6 18" stroke="currentColor" stroke-width="2" ' +
      'stroke-linecap="round"/></svg>';
    item.appendChild(rm);

    return item;
  }

  function toggle(el) {
    var handle = el.getAttribute('data-handle');
    if (!handle) return;
    var list = read();
    var at = indexOf(list, handle);
    if (at >= 0) {
      removeWithAnim(handle);
      return;
    }
    if (list.length >= MAX) return; // full — CTA is already disabled, guard anyway
    list.push({
      handle: handle,
      title: el.getAttribute('data-title') || '',
      image: el.getAttribute('data-image') || '',
      category: el.getAttribute('data-category') || ''
    });
    enterHandle = handle; // animate this new thumbnail in on the next render
    write(list);
    renderTray(list);
  }

  function findItemNode(handle) {
    if (!itemsEl) return null;
    var kids = itemsEl.children;
    for (var i = 0; i < kids.length; i++) {
      if (kids[i].getAttribute('data-cmp-item-handle') === handle) return kids[i];
    }
    return null;
  }

  /* Drop the handle from storage and re-render. */
  function commitRemove(handle) {
    var list = read();
    var at = indexOf(list, handle);
    if (at >= 0) {
      list.splice(at, 1);
      write(list);
      renderTray(list);
    }
  }

  /* Play the thumbnail's leave animation, then commit the removal on the way out.
     Commits immediately when the node isn't in the tray or the shopper prefers
     reduced motion — in the latter case no animationend fires to un-block us, so
     we must not wait. A timeout backs up animationend either way. */
  function removeWithAnim(handle) {
    var node = findItemNode(handle);
    if (!node || prefersReducedMotion()) {
      commitRemove(handle);
      return;
    }
    if (node.getAttribute('data-leaving')) return; // already animating out
    node.setAttribute('data-leaving', '1');
    node.classList.add('spectrum-cmp-tray__item--leaving');
    var committed = false;
    var finish = function () {
      if (committed) return;
      committed = true;
      commitRemove(handle);
    };
    node.addEventListener('animationend', finish);
    setTimeout(finish, 260);
  }

  function go() {
    var list = read();
    if (list.length < MIN) return;
    var base = (tray && tray.getAttribute('data-compare-url')) || '/pages/spectrum-virtual-compare';
    var handles = list
      .map(function (p) {
        return encodeURIComponent(p.handle);
      })
      .join(',');
    window.location.href = base + '?products=' + handles;
  }

  function onClick(e) {
    var wrap = e.target.closest('[data-spectrum-compare-btn]');
    if (wrap) {
      // Product cards are wrapped in a link — always swallow the click here so it
      // can't navigate to the PDP, whether we add, remove, or no-op (at max).
      e.preventDefault();
      e.stopPropagation();
      toggle(wrap);
      return;
    }
    var rm = e.target.closest('[data-cmp-remove]');
    if (rm) {
      e.preventDefault();
      removeWithAnim(rm.getAttribute('data-cmp-remove'));
    }
  }

  function init() {
    tray = document.querySelector('[data-spectrum-compare-tray]');
    if (tray) {
      itemsEl = tray.querySelector('[data-cmp-items]');
      countEl = tray.querySelector('[data-cmp-count]');
      goBtn = tray.querySelector('[data-cmp-go]');
      MIN = parseInt(tray.getAttribute('data-min'), 10) || MIN;
      MAX = parseInt(tray.getAttribute('data-max'), 10) || MAX;
      if (goBtn) goBtn.addEventListener('click', go);
      var clearBtn = tray.querySelector('[data-cmp-clear]');
      if (clearBtn) {
        clearBtn.addEventListener('click', function () {
          write([]);
          renderTray([]);
        });
      }
    }

    // Capture phase: run before the product card's own link/navigation handler so
    // a compare click is fully intercepted and never opens the PDP.
    document.addEventListener('click', onClick, true);
    renderTray(read());

    // Cards can appear after load (AJAX pagination / infinite scroll). Re-sync
    // CTA states when the DOM changes, coalesced to one pass per frame.
    if (window.MutationObserver) {
      var scheduled = false;
      var obs = new MutationObserver(function () {
        if (scheduled) return;
        scheduled = true;
        window.requestAnimationFrame(function () {
          scheduled = false;
          syncButtons(read());
        });
      });
      obs.observe(document.body, { childList: true, subtree: true });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
