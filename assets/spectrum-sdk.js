/**
 * Spectrum SDK — Centralised API layer for all platform interactions.
 *
 * Every Shopify storefront API call (cart, product, recommendations)
 * and Spectrum app proxy call (reviews, wishlist) should go through
 * this module instead of hitting endpoints directly. This decouples
 * business logic from the underlying platform, making it easier to
 * test, swap providers, or add cross-cutting concerns (logging,
 * retries, analytics) in one place.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * AI AGENT INSTRUCTIONS (Cursor / Claude / Codex)
 * ═══════════════════════════════════════════════════════════════════════
 *
 * RULE: Never call Shopify or app proxy endpoints directly. Always use
 * this SDK.
 *
 * Available via `window.Spectrum` (global). Ships verbatim to the merchant
 * theme as a classic `<script src>`; do not introduce ES module syntax
 * (`import`/`export`) here — the browser will refuse to parse the file.
 *
 * ── Cart ────────────────────────────────────────────────────────────
 *   Spectrum.cart.get()                          → cart JSON
 *   Spectrum.cart.add(items, { sections })        → add items (JSON body)
 *   Spectrum.cart.addFromForm(formData)            → add items (FormData body)
 *   Spectrum.cart.addAndOpen(items, opts)          → add + theme cart UI refresh
 *   Spectrum.cart.integrateAfterAdd(response, opts) → theme UI refresh from existing response
 *   Spectrum.cart.change(data, { sections })       → change line item qty
 *   Spectrum.cart.update(data, { sections })       → update attributes/note
 *   Spectrum.cart.clear()                          → empty the cart
 *   Spectrum.cart.applyCoupon(code)                → apply discount code
 *   All cart methods accept { signal } for AbortController support.
 *   Pass { sections: ['cart-drawer'] } to get rendered HTML in response.
 *   cart.add / cart.addFromForm auto-apply the best PA coupon code
 *   by scanning pa-data-* tags in the DOM (fire-and-forget).
 *   cart.addAndOpen / cart.integrateAfterAdd handle drawer-open + icon
 *   refresh + cart-update events brand-agnostically (Dawn-family native
 *   renderer + Horizon-family event dispatch + custom-theme cascade).
 *
 * ── Products ────────────────────────────────────────────────────────
 *   Spectrum.products.getByHandle(handle)         → product JSON
 *   Spectrum.products.getRecommendations(id, { intent, limit })
 *
 * ── Recently Viewed ─────────────────────────────────────────────────
 *   Spectrum.recentlyViewed.getHistory()          → string[] (handles, most-recent-first)
 *   Spectrum.recentlyViewed.push(handle)          → dedupe + prepend + cap at 20
 *   Spectrum.recentlyViewed.clear()               → wipe history
 *   Auto-tracks the current PDP product on SDK load via `/products/<handle>`
 *   URL match. Off-PDP pages skip the auto-push silently. localStorage-backed
 *   under `spectrum:rv:product-handles`; per-origin, per-device.
 *
 * ── Sections (HTML) ─────────────────────────────────────────────────
 *   Spectrum.sections.fetch(url)                  → rendered HTML string
 *
 * ── Platform ────────────────────────────────────────────────────────
 *   Spectrum.platform.loadFeatures(features)      → Shopify.loadFeatures
 *   Spectrum.platform.payments.init()             → PaymentButton.init
 *   Spectrum.platform.payments.isReady()          → bool
 *   Spectrum.platform.payments.expressInit()      → StorefrontExpressButtons
 *   Spectrum.platform.payments.isExpressReady()   → bool
 *   Spectrum.platform.xr.isReady                  → bool (getter)
 *   Spectrum.platform.xr.addModels(models)        → ShopifyXR.addModels
 *   Spectrum.platform.xr.setupElements()          → ShopifyXR.setupXRElements
 *   Spectrum.platform.xr.createModelViewer(el)    → new ModelViewerUI
 *
 * ── Price Adjustments ───────────────────────────────────────────────
 *   Spectrum.priceAdjustments.reinit()            → dispatches pa:reinit
 *   Spectrum.priceAdjustments.calcSavings(item, priceCents) → savings in cents
 *   Spectrum.priceAdjustments.findBest(items, priceCents)   → { item, savings }
 *   Spectrum.priceAdjustments.applyBestCoupon(items, priceCents)
 *     → find best discount, auto-apply its code (best-effort, never throws)
 *
 * ── Money ───────────────────────────────────────────────────────────
 *   Spectrum.money.format(cents, format?)         → formatted string
 *   Standalone formatter — does NOT depend on Shopify.formatMoney.
 *
 * ── Reviews (app proxy) ─────────────────────────────────────────────
 *   All return { ok, data } or { ok, error: { message, code } }.
 *   Spectrum.reviews.getReviews(handle, opts?)    → paginated reviews for a product
 *   Spectrum.reviews.getAllReviews(opts?)          → paginated reviews across all products
 *   Spectrum.reviews.getStats(handle)             → rating summary
 *   Spectrum.reviews.submitReview(data)           → create review
 *   Spectrum.reviews.voteOnReview(reviewId, type, opts?) → upvote/downvote
 *   Spectrum.reviews.uploadMedia(file)            → upload image/video
 *
 * ── Wishlist (app proxy) ────────────────────────────────────────────
 *   All return { ok, data } or { ok, error: { message, code } }.
 *   Guest visitors use localStorage; items auto-merge on login.
 *   Spectrum.wishlist.getWishlists(opts?)         → list wishlists
 *   Spectrum.wishlist.createWishlist(name)        → create wishlist
 *   Spectrum.wishlist.updateWishlist(id, data)    → rename etc.
 *   Spectrum.wishlist.deleteWishlist(id)          → delete wishlist
 *   Spectrum.wishlist.addItem(wishlistId, data)   → add (guest-aware)
 *   Spectrum.wishlist.addItemToCart(wishlistId, item, opts?) → add saved item to cart + track wishlist intent
 *   Spectrum.wishlist.removeItem(wId, itemId)     → remove item
 *   Spectrum.wishlist.updateItem(wId, itemId, d)  → update item
 *   Spectrum.wishlist.removeByProduct(productGid) → remove (guest-aware)
 *   Spectrum.wishlist.getShared(shareToken, opts?) → shared wishlist
 *
 * ── Search (app proxy) ────────────────────────────────────────────
 *   All return { ok, data } or { ok, error: { message, code } }.
 *   Backend envelope { success, data } is unwrapped automatically.
 *   Spectrum.search.query(q, opts?)               → search results
 *   Spectrum.search.getFacets(q, opts?)            → facet distributions
 *   Spectrum.search.predictive(q, opts?)           → auto-cancel + cached
 *   Spectrum.search.autoComplete(q, opts?)         → typeahead suggestions, auto-cancel
 *   Spectrum.search.getRecent()                    → recent queries (localStorage)
 *   Spectrum.search.addRecent(query)               → save to recent history
 *   Spectrum.search.recommendInlineFilters(q, opts?) → recommended inline filters
 *   Spectrum.search.clearRecent()                  → clear recent history
 *   query/predictive accept { sort, page, hitsPerPage, filters, signal }.
 *   Filters use backend syntax: { 'filter.v.vendor': 'Nike', 'filter.v.price.lte': '200' }
 *   predictive() aborts previous in-flight request; returns null if cancelled.
 *   Redirect responses auto-navigate via window.location.href.
 *
 * ── Configuration ───────────────────────────────────────────────────
 *   Spectrum.configure({ root, moneyFormat })     → override defaults
 *   Call once at theme init if the store uses non-standard routes or
 *   a custom money format. Omit to auto-detect from Shopify globals.
 *   App proxy URL and customer are read from window.__spectrumAi.
 *
 * ── Events ───────────────────────────────────────────────────────────
 *   Spectrum.events.emit(name, detail)            → dispatch custom event
 *   Spectrum.events.on(name, callback) → unsub    → listen; returns unsubscribe
 *   Spectrum.events.off(name, callback)           → remove listener
 *   Events use the app embed's event bus ($spectrum: prefix, on document).
 *   Naming: 'domain:action' kebab-case (e.g. 'wishlist:added').
 *
 *   Event catalog — events spectrum-sdk.js dispatches on `document`.
 *   Subscribe with `Spectrum.events.on(name, cb)` (omit the $spectrum: prefix).
 *
 *   @event $spectrum:wishlist:added         detail = { shopifyProductGid, shopifyVariantGid?, title?, image? }
 *   @event $spectrum:wishlist:removed       detail = { wishlistId, itemId } | { shopifyProductGid }
 *   @event $spectrum:wishlist:cleared       detail = { wishlistId }
 *   @event $spectrum:wishlist:item:updated  detail = { wishlistId, itemId, changes }
 *   @event $spectrum:wishlist:merged        detail = {}
 *   @event $spectrum:review:submitted       detail = <raw caller review payload>
 *   @event $spectrum:review:voted           detail = { reviewId, voteType, __spectrumVariant? }
 *
 *   Also dispatched (non-$spectrum prefixed):
 *   @event pa:reinit                        on `document`. Manual trigger to re-evaluate
 *                                           personalisation actions after a coupon apply.
 *   @event spectrum-video:{name}            on the <spectrum-video> element (bubbles).
 *                                           Lifecycle: loaded, error, play, pause, mute, unmute, unloaded.
 *
 * ── Native (Mobile WebView) ──────────────────────────────────────────
 *   Spectrum.native.getCheckoutUrl({ cartType, slug })
 *     → Promise<string>  Resolved checkout URL for the user's current cart.
 *   - cartType: 'default' (Shopify Ajax) | 'bundle'  (default: 'default')
 *   - slug:     required when cartType !== 'default'
 *   Throws on resolver failure. Used by the mobile WebView shell to hand a
 *   URL to ShopifyCheckoutSheetKit. Web traffic never calls this.
 *
 *   Spectrum.native.expressCheckout({ lines, discountCodes? })
 *     → Promise<{ok, data?:{checkoutUrl, cartId}, error?}>
 *   lines: [{variantId, quantity?}]. Creates a standalone cart via
 *   Storefront API (app proxy). Does NOT touch the user's browsing cart.
 *
 * ── Currency ──────────────────────────────────────────────────────────
 *   Spectrum.getActiveCurrency()                  → ISO 4217 code or undefined
 *   Returns window.Shopify.currency.active — the customer's
 *   presentation currency. Use in analytics payloads and price formatting.
 *
 * ── Version ──────────────────────────────────────────────────────────
 *   Spectrum.VERSION                              → semver string
 *
 * ── What does NOT belong here ───────────────────────────────────────
 *   • Trivial property reads (Shopify.designMode, Shopify.shop, etc.)
 *   • Generic DOM utilities (postLink, CountryProvinceSelector)
 *   • Custom pub/sub beyond Spectrum's event bus — each store owns its own
 *     (_track() fires analytics; _emit() fires custom events as cross-cutting concerns)
 *   • Third-party app integrations (Extend, Bold, Nosto, etc.)
 *   • UI component wiring that doesn't touch a platform API
 *
 * When adding new methods, ask: "Does this wrap a platform API call
 * with meaningful value (error handling, config, null-safety)?"
 * If it's just aliasing a one-liner global read, it doesn't belong.
 * ═══════════════════════════════════════════════════════════════════════
 */

// ─── Configuration ───────────────────────────────────────────────────

/*
 * The entire SDK runs inside this IIFE so its top-level declarations
 * (cart, products, sections, money, …) stay private and never enter the
 * page's shared global lexical scope. Only `window.Spectrum` is exposed.
 *
 * Without the wrapper a top-level `const cart` lands in global scope and
 * collides with any other global `cart` on the page (e.g. the edge
 * bundle's cart.js), throwing "Identifier 'cart' has already been
 * declared" — a SyntaxError that aborts this whole file before it can
 * assign `window.Spectrum`, silently breaking every storefront API call.
 */
;(function () {

// Idempotent boot. A theme can carry more than one <script> tag for this
// file (a hand-installed copy alongside the managed SPECTRUM_AI_INFRA
// render, or a classic tag plus a type="module" tag — the browser fetches
// one cached body but executes each tag separately). Re-running the IIFE
// would re-fire boot side effects (recently-viewed push, guest-wishlist
// merge, their _track events), so the first boot wins and later tags no-op.
if (window.Spectrum) return;

const VERSION = '1.10.1';

const _config = {};

/**
 * Override SDK defaults. Call once during theme initialisation.
 * @param {Object}  options
 * @param {string}  [options.root]        Root path prefix (default: Shopify routes root)
 * @param {string}  [options.moneyFormat] Shopify money_format string (default: theme.money_format)
 */
function configure(options = {}) {
  Object.assign(_config, options);
}

function _root() {
  return _config.root || window.Shopify?.routes?.root || '/';
}

function _defaultMoneyFormat() {
  return _config.moneyFormat || window.theme?.money_format || '{{amount}}';
}

// ─── Internal Helpers — Shopify API ──────────────────────────────────

const _JSON_HEADERS = { 'Content-Type': 'application/json' };

/**
 * Shared fetch wrapper for all Shopify JSON API calls.
 *
 * - Prepends the Shopify root path to the endpoint
 * - Serialises body as JSON when provided (passes FormData as-is)
 * - Throws on HTTP errors, preferring the server's `description` field
 * - Normalises Shopify's non-standard pattern of returning HTTP 200
 *   with { status: 422, description: "…" } in the body
 */
async function _request(endpoint, { method = 'GET', body, signal } = {}) {
  const options = { method, signal };

  if (body !== undefined) {
    if (body instanceof FormData) {
      options.body = body;
    } else {
      options.headers = _JSON_HEADERS;
      options.body = JSON.stringify(body);
    }
  }

  const res = await fetch(`${_root()}${endpoint}`, options);

  if (!res.ok) {
    let message = `Request to ${endpoint} failed (${res.status})`;
    try {
      const data = await res.json();
      if (data.description) message = data.description;
    } catch {}
    throw new Error(message);
  }

  const data = await res.json();

  if (typeof data.status === 'number' && data.status >= 400 && data.description) {
    throw new Error(data.description);
  }

  return data;
}

/**
 * Shared fetch wrapper for endpoints that return HTML (section rendering).
 * Throws on non-2xx responses.
 */
async function _requestHTML(url, { signal } = {}) {
  const res = await fetch(url, { signal });
  if (!res.ok) {
    throw new Error(`Section request failed (${res.status})`);
  }
  return res.text();
}

// ─── Internal Helpers — App Proxy ────────────────────────────────────

function _proxyBase() {
  const url = window.__spectrumAi?.baseProxyUrl;
  return url ? url.replace(/\/+$/, '') : null;
}

function _customer() {
  return window.__spectrumAi?.customer || null;
}

function _isLoggedIn() {
  return !!_customer();
}

function _normalizeSuccess(data) {
  return { ok: true, data };
}

function _normalizeError(raw, fallbackCode) {
  let message = 'Unknown error';
  let code = fallbackCode || 'UNKNOWN';

  if (raw && typeof raw === 'object') {
    if (typeof raw.error === 'string') message = raw.error;
    else if (typeof raw.message === 'string') message = raw.message;
    if (typeof raw.code === 'string') code = raw.code;
  } else if (typeof raw === 'string') {
    message = raw;
  }

  return { ok: false, error: { message, code } };
}

function _pickDefined(obj) {
  if (!obj) return {};
  const result = {};
  for (const k of Object.keys(obj)) {
    if (obj[k] !== undefined && obj[k] !== null) result[k] = obj[k];
  }
  return result;
}

function _toQueryString(params) {
  if (!params) return '';
  return Object.keys(params)
    .filter((k) => params[k] !== undefined && params[k] !== null)
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`)
    .join('&');
}

function _buildUrl(base, path, queryParams) {
  let url = base + (path || '');
  const qs = _toQueryString(queryParams);
  if (qs) url += '?' + qs;
  return url;
}

async function _getJSON(url, { signal } = {}) {
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      credentials: 'same-origin',
      signal,
    });
    const body = await res.json();
    if (!res.ok) return _normalizeError(body, `HTTP_${res.status}`);
    return _normalizeSuccess(body);
  } catch (err) {
    if (err.name === 'AbortError') {
      return _normalizeError({ error: 'Request aborted', code: 'ABORTED' }, 'ABORTED');
    }
    return _normalizeError({ error: err.message, code: 'NETWORK_ERROR' }, 'NETWORK_ERROR');
  }
}

async function _postJSON(url, body, { signal } = {}) {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body),
      signal,
    });
    const data = await res.json();
    if (!res.ok) return _normalizeError(data, `HTTP_${res.status}`);
    return _normalizeSuccess(data);
  } catch (err) {
    if (err.name === 'AbortError') {
      return _normalizeError({ error: 'Request aborted', code: 'ABORTED' }, 'ABORTED');
    }
    return _normalizeError({ error: err.message, code: 'NETWORK_ERROR' }, 'NETWORK_ERROR');
  }
}

async function _postFormData(url, formData, { signal } = {}) {
  try {
    const res = await fetch(url, {
      method: 'POST',
      credentials: 'same-origin',
      body: formData,
      signal,
    });
    const data = await res.json();
    if (!res.ok) return _normalizeError(data, `HTTP_${res.status}`);
    return _normalizeSuccess(data);
  } catch (err) {
    if (err.name === 'AbortError') {
      return _normalizeError({ error: 'Request aborted', code: 'ABORTED' }, 'ABORTED');
    }
    return _normalizeError({ error: err.message, code: 'NETWORK_ERROR' }, 'NETWORK_ERROR');
  }
}

// ─── Internal — Analytics ────────────────────────────────────────────

/**
 * Fire an analytics event via the Spectrum web pixel pipeline.
 * Fire-and-forget — never throws, never blocks.
 * Events arrive in PostHog as `$spectrum:{name}`.
 *
 * @param {string} name  Event name in snake_case (e.g. 'wishlist_add')
 * @param {Object} [properties]  Feature-specific properties (camelCase keys)
 */
function _track(name, properties) {
  try { window.__spectrumAi?.analytics?.trackEvent(name, properties); } catch (_) { /* silent */ }
}

// ─── Internal — Events ──────────────────────────────────────────────

/**
 * Dispatch a custom JS event via the Spectrum app embed event bus.
 * Fire-and-forget — never throws, never blocks.
 * Events arrive on `document` as `$spectrum:{name}`.
 *
 * @param {string} name   Event name in domain:action format (e.g. 'wishlist:added')
 * @param {Object} [detail]  Event payload (flat object, camelCase keys)
 */
function _emit(name, detail) {
  try { window.__spectrumAi?.emit?.(name, detail); } catch (_) { /* silent */ }
}

/** Extract numeric ID from a Shopify GID (e.g. 'gid://shopify/Product/123' → '123'). */
function _numericId(gid) { return gid?.split('/').pop() || gid; }

/** Active storefront currency code (ISO 4217). Reflects the customer's presentation currency. */
function _currency() { return window.Shopify?.currency?.active; }

/** Build properties for the wishlist_add event. */
function _wishlistAddProps(wishlistId, data, guest) {
  const props = { product: { id: _numericId(data.shopifyProductGid) }, wishlistId, guest };
  if (data.handle) props.product.handle = data.handle;
  if (data.title) props.product.title = data.title;
  if (data.image) props.product.image = data.image;
  if (data.shopifyVariantGid) props.variant = { id: _numericId(data.shopifyVariantGid) };
  if (data.metadata?.priceAtAdd != null) {
    props.price = { amount: data.metadata.priceAtAdd, currencyCode: data.metadata.currencyCode };
  }
  return props;
}

function _wishlistCartVariantId(item, opts) {
  const raw =
    opts?.variant_id ??
    opts?.variantId ??
    opts?.shopify_variant_id ??
    opts?.shopifyVariantId ??
    opts?.shopifyVariantGid ??
    item?.variant_id ??
    item?.variantId ??
    item?.shopify_variant_id ??
    item?.shopifyVariantId ??
    item?.shopifyVariantGid;
  return _numericId(raw);
}

function _wishlistAddToCartProps(wishlistId, item, line, opts) {
  const metadata = item?.metadata && typeof item.metadata === 'object' ? item.metadata : {};
  return _pickDefined({
    wishlist_id: wishlistId ?? item?.wishlistId ?? item?.wishlist_id,
    wishlist_item_id: opts?.wishlist_item_id ?? opts?.wishlistItemId ?? item?.itemId ?? item?.id,
    product_id: _numericId(
      opts?.product_id ??
      opts?.productId ??
      opts?.shopify_product_id ??
      opts?.shopifyProductId ??
      opts?.shopifyProductGid ??
      item?.product_id ??
      item?.productId ??
      item?.shopify_product_id ??
      item?.shopifyProductId ??
      item?.shopifyProductGid,
    ),
    product_handle: opts?.product_handle ?? opts?.productHandle ?? item?.handle ?? item?.productHandle,
    product_title: opts?.product_title ?? opts?.productTitle ?? item?.title,
    variant_id: _numericId(line?.id),
    quantity: Number(line?.quantity || 1),
    guest: opts?.guest ?? !_isLoggedIn(),
    surface: opts?.surface ?? item?.surface ?? metadata.surface,
    placement: opts?.placement ?? item?.placement ?? metadata.placement,
  });
}

// ─── Internal — PA Auto-Apply ────────────────────────────────────────

/**
 * Scan all pa-data-* script tags in the DOM, find the best discount
 * that has a coupon code, and apply it. Fire-and-forget — never throws.
 * Called automatically after cart.add / cart.addFromForm.
 */
function _autoApplyBestCoupon() {
  try {
    const tags = document.querySelectorAll('script[id^="pa-data-"]');
    let bestCode = null;
    let bestSavings = 0;

    for (const tag of tags) {
      let items;
      try { items = JSON.parse(tag.textContent); } catch { continue; }
      if (!Array.isArray(items) || !items.length) continue;

      const key = tag.id.replace('pa-data-', '');
      const priceEl = document.querySelector(`[data-pa-id="${key}"]`);
      const priceCents = priceEl
        ? parseInt(priceEl.getAttribute('data-variant-price'), 10)
        : 0;
      if (!priceCents) continue;

      for (const item of items) {
        if (!item.code) continue;
        const savings = priceAdjustments.calcSavings(item, priceCents);
        if (savings > bestSavings) {
          bestSavings = savings;
          bestCode = item.code;
        }
      }
    }

    if (bestCode) cart.applyCoupon(bestCode);
  } catch {}
}

// ─── Internal — Cart Theme Integration ───────────────────────────────
//
// Shared post-cart-add behavior for snippets that ship their own ATC button
// and therefore bypass the theme's product form. Replays the moves the
// theme's native chain would have done — section refresh + drawer open +
// cart-update event dispatch — across Dawn-family, Horizon-family, and the
// long tail of customized themes.
//
// Two entry shapes:
//   Spectrum.cart.addAndOpen(items, opts)   → the common case
//   Spectrum.cart.integrateAfterAdd(response, items) → if the caller already
//                                              did the add and wants only
//                                              the post-add integration
//
// Design notes:
//   - Native render path tried first. Dawn-family <cart-drawer> /
//     <cart-notification> expose renderContents(parsedState) which does
//     section-swap + remove-is-empty + open in one call. Piggy-backing on
//     that gives parity with the theme's own product-form.js after-add
//     chain (right anchor selectors, right class state, right focus trap).
//   - Manual fallback covers Horizon (its <cart-drawer> auto-opens on
//     document `cart:update` when auto-open attr is set) and custom themes
//     (best-effort section swap + 6-tier drawer-open cascade).
//   - Defensive Dawn error-icon hide compensates for an async CSS race:
//     Dawn loads component-cart-items.css with `media="print"
//     onload="this.media='all'"`, so on a fast ATC the inline error <svg>
//     can render at container-fill size before its width:1.2rem and
//     :empty+svg{display:none} rules apply. We mirror that rule
//     programmatically.

function _detectThemeCartSections() {
  const ids = new Set();
  const addEnclosingSection = (el) => {
    const section = el?.closest?.('[id^="shopify-section-"]');
    if (section?.id) ids.add(section.id.replace('shopify-section-', ''));
  };
  addEnclosingSection(
    document.querySelector(
      'cart-drawer, dialog.cart-drawer__dialog, dialog[class*="cart-drawer" i], [class*="cart-drawer__inner" i]',
    ),
  );
  addEnclosingSection(document.querySelector('cart-icon, [class*="cart-icon" i]'));
  return [...ids];
}

function _cartSectionsToRequest() {
  // Shopify caps `sections` at 5. Pick names matching the theme's cart mode
  // — Dawn merchants choose drawer OR notification in theme settings and
  // only one is rendered. Detected IDs cover Sense / Shopify 2.0 where the
  // drawer or icon lives inside a theme-generated section id like
  // `sections--12345__header_section`.
  const hasNotification = !!document.querySelector('cart-notification');
  const hasDrawer = !!document.querySelector('cart-drawer');
  const standard =
    hasNotification && !hasDrawer
      ? ['cart-notification-product', 'cart-notification-button', 'cart-icon-bubble']
      : ['cart-drawer', 'cart-icon-bubble', 'cart-notification'];
  const detected = _detectThemeCartSections();
  return [...new Set([...detected, ...standard])].slice(0, 5);
}

function _applyCartSections(sections) {
  // Replace inner HTML of every section the theme has installed under one
  // of the returned names. Trust boundary: HTML comes from the same-origin
  // Shopify section-render endpoint where merchant- and shopper-controlled
  // fields are server-side `| escape`'d by the theme.
  if (!sections || typeof sections !== 'object') return;
  for (const [sectionId, html] of Object.entries(sections)) {
    if (typeof html !== 'string' || !html) continue;
    const target = document.getElementById(`shopify-section-${sectionId}`);
    if (!target) continue;
    try {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const incoming = doc.getElementById(`shopify-section-${sectionId}`);
      if (incoming) target.innerHTML = incoming.innerHTML;
    } catch {
      /* malformed section html — leave DOM untouched */
    }
  }
}

async function _refreshDetectedSections() {
  const detected = _detectThemeCartSections();
  if (detected.length === 0) return;
  const path = window.location.pathname || '/';
  try {
    const res = await fetch(
      `${path}?sections=${encodeURIComponent(detected.slice(0, 5).join(','))}`,
      { credentials: 'same-origin' },
    );
    if (!res.ok) return;
    const sections = await res.json().catch(() => null);
    _applyCartSections(sections);
  } catch {
    /* network blip — leave DOM untouched */
  }
}

function _openCartDrawer() {
  // 1. Dawn-derived: <cart-drawer> with open()/show()/showDialog()/openDrawer().
  //    Horizon's element exposes showDialog(), not open() — try all four so
  //    we cover Dawn-family AND Horizon-family with one tier.
  const cartDrawerEl = document.querySelector('cart-drawer');
  if (cartDrawerEl) {
    for (const method of ['open', 'show', 'showDialog', 'openDrawer']) {
      if (typeof cartDrawerEl[method] === 'function') {
        try {
          cartDrawerEl[method]();
          return true;
        } catch {
          /* try next method */
        }
      }
    }
  }
  // 2. <cart-notification> bubble (Dawn's non-drawer variant).
  const cartNotificationEl = document.querySelector('cart-notification');
  if (cartNotificationEl && typeof cartNotificationEl.open === 'function') {
    try {
      cartNotificationEl.open();
      return true;
    } catch {
      /* fall through */
    }
  }
  // 3. ARIA-wired toggle.
  const ariaToggle = document.querySelector(
    '[aria-controls="cart-drawer"], [aria-controls="CartDrawer"]',
  );
  if (ariaToggle instanceof HTMLElement) {
    ariaToggle.click();
    return true;
  }
  // 4. data-attribute toggles seen in third-party themes.
  const dataToggle = document.querySelector(
    '[data-cart-drawer-toggle], [data-action="open-cart"]',
  );
  if (dataToggle instanceof HTMLElement) {
    dataToggle.click();
    return true;
  }
  // 5. Sense-style: <cart-icon> wrapped in a header button.
  const cartIconEl = document.querySelector('cart-icon');
  const cartIconButton =
    cartIconEl?.closest('button, a') ||
    document.querySelector('button:has(cart-icon), a:has(cart-icon)');
  if (cartIconButton instanceof HTMLElement) {
    cartIconButton.click();
    return true;
  }
  // 6. Native <dialog> last-ditch.
  const cartDialog = document.querySelector(
    'dialog.cart-drawer__dialog, dialog[class*="cart-drawer" i]',
  );
  if (cartDialog instanceof HTMLDialogElement && !cartDialog.open) {
    try {
      cartDialog.showModal();
      return true;
    } catch {
      /* dialog not ready */
    }
  }
  return false;
}

function _dispatchCartUpdateEvents({ items, sections, sourceId }) {
  // `cart:update` is load-bearing for Horizon (matches its
  // CartAddEvent.eventName). The rest cover Dawn-family and themes with
  // their own pub/sub bridges (Klaviyo, etc.).
  const detail = {
    resource: 'cart',
    sourceId: sourceId || 'spectrum-sdk',
    data: { items, sections },
  };
  const names = ['cart:update', 'cart:updated', 'cart:refresh', 'cart:item-added', 'cart:build'];
  for (const name of names) {
    try {
      document.dispatchEvent(new CustomEvent(name, { detail, bubbles: true }));
    } catch {
      /* ignore */
    }
    try {
      window.dispatchEvent(new CustomEvent(name, { detail }));
    } catch {
      /* ignore */
    }
  }
}

// Dawn-family themes load `component-cart-items.css` via the async
// `media="print" onload="this.media='all'"` pattern in their header
// section. When the snippet's ATC fires fast and the theme's
// renderContents() injects new line-item DOM, that stylesheet may not
// have applied yet — which produces two visible regressions we keep
// seeing in the field:
//
//   - The line-item error <svg viewBox="0 0 13 13"> has no width/height
//     attributes. Without `.cart-item__error-text + svg { width: 1.2rem }`
//     and `.cart-item__error-text:empty + svg { display: none }`, it
//     renders at container-fill size — a giant red "!" icon takes over
//     the line.
//   - The product-option dt/dd pairs (e.g. "Color: Ice") expect
//     `.product-option * { display: inline }`. Without it they fall back
//     to default block display and stack vertically with `<dl>` margins.
//
// We mirror the offending rules into an inline `<style>` injected into
// the document head once on first integration call. The block is
// idempotent (data-attribute guarded), Dawn-specific (the class names
// don't collide with non-Dawn themes), and class-name-keyed so it
// no-ops on themes that don't use the markup.

let _dawnCartFixInjected = false;

function _ensureDawnCartFixStyle() {
  if (_dawnCartFixInjected) return;
  if (document.querySelector('style[data-spectrum-cart-fix]')) {
    _dawnCartFixInjected = true;
    return;
  }
  const style = document.createElement('style');
  style.setAttribute('data-spectrum-cart-fix', '');
  style.textContent = `
    .product-option { font-size: 1.4rem; word-break: break-word; }
    .product-option * { display: inline; margin: 0; }
    .product-option + .product-option { margin-top: 0.4rem; }
    .cart-item__error { display: flex; align-items: flex-start; margin-top: 1rem; }
    .cart-item__error-text { font-size: 1.2rem; }
    .cart-item__error-text + svg { flex-shrink: 0; width: 1.2rem; margin-right: 0.7rem; }
    .cart-item__error-text:empty + svg { display: none; }
  `;
  (document.head || document.documentElement).appendChild(style);
  _dawnCartFixInjected = true;
}

async function _integrateCartAdd(cartResponse, items, sourceId) {
  // Inject the Dawn cart-fix style once per page before any DOM mutation.
  // Idempotent; no-op on non-Dawn themes (class-name-keyed).
  _ensureDawnCartFixStyle();

  const sections = cartResponse?.sections;

  // Preferred path: hand the response to the theme's own renderer. Dawn-
  // family `<cart-drawer>.renderContents()` / `<cart-notification>
  // .renderContents()` do section-swap + remove `is-empty` from
  // `.drawer__inner` + call `.open()` in one call. We additionally clear
  // `is-empty` from the host element (stock Dawn's product-form.js does
  // this in its `finally{}`) — `renderContents` itself doesn't.
  if (sections) {
    const drawer = document.querySelector('cart-drawer');
    if (drawer && typeof drawer.renderContents === 'function') {
      try {
        drawer.renderContents(cartResponse);
        if (drawer.classList.contains('is-empty')) drawer.classList.remove('is-empty');
        _dispatchCartUpdateEvents({ items, sections, sourceId });
        return;
      } catch {
        /* fall through to manual path */
      }
    }
    const notification = document.querySelector('cart-notification');
    if (notification && typeof notification.renderContents === 'function') {
      try {
        notification.renderContents(cartResponse);
        if (notification.classList.contains('is-empty')) notification.classList.remove('is-empty');
        _dispatchCartUpdateEvents({ items, sections, sourceId });
        return;
      } catch {
        /* fall through to manual path */
      }
    }
  }

  // Manual fallback: section swap + cascade open + event firehose. Covers
  // Horizon-family (drawer auto-opens on document `cart:update`), themes
  // whose drawer doesn't expose `renderContents`, and any theme with its
  // own pub/sub.
  _applyCartSections(sections);
  await _refreshDetectedSections();
  _openCartDrawer();
  _dispatchCartUpdateEvents({ items, sections, sourceId });
}

// ─── Cart ────────────────────────────────────────────────────────────

const cart = {
  /**
   * Fetch the current cart.
   * @param {Object}       [opts]
   * @param {AbortSignal}  [opts.signal]
   * @returns {Promise<Object>} Full cart object
   */
  get({ signal } = {}) {
    return _request('cart.js', { signal });
  },

  /**
   * Add one or more items to the cart.
   * After a successful add, auto-applies the best PA coupon from the DOM.
   * @param {Object|Object[]} items  Single item or array of { id, quantity, properties? }
   * @param {Object}           [opts]
   * @param {string|string[]}  [opts.sections]  Section IDs to include rendered HTML in response
   * @param {AbortSignal}      [opts.signal]
   * @returns {Promise<Object>} The added-items response (includes `sections` if requested)
   * @throws {Error} With a user-facing message on failure
   */
  async add(items, { signal, sections } = {}) {
    const payload = Array.isArray(items) ? items : [items];
    const body = { items: payload };
    if (sections) body.sections = sections;
    const result = await _request('cart/add.js', { method: 'POST', body, signal });
    _emit('cart:added', { items: payload, response: result });
    _emit('cart:updated', { source: 'add', response: result });
    _autoApplyBestCoupon();
    return result;
  },

  /**
   * Add to cart from a FormData object (e.g. from a product <form>).
   * After a successful add, auto-applies the best PA coupon from the DOM.
   * @param {FormData}     formData
   * @param {Object}       [opts]
   * @param {AbortSignal}  [opts.signal]
   * @returns {Promise<Object>} The added-items response
   */
  async addFromForm(formData, { signal } = {}) {
    const result = await _request('cart/add.js', { method: 'POST', body: formData, signal });
    _emit('cart:added', { source: 'form', response: result });
    _emit('cart:updated', { source: 'add', response: result });
    _autoApplyBestCoupon();
    return result;
  },

  /**
   * Add items, then integrate with the theme's cart UI: section refresh +
   * drawer (or notification) open + cart-update events. Use this from any
   * snippet that ships its own ATC button and therefore bypasses the
   * theme's product form.
   *
   * Behavior is brand-agnostic — picks the theme's native renderer when
   * available (Dawn-family `<cart-drawer>.renderContents()` / `<cart-
   * notification>.renderContents()`) and falls back to a manual section
   * swap + a tiered drawer-open cascade + a cart-update event firehose
   * (covers Horizon-family and the long tail). On failure to add, throws
   * via `cart.add`'s existing behavior.
   *
   * @param {Object|Object[]} items  Single item or array of { id, quantity, properties? }
   * @param {Object}           [opts]
   * @param {string|string[]}  [opts.sections] Override the auto-detected section list (rarely needed)
   * @param {string}           [opts.sourceId] Tag for the cart-update events (default: 'spectrum-sdk')
   * @param {AbortSignal}      [opts.signal]
   * @returns {Promise<Object>} The cart-add response (includes `sections`)
   */
  async addAndOpen(items, { signal, sections, sourceId } = {}) {
    const itemsArray = Array.isArray(items) ? items : [items];
    const sectionsToRequest = sections || _cartSectionsToRequest();
    const response = await this.add(itemsArray, { signal, sections: sectionsToRequest });
    if (response && response.ok === false) return response;
    await _integrateCartAdd(response, itemsArray, sourceId);
    return response;
  },

  /**
   * Run only the post-add integration on an existing cart-add response.
   * Useful when the caller already invoked `cart.add` (or `cart.addFromForm`)
   * and now wants the drawer/icon/events handled.
   *
   * @param {Object} cartResponse  The response returned by cart.add / cart.addFromForm
   * @param {Object} [opts]
   * @param {Object|Object[]} [opts.items]    Original items (passed to cart-update event payload)
   * @param {string}          [opts.sourceId] Tag for the cart-update events (default: 'spectrum-sdk')
   */
  async integrateAfterAdd(cartResponse, { items, sourceId } = {}) {
    const itemsArray = items ? (Array.isArray(items) ? items : [items]) : [];
    await _integrateCartAdd(cartResponse, itemsArray, sourceId);
  },

  /**
   * Change a line item's quantity.
   * @param {Object}           data          { line, quantity } or { id, quantity }
   * @param {Object}           [opts]
   * @param {string|string[]}  [opts.sections]  Section IDs to include rendered HTML in response
   * @param {AbortSignal}      [opts.signal]
   * @returns {Promise<Object>} Updated cart (includes `sections` if requested)
   * @throws {Error} On failure (including quantity limits, out-of-stock, etc.)
   */
  async change(data, { signal, sections } = {}) {
    const body = sections ? { ...data, sections } : data;
    const result = await _request('cart/change.js', { method: 'POST', body, signal });
    const removed = Number(data && data.quantity) === 0;
    _emit(removed ? 'cart:removed' : 'cart:updated', { source: 'change', request: data, response: result });
    return result;
  },

  /**
   * Update cart attributes, line items, or note.
   * @param {Object}           data          { attributes?, updates?, note? }
   * @param {Object}           [opts]
   * @param {string|string[]}  [opts.sections]  Section IDs to include rendered HTML in response
   * @param {AbortSignal}      [opts.signal]
   * @returns {Promise<Object>} Updated cart (includes `sections` if requested)
   */
  async update(data, { signal, sections } = {}) {
    const body = sections ? { ...data, sections } : data;
    const result = await _request('cart/update.js', { method: 'POST', body, signal });
    _emit('cart:updated', { source: 'update', request: data, response: result });
    return result;
  },

  /**
   * Remove all items from the cart.
   * @param {Object}       [opts]
   * @param {AbortSignal}  [opts.signal]
   * @returns {Promise<Object>} Empty cart
   */
  async clear({ signal } = {}) {
    const result = await _request('cart/clear.js', { method: 'POST', signal });
    _emit('cart:removed', { source: 'clear', response: result });
    _emit('cart:updated', { source: 'clear', response: result });
    return result;
  },

  /**
   * Apply a discount code to the current cart via Shopify's /discount endpoint.
   * @param {string} code  Discount / coupon code
   * @returns {Promise<boolean>} true if the request succeeded
   */
  async applyCoupon(code) {
    if (!code) return false;
    try {
      await fetch(`${_root()}discount/${encodeURIComponent(code)}`);
      _emit('cart:updated', { source: 'applyCoupon', code });
      return true;
    } catch {
      return false;
    }
  },
};

// ─── Products ────────────────────────────────────────────────────────

const products = {
  /**
   * Fetch product JSON by handle.
   * @param {string}       handle  Product handle (URL slug)
   * @param {Object}       [opts]
   * @param {AbortSignal}  [opts.signal]
   * @returns {Promise<Object>} Full product object
   */
  getByHandle(handle, { signal } = {}) {
    return _request(`products/${handle}.js`, { signal });
  },

  /**
   * Fetch product recommendations.
   * @param {string|number} productId
   * @param {Object}        [opts]
   * @param {string}        [opts.intent='related'] 'related' | 'complementary'
   * @param {number}        [opts.limit]   Max number of products to return
   * @param {AbortSignal}   [opts.signal]
   * @returns {Promise<Object>} { products: [...] }
   */
  getRecommendations(productId, { intent = 'related', limit, signal } = {}) {
    let url = `recommendations/products.json?product_id=${productId}&intent=${intent}`;
    if (limit != null) url += `&limit=${limit}`;
    return _request(url, { signal });
  },
};

// ─── Recently Viewed Products ────────────────────────────────────────
//
// Client-side history of product handles the visitor has landed on. Shopify
// has no native recently-viewed surface (no Storefront field, no Liquid
// object, no Admin endpoint), so storefronts that need this — e.g. the
// Recently Viewed Products library snippet — read from here.
//
// Storage: localStorage under `spectrum:rv:product-handles`, capped at 20
// entries, most-recent-first, deduped. The auto-tracker below pushes the
// current product on every SDK load whose URL matches `/products/<handle>`.
// Theme-agnostic — no dependency on `ShopifyAnalytics.meta` or theme JS.

const _RV_STORAGE_KEY = 'spectrum:rv:product-handles';
const _RV_CAP = 20;

const recentlyViewed = {
  /**
   * Read the history list, most-recent-first. Returns an empty array when
   * storage is empty, corrupt, or denied (private mode, blocked origins).
   * @returns {string[]}
   */
  getHistory() {
    try {
      const raw = window.localStorage.getItem(_RV_STORAGE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((h) => typeof h === 'string' && h.length > 0);
    } catch {
      return [];
    }
  },

  /**
   * Prepend a handle, dedupe against existing entries, cap at 20. No-op for
   * empty / non-string input or when localStorage is denied.
   * @param {string} handle
   */
  push(handle) {
    if (typeof handle !== 'string' || handle === '') return;
    try {
      const current = recentlyViewed.getHistory();
      const filtered = current.filter((h) => h !== handle);
      const next = [handle, ...filtered].slice(0, _RV_CAP);
      window.localStorage.setItem(_RV_STORAGE_KEY, JSON.stringify(next));
    } catch {
      // localStorage unavailable; recently-viewed is best-effort.
    }
  },

  /**
   * Wipe the history.
   */
  clear() {
    try {
      window.localStorage.removeItem(_RV_STORAGE_KEY);
    } catch {}
  },
};

// ─── Sections (HTML rendering) ───────────────────────────────────────

const sections = {
  /**
   * Fetch a section's rendered HTML.
   * @param {string}       url
   * @param {Object}       [opts]
   * @param {AbortSignal}  [opts.signal]
   * @returns {Promise<string>} Raw HTML text
   */
  fetch(url, { signal } = {}) {
    return _requestHTML(url, { signal });
  },
};

// ─── Platform ────────────────────────────────────────────────────────

const platform = {
  /**
   * Lazy-load a Shopify platform feature (e.g. shopify-xr, model-viewer-ui).
   * @param {Array<{name:string, version:string, onLoad:Function}>} features
   */
  loadFeatures(features) {
    window.Shopify?.loadFeatures?.(features);
  },

  payments: {
    /** @returns {boolean} Whether the dynamic checkout button SDK is loaded */
    isReady() {
      return Boolean(window.Shopify?.PaymentButton);
    },

    /**
     * Initialise dynamic checkout (Buy Now) buttons.
     * @returns {boolean} true if initialisation ran, false if SDK not yet loaded
     */
    init() {
      if (window.Shopify?.PaymentButton) {
        window.Shopify.PaymentButton.init();
        return true;
      }
      return false;
    },

    /** @returns {boolean} Whether the Storefront Express Buttons SDK is loaded */
    isExpressReady() {
      return Boolean(window.Shopify?.StorefrontExpressButtons);
    },

    /**
     * Initialise Storefront Express Buttons (newer express checkout).
     * @returns {boolean} true if initialisation ran, false if SDK not yet loaded
     */
    expressInit() {
      if (window.Shopify?.StorefrontExpressButtons) {
        window.Shopify.StorefrontExpressButtons.initialize();
        return true;
      }
      return false;
    },
  },

  xr: {
    /** @returns {boolean} Whether the ShopifyXR runtime is loaded */
    get isReady() {
      return Boolean(window.ShopifyXR);
    },

    /** Register 3D models with the XR runtime. */
    addModels(models) {
      window.ShopifyXR?.addModels(models);
    },

    /** Attach XR interaction to model-viewer elements on the page. */
    setupElements() {
      window.ShopifyXR?.setupXRElements();
    },

    /**
     * Create a ModelViewerUI instance for a <model-viewer> element.
     * @param {Element} element
     * @returns {Object|null} ModelViewerUI instance, or null if not available
     */
    createModelViewer(element) {
      if (window.Shopify?.ModelViewerUI) {
        return new window.Shopify.ModelViewerUI(element);
      }
      return null;
    },
  },
};

// ─── Price Adjustments ───────────────────────────────────────────────

const priceAdjustments = {
  /** Re-apply price adjustments to any newly rendered product elements. */
  reinit() {
    document.dispatchEvent(new CustomEvent('pa:reinit'));
  },

  /**
   * Calculate savings in cents for a single PA item at a given price.
   * @param {{ code:string, discount_type:string, discount_value:number }} item
   * @param {number} priceCents  Variant price in cents
   * @returns {number} Savings in cents (0 if item is invalid)
   */
  calcSavings(item, priceCents) {
    if (!item?.discount_type || !item.discount_value) return 0;
    if (item.discount_type === 'percentage') {
      return Math.round(priceCents * item.discount_value / 100);
    }
    if (item.discount_type === 'amount' || item.discount_type === 'fixed') {
      return Math.round(item.discount_value * 100);
    }
    return 0;
  },

  /**
   * Find the PA item with the highest savings for a given price.
   * @param {Array}  items       PA items array from metafield data
   * @param {number} priceCents  Variant price in cents
   * @returns {{ item:Object, savings:number }|null}
   */
  findBest(items, priceCents) {
    if (!Array.isArray(items) || !priceCents) return null;
    let best = null;
    let bestSavings = 0;
    for (const item of items) {
      const savings = this.calcSavings(item, priceCents);
      if (savings > bestSavings) {
        bestSavings = savings;
        best = item;
      }
    }
    return best ? { item: best, savings: bestSavings } : null;
  },

  /**
   * Find the best discount from PA items and auto-apply its coupon code.
   * Best-effort: returns null silently on failure or if no code exists.
   * @param {Array}  items       PA items array from metafield data
   * @param {number} priceCents  Variant price in cents
   * @returns {Promise<{ item:Object, savings:number }|null>}
   */
  async applyBestCoupon(items, priceCents) {
    const best = this.findBest(items, priceCents);
    if (!best?.item.code) return null;
    try {
      const applied = await cart.applyCoupon(best.item.code);
      return applied ? best : null;
    } catch {
      return null;
    }
  },
};

// ─── Money Formatting ────────────────────────────────────────────────

function _formatWithDelimiters(cents, precision, thousands, decimal) {
  if (isNaN(cents) || cents == null) return '0';

  const fixed = (cents / 100).toFixed(precision);
  const parts = fixed.split('.');
  const dollars = parts[0].replace(/(\d)(?=(\d{3})+(?!\d))/g, `$1${thousands}`);
  const remainder = parts[1] ? `${decimal}${parts[1]}` : '';
  return dollars + remainder;
}

function _formatMoney(cents, format) {
  if (typeof cents === 'string') cents = cents.replace('.', '');
  cents = parseInt(cents, 10) || 0;

  const formatString = format || _defaultMoneyFormat();
  const placeholderRegex = /\{\{\s*(\w+)\s*\}\}/;
  const match = formatString.match(placeholderRegex);
  if (!match) return formatString;

  let value;
  switch (match[1]) {
    case 'amount':
      value = _formatWithDelimiters(cents, 2, ',', '.');
      break;
    case 'amount_no_decimals':
      value = _formatWithDelimiters(cents, 0, ',', '.');
      break;
    case 'amount_with_comma_separator':
      value = _formatWithDelimiters(cents, 2, '.', ',');
      break;
    case 'amount_no_decimals_with_comma_separator':
      value = _formatWithDelimiters(cents, 0, '.', ',');
      break;
    case 'amount_with_apostrophe_separator':
      value = _formatWithDelimiters(cents, 2, "'", '.');
      break;
    case 'amount_with_period_and_space_separator':
      value = _formatWithDelimiters(cents, 2, ' ', '.');
      break;
    default:
      value = _formatWithDelimiters(cents, 2, ',', '.');
  }

  return formatString.replace(placeholderRegex, value);
}

const money = {
  /**
   * Format cents into a locale-aware money string.
   * Uses a standalone formatter compatible with all Shopify money_format
   * placeholders — does not depend on Shopify.formatMoney being present.
   * @param {number|string} cents
   * @param {string}        [format]  Shopify money_format string; falls back to configured default
   * @returns {string}
   */
  format(cents, format) {
    return _formatMoney(cents, format);
  },
};

// ─── Internal — Guest Wishlist ───────────────────────────────────────

const _GUEST_STORAGE_KEY = '__spectrum_wishlist_guest';

function _getGuestItems() {
  try {
    const raw = localStorage.getItem(_GUEST_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.items) ? parsed.items : [];
  } catch {
    return [];
  }
}

function _addGuestItem(item) {
  try {
    const items = _getGuestItems();
    const isDuplicate = items.some(
      (existing) =>
        existing.shopifyProductGid === item.shopifyProductGid &&
        (existing.shopifyVariantGid || null) === (item.shopifyVariantGid || null),
    );
    if (isDuplicate) return;
    const entry = Object.assign({}, item);
    if (!entry.addedAt) entry.addedAt = new Date().toISOString();
    items.push(entry);
    localStorage.setItem(_GUEST_STORAGE_KEY, JSON.stringify({ items }));
  } catch {}
}

function _removeGuestItem(productGid) {
  try {
    const items = _getGuestItems();
    const filtered = items.filter((i) => i.shopifyProductGid !== productGid);
    localStorage.setItem(_GUEST_STORAGE_KEY, JSON.stringify({ items: filtered }));
  } catch {}
}

function _clearGuestItems() {
  try {
    localStorage.removeItem(_GUEST_STORAGE_KEY);
  } catch {}
}

function _mergeGuestToServer() {
  const base = _proxyBase();
  if (!base) return Promise.resolve(_normalizeError('Proxy not configured', 'NO_PROXY'));
  return _postJSON(_buildUrl(`${base}/wishlist`, '/merge'), { items: _getGuestItems() });
}

// ─── Reviews (App Proxy) ─────────────────────────────────────────────

const reviews = {
  /** @returns {Promise<{ok:boolean, data?:Object, error?:{message:string, code:string}}>} */
  async getReviews(productHandle, opts) {
    const base = _proxyBase();
    if (!base) return _normalizeError('Proxy not configured', 'NO_PROXY');
    return _getJSON(_buildUrl(`${base}/reviews`, `/${encodeURIComponent(productHandle)}`, _pickDefined(opts)));
  },

  async getAllReviews(opts) {
    const base = _proxyBase();
    if (!base) return _normalizeError('Proxy not configured', 'NO_PROXY');
    return _getJSON(_buildUrl(`${base}/reviews`, '/all', _pickDefined(opts)));
  },

  async submitReview(data) {
    const base = _proxyBase();
    if (!base) return _normalizeError('Proxy not configured', 'NO_PROXY');
    const result = await _postJSON(_buildUrl(`${base}/reviews`, ''), data);
    if (result.ok) {
      const product = {};
      if (data.productId != null) product.id = String(data.productId);
      if (data.productHandle) product.handle = data.productHandle;
      const props = {
        rating: data.rating,
        product: Object.keys(product).length > 0 ? product : undefined,
        mediaCount: Array.isArray(data.media) ? data.media.length : 0,
      };
      if (data.__spectrumVariant) props.__spectrumVariant = data.__spectrumVariant;
      _track('review_submit', props);
      _emit('review:submitted', data);
    }
    return result;
  },

  async voteOnReview(reviewId, voteType, opts) {
    const base = _proxyBase();
    if (!base) return _normalizeError('Proxy not configured', 'NO_PROXY');
    const result = await _postJSON(_buildUrl(`${base}/reviews`, `/${encodeURIComponent(reviewId)}/vote`), { voteType });
    if (result.ok) {
      const props = { reviewId, voteType };
      if (opts?.__spectrumVariant) props.__spectrumVariant = opts.__spectrumVariant;
      if (opts?.productId != null || opts?.productHandle) {
        props.product = {};
        if (opts.productId != null) props.product.id = String(opts.productId);
        if (opts.productHandle) props.product.handle = opts.productHandle;
      }
      _track('review_vote', props);
      const emitPayload = { reviewId, voteType };
      if (opts?.__spectrumVariant) emitPayload.__spectrumVariant = opts.__spectrumVariant;
      _emit('review:voted', emitPayload);
    }
    return result;
  },

  async getStats(productHandle) {
    const base = _proxyBase();
    if (!base) return _normalizeError('Proxy not configured', 'NO_PROXY');
    return _getJSON(_buildUrl(`${base}/reviews`, `/stats/${encodeURIComponent(productHandle)}`));
  },

  async uploadMedia(file) {
    const base = _proxyBase();
    if (!base) return _normalizeError('Proxy not configured', 'NO_PROXY');
    const formData = new FormData();
    formData.append('file', file);
    return _postFormData(_buildUrl(`${base}/reviews`, '/media/upload'), formData);
  },
};

// ─── Wishlist (App Proxy) ────────────────────────────────────────────

const wishlist = {
  async getWishlists(opts) {
    const base = _proxyBase();
    if (!base) return _normalizeError('Proxy not configured', 'NO_PROXY');
    return _getJSON(_buildUrl(`${base}/wishlist`, '', _pickDefined(opts)));
  },

  async createWishlist(name) {
    const base = _proxyBase();
    if (!base) return _normalizeError('Proxy not configured', 'NO_PROXY');
    return _postJSON(_buildUrl(`${base}/wishlist`, ''), { name });
  },

  async updateWishlist(id, data) {
    const base = _proxyBase();
    if (!base) return _normalizeError('Proxy not configured', 'NO_PROXY');
    return _postJSON(_buildUrl(`${base}/wishlist`, `/${encodeURIComponent(id)}/update`), data);
  },

  async deleteWishlist(id) {
    const base = _proxyBase();
    if (!base) return _normalizeError('Proxy not configured', 'NO_PROXY');
    const result = await _postJSON(_buildUrl(`${base}/wishlist`, `/${encodeURIComponent(id)}/delete`), {});
    if (result.ok) {
      _emit('wishlist:cleared', { wishlistId: id });
    }
    return result;
  },

  async addItem(wishlistId, data) {
    const guest = !_isLoggedIn();
    if (guest) {
      _addGuestItem(data);
      _track('wishlist_add', _wishlistAddProps(wishlistId, data, true));
      // Emit passes raw caller data (not the enriched analytics shape) — listeners use
      // shopifyProductGid for UI sync; extra fields (title, image) ride along but are not contractual.
      _emit('wishlist:added', data);
      return _normalizeSuccess({ guest: true });
    }
    const base = _proxyBase();
    if (!base) return _normalizeError('Proxy not configured', 'NO_PROXY');
    const result = await _postJSON(_buildUrl(`${base}/wishlist`, `/${encodeURIComponent(wishlistId)}/items`), data);
    if (result.ok) {
      _track('wishlist_add', _wishlistAddProps(wishlistId, data, false));
      _emit('wishlist:added', data);
    }
    return result;
  },

  /**
   * Add a saved wishlist item to the cart and record wishlist-origin commerce intent.
   * The cart line stays clean: no analytics attribution is written to line properties.
   *
   * @param {string} wishlistId
   * @param {Object} item Saved wishlist item or product payload with shopifyVariantGid/variantId
   * @param {Object} [opts]
   * @param {number} [opts.quantity=1]
   * @param {boolean} [opts.openCart=false] Use cart.addAndOpen() after a successful add
   * @param {string|string[]} [opts.sections] Section IDs for cart UI refresh
   * @param {string} [opts.sourceId] Source ID for cart UI refresh events
   * @param {AbortSignal} [opts.signal]
   * @returns {Promise<Object>} The cart-add response
   */
  async addItemToCart(wishlistId, item, opts = {}) {
    const variantId = _wishlistCartVariantId(item, opts);
    if (!variantId) throw new Error('Wishlist item is missing a variant id');
    const quantity = Number(opts.quantity ?? item?.quantity ?? 1) || 1;
    const line = { id: variantId, quantity };
    const response = opts.openCart
      ? await cart.addAndOpen(line, { signal: opts.signal, sections: opts.sections, sourceId: opts.sourceId || 'spectrum-wishlist' })
      : await cart.add(line, { signal: opts.signal, sections: opts.sections });
    if (response && response.ok === false) return response;
    _track('wishlist:add_to_cart', _wishlistAddToCartProps(wishlistId, item, line, opts));
    return response;
  },

  async removeItem(wishlistId, itemId, metadata) {
    const base = _proxyBase();
    if (!base) return _normalizeError('Proxy not configured', 'NO_PROXY');
    const result = await _postJSON(
      _buildUrl(`${base}/wishlist`, `/${encodeURIComponent(wishlistId)}/items/${encodeURIComponent(itemId)}/delete`),
      {},
    );
    if (result.ok) {
      const trackProps = { wishlistId, itemId };
      if (metadata?.productGid) {
        trackProps.product = { id: _numericId(metadata.productGid) };
        if (metadata.handle) trackProps.product.handle = metadata.handle;
      }
      trackProps.guest = false;
      _track('wishlist_remove', trackProps);
      _emit('wishlist:removed', { wishlistId, itemId });
    }
    return result;
  },

  async updateItem(wishlistId, itemId, data) {
    const base = _proxyBase();
    if (!base) return _normalizeError('Proxy not configured', 'NO_PROXY');
    const result = await _postJSON(
      _buildUrl(`${base}/wishlist`, `/${encodeURIComponent(wishlistId)}/items/${encodeURIComponent(itemId)}/update`),
      data,
    );
    if (result.ok) {
      _emit('wishlist:item:updated', { wishlistId, itemId, changes: data });
    }
    return result;
  },

  async removeByProduct(productGid, metadata) {
    const guest = !_isLoggedIn();
    const removeProps = { product: { id: _numericId(productGid) }, guest };
    if (metadata?.handle) removeProps.product.handle = metadata.handle;
    if (metadata?.title) removeProps.product.title = metadata.title;
    if (guest) {
      _removeGuestItem(productGid);
      _track('wishlist_remove', removeProps);
      _emit('wishlist:removed', { shopifyProductGid: productGid });
      return _normalizeSuccess({ guest: true, removedCount: 1 });
    }
    const base = _proxyBase();
    if (!base) return _normalizeError('Proxy not configured', 'NO_PROXY');
    const result = await _postJSON(_buildUrl(`${base}/wishlist`, '/items/remove-by-product'), { shopifyProductGid: productGid });
    if (result.ok) {
      _track('wishlist_remove', removeProps);
      _emit('wishlist:removed', { shopifyProductGid: productGid });
    }
    return result;
  },

  async getShared(shareToken, opts) {
    const base = _proxyBase();
    if (!base) return _normalizeError('Proxy not configured', 'NO_PROXY');
    return _getJSON(_buildUrl(`${base}/wishlist`, `/shared/${encodeURIComponent(shareToken)}`, _pickDefined(opts)));
  },
};

// ─── Internal Helpers — Search ───────────────────────────────────────

/**
 * Fetch wrapper for search endpoints that unwraps the backend's
 * { success, data } envelope into the SDK's { ok, data } contract.
 */
async function _searchJSON(url, { signal } = {}) {
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      credentials: 'same-origin',
      signal,
    });
    const body = await res.json();

    if (!res.ok || body.success === false) {
      return _normalizeError(
        { error: body.error || `Search request failed (${res.status})`, code: body.code },
        body.code || `HTTP_${res.status}`,
      );
    }

    return _normalizeSuccess(body.data);
  } catch (err) {
    if (err.name === 'AbortError') {
      return _normalizeError({ error: 'Request aborted', code: 'ABORTED' }, 'ABORTED');
    }
    return _normalizeError({ error: err.message, code: 'NETWORK_ERROR' }, 'NETWORK_ERROR');
  }
}

// ─── Internal — Search Predictive ───────────────────────────────────

let _predictiveController = null;
// Autocomplete (search-drawer suggestions) runs in parallel with predictive,
// so it gets its OWN controller — a shared one would have the two calls cancel
// each other on every keystroke.
let _autoCompleteController = null;
const _predictiveCache = new Map();
const _PREDICTIVE_CACHE_TTL = 30000; // 30 seconds
const _PREDICTIVE_CACHE_MAX = 50;

// `va` (view activity) is deliberately NOT part of the key: a view recorded
// mid-session (quick-view, SPA theme, another tab) can serve up to
// _PREDICTIVE_CACHE_TTL of pre-view personalized ranking for a repeated
// query. Accepted staleness — on classic themes the page navigation that
// records the view destroys this in-memory cache anyway.
function _predictiveCacheKey(q, opts) {
  const filterStr = opts.filters ? JSON.stringify(opts.filters) : '';
  const sortStr = opts.sort || '';
  return `${q}|${sortStr}|${filterStr}`;
}

function _predictiveCacheGet(key) {
  const entry = _predictiveCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > _PREDICTIVE_CACHE_TTL) {
    _predictiveCache.delete(key);
    return null;
  }
  // Move to end (most recently used)
  _predictiveCache.delete(key);
  _predictiveCache.set(key, entry);
  return entry.result;
}

function _predictiveCacheSet(key, result) {
  if (_predictiveCache.size >= _PREDICTIVE_CACHE_MAX) {
    const oldest = _predictiveCache.keys().next().value;
    _predictiveCache.delete(oldest);
  }
  _predictiveCache.set(key, { result, ts: Date.now() });
}

// ─── Internal — View Activity (search personalization) ─────────────

/**
 * Cross-bundle localStorage contract with the analytics SDK's activity
 * tracker. Key `__spectrum_activity_context` holds:
 *   { activity: { product_views: {
 *       recent: [{ product_id: string, viewed_at: epochMs }],   // ≤10 entries
 *       counts_by_product_id: { [productId]: number } } } }
 * The activity tracker owns the shape; this side only reads it. This reader
 * also accepts the pre-rename camelCase spelling (productViews / productId /
 * viewedAt / countsByProductId) because theme assets and CDN bundles deploy
 * on different cycles — whichever side is older, the `va` param keeps
 * working. Serialized as `va=<productId>:<count>:<epochSeconds>,…`
 * (≤10 triplets). The server treats `va` as best-effort and drops
 * malformed/stale triplets itself, so this helper's only hard requirements
 * are: never throw, never block a search call, emit nothing when there is
 * no usable view history.
 */

// Mirrors the server-side seed cap (MAX_AFFINITY_SEEDS in the affinity engine) —
// the server silently drops triplets beyond it, so sending more is wasted bytes.
const _VA_MAX_TRIPLETS = 10;

function _buildViewActivityParam() {
  try {
    const raw = localStorage.getItem('__spectrum_activity_context');
    if (!raw) return null;
    const state = JSON.parse(raw);
    const activity = state && state.activity;
    const views = activity && (activity.product_views || activity.productViews);
    if (!views || !Array.isArray(views.recent)) return null;
    const rawCounts = views.counts_by_product_id || views.countsByProductId;
    const counts = rawCounts && typeof rawCounts === 'object' ? rawCounts : {};
    const triplets = [];
    for (const entry of views.recent) {
      if (triplets.length >= _VA_MAX_TRIPLETS) break;
      if (!entry) continue;
      const productId = typeof entry.product_id === 'string' && entry.product_id
        ? entry.product_id
        : typeof entry.productId === 'string' && entry.productId
          ? entry.productId
          : null;
      if (!productId) continue;
      const seconds = Math.floor(Number(entry.viewed_at != null ? entry.viewed_at : entry.viewedAt) / 1000);
      if (!Number.isFinite(seconds) || seconds <= 0) continue;
      const count = Math.max(1, Math.floor(Number(counts[productId])) || 1);
      triplets.push(`${productId}:${count}:${seconds}`);
    }
    return triplets.length > 0 ? triplets.join(',') : null;
  } catch {
    return null;
  }
}

// ─── Internal — Recent Searches ─────────────────────────────────────

const _RECENT_STORAGE_KEY = '__spectrum_search_recent';
const _RECENT_MAX = 20;

function _getRecentSearches() {
  try {
    const raw = localStorage.getItem(_RECENT_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function _saveRecentSearches(searches) {
  try {
    localStorage.setItem(_RECENT_STORAGE_KEY, JSON.stringify(searches));
  } catch {}
}

// ─── Search (App Proxy) ─────────────────────────────────────────────

const search = {
  /**
   * Execute a search query. Always fetches fresh (no caching).
   * Auto-redirects when a merchandising rule returns a redirect URL.
   * @param {string}       q           Search query (max 500 chars; empty = browse mode)
   * @param {Object}       [opts]
   * @param {string}       [opts.sort]        Sort field:direction (e.g. 'price:asc')
   * @param {number}       [opts.page]        Page number (1-1000)
   * @param {number}       [opts.hitsPerPage] Results per page (1-100, default 20)
   * @param {Object}       [opts.filters]     Filter params using backend syntax
   *   e.g. { 'filter.v.vendor': 'Nike', 'filter.v.price.gte': '50' }
   * @param {AbortSignal}  [opts.signal]      AbortController signal
   * @returns {Promise<{ok:boolean, data?:Object, error?:{message:string, code:string}}>}
   */
  async query(q, opts = {}) {
    const base = _proxyBase();
    if (!base) return _normalizeError('Proxy not configured', 'NO_PROXY');

    const params = {};
    if (q) params.q = q;
    if (opts.sort) params.sort = opts.sort;
    if (opts.page) params.page = opts.page;
    if (opts.hitsPerPage) params.hitsPerPage = opts.hitsPerPage;

    if (opts.filters) {
      for (const [key, value] of Object.entries(opts.filters)) {
        if (value !== undefined && value !== null) params[key] = value;
      }
    }

    const va = _buildViewActivityParam();
    if (va) params.va = va;

    const url = _buildUrl(`${base}/search`, '', params);
    const result = await _searchJSON(url, { signal: opts.signal });

    if (result.ok && result.data && result.data.redirect) {
      window.location.href = result.data.redirect;
      return result;
    }

    return result;
  },

  /**
   * Fetch facet distributions for the current query and filters.
   * @param {string}       q           Search query
   * @param {Object}       [opts]
   * @param {Object}       [opts.filters]     Active filters (same syntax as query)
   * @param {AbortSignal}  [opts.signal]      AbortController signal
   * @returns {Promise<{ok:boolean, data?:Object, error?:{message:string, code:string}}>}
   */
  async getFacets(q, opts = {}) {
    const base = _proxyBase();
    if (!base) return _normalizeError('Proxy not configured', 'NO_PROXY');

    const params = {};
    if (q) params.q = q;

    if (opts.filters) {
      for (const [key, value] of Object.entries(opts.filters)) {
        if (value !== undefined && value !== null) params[key] = value;
      }
    }

    const url = _buildUrl(`${base}/facets`, '', params);
    return _searchJSON(url, { signal: opts.signal });
  },

  /**
   * Predictive search with auto-cancel and in-memory LRU cache.
   * Each call aborts the previous in-flight request. Returns null
   * when a request is cancelled (superseded by a newer call).
   * Cached results are returned within a 30-second TTL window.
   * @param {string}       q           Search query
   * @param {Object}       [opts]      Same options as query()
   * @returns {Promise<{ok:boolean, data?:Object, error?:{message:string, code:string}}|null>}
   */
  async predictive(q, opts = {}) {
    if (_predictiveController) {
      _predictiveController.abort();
    }
    _predictiveController = new AbortController();

    const cacheKey = _predictiveCacheKey(q, opts);
    const cached = _predictiveCacheGet(cacheKey);
    if (cached) return cached;

    const base = _proxyBase();
    if (!base) return _normalizeError('Proxy not configured', 'NO_PROXY');

    const va = _buildViewActivityParam();

    const params = {};
    if (q) params.q = q;
    if (opts.sort) params.sort = opts.sort;
    if (opts.page) params.page = opts.page;
    if (opts.hitsPerPage) params.hitsPerPage = opts.hitsPerPage;
    if (opts.filters) {
      for (const [key, value] of Object.entries(opts.filters)) {
        if (value !== undefined && value !== null) params[key] = value;
      }
    }
    if (va) params.va = va;

    const url = _buildUrl(`${base}/search`, '', params);
    const result = await _searchJSON(url, { signal: _predictiveController.signal });

    if (!result.ok && result.error && result.error.code === 'ABORTED') {
      return null;
    }

    if (result.ok) {
      _predictiveCacheSet(cacheKey, result);
    }

    if (result.ok && result.data && result.data.redirect) {
      window.location.href = result.data.redirect;
      return result;
    }

    return result;
  },

  /**
   * Typeahead autocomplete suggestions for the search drawer.
   *
   * Hits the suggestions endpoint (`/search/autocomplete`), which is distinct
   * from `predictive()` product search — the two are meant to fire in parallel
   * as the shopper types, so this method uses its own abort controller and the
   * two never cancel one another.
   *
   * Auto-cancel: each call aborts the previous in-flight autocomplete request,
   * so only the latest keystroke's suggestions resolve. Returns `null` when a
   * request is superseded (the caller should ignore a null result). Debounce
   * and min-length gating are the caller's responsibility.
   *
   * @param {string}       q           Search query (empty → no `q` param)
   * @param {Object}       [opts]
   * @param {Object}       [opts.filters]  Optional filter context (backend syntax,
   *   e.g. { 'filter.v.vendor': 'Nike' })
   * @returns {Promise<{ok:boolean, data?:Object, error?:{message:string, code:string}}|null>}
   */
  async autoComplete(q, opts = {}) {
    if (_autoCompleteController) {
      _autoCompleteController.abort();
    }
    _autoCompleteController = new AbortController();

    const base = _proxyBase();
    if (!base) return _normalizeError('Proxy not configured', 'NO_PROXY');

    const params = {};
    if (q) params.q = q;
    if (opts.filters) {
      for (const [key, value] of Object.entries(opts.filters)) {
        if (value !== undefined && value !== null) params[key] = value;
      }
    }

    const url = _buildUrl(`${base}/search/autocomplete`, '', params);
    const result = await _searchJSON(url, { signal: _autoCompleteController.signal });

    if (!result.ok && result.error && result.error.code === 'ABORTED') {
      return null;
    }

    return result;
  },

  /**
   * Get recent search queries from localStorage.
   * @returns {string[]} Most recent first, max 20 entries
   */
  getRecent() {
    return _getRecentSearches();
  },

  /**
   * Add a search query to recent history. Deduplicates (moves to top).
   * @param {string} query  The search term to save
   */
  addRecent(query) {
    if (!query || typeof query !== 'string') return;
    const trimmed = query.trim();
    if (!trimmed) return;
    const searches = _getRecentSearches();
    const filtered = searches.filter((s) => s !== trimmed);
    filtered.unshift(trimmed);
    _saveRecentSearches(filtered.slice(0, _RECENT_MAX));
  },

  /**
   * Clear all recent search history from localStorage.
   */
  clearRecent() {
    try {
      localStorage.removeItem(_RECENT_STORAGE_KEY);
    } catch {}
  },

  /**
   * Fetch recommended inline filters for a search query.
   * Returns filter suggestions the user can toggle on/off to refine results.
   * When active filters are provided, recommendations are scoped to the
   * filtered result set (e.g., only colors available within the current vendor).
   *
   * @param {string}       q              Search query (required, non-empty)
   * @param {Object}       [opts]
   * @param {Object}       [opts.filters]  Applied filters for context-aware recommendations
   *   e.g. { 'filter.v.vendor': 'Nike', 'filter.v.price.lte': '200' }
   * @param {AbortSignal}  [opts.signal]   AbortController signal
   * @returns {Promise<{ok:boolean, data?:RecommendInlineFiltersData, error?:{message:string, code:string}}>}
   *
   * @typedef {Object} RecommendInlineFiltersData
   * @property {string} searchTerms          Cleaned search terms (query minus extracted filter intent)
   * @property {RecommendedFilter[]} filters Array of recommended filters
   * @property {string} intentContext        Inferred user intent context (e.g. "casual, fashion")
   * @property {number} confidence           Backend confidence score (0-1)
   *
   * @typedef {Object} RecommendedFilter
   * @property {string} field         Facet field name (e.g. "color", "price")
   * @property {string} fieldType     Field type: "variant_option" | "standard" | "tag" | "metafield"
   * @property {string|number} value  Recommended filter value
   * @property {string} displayName   Human-readable label for the chip UI
   * @property {string} filterParam   Ready-to-use URL param key (e.g. "filter.v.o.color")
   */
  async recommendInlineFilters(q, opts = {}) {
    const base = _proxyBase();
    if (!base) return _normalizeError('Proxy not configured', 'NO_PROXY');

    const params = {};
    if (q) params.q = q;

    if (opts.filters) {
      for (const [key, value] of Object.entries(opts.filters)) {
        if (value !== undefined && value !== null) params[key] = value;
      }
    }

    const url = _buildUrl(`${base}/search/recommendInlineFilters`, '', params);
    return _searchJSON(url, { signal: opts.signal });
  },
};

// ─── Events ─────────────────────────────────────────────────────────

const events = {
  /**
   * Dispatch a custom event via the Spectrum app embed.
   * @param {string} name    Event name without $spectrum: prefix (e.g. 'wishlist:added')
   * @param {Object} [detail] Event payload
   */
  emit(name, detail) {
    _emit(name, detail);
  },

  /**
   * Listen for a Spectrum custom event.
   * @param {string}   name     Event name without $spectrum: prefix
   * @param {Function} callback Event handler receiving the CustomEvent
   * @returns {Function} Unsubscribe — removes the listener when called.
   *                     Authors who don't need cleanup can ignore the return;
   *                     the existing on/off pair stays available for back-compat.
   */
  on(name, callback) {
    const evt = `$spectrum:${name}`;
    document.addEventListener(evt, callback);
    return () => document.removeEventListener(evt, callback);
  },

  /**
   * Remove a Spectrum custom event listener.
   * @param {string}   name     Event name without $spectrum: prefix
   * @param {Function} callback The same function reference passed to on()
   */
  off(name, callback) {
    document.removeEventListener(`$spectrum:${name}`, callback);
  },
};

// ─── Currency ────────────────────────────────────────────────────────

/**
 * Active storefront currency code (ISO 4217). Reflects the customer's
 * presentation currency (correct for multi-currency stores).
 * @returns {string|undefined} e.g. 'USD', 'GBP', or undefined if unavailable
 */
function getActiveCurrency() {
  return _currency();
}

// ─── Video Element ───────────────────────────────────────────────────

/**
 * <spectrum-video> — Lazy-loading video custom element with adaptive
 * source selection, viewport-aware autoplay, and single-audio coordination.
 *
 * Attributes:
 *   data-src           — MP4 URL (required unless data-sources provided)
 *   data-sources       — JSON array of {url, width} for adaptive quality
 *   data-poster        — Poster image URL for the <video> element
 *   data-autoplay      — "muted" to enable autoplay (always muted)
 *   data-load          — "viewport" (default) | "hover" | "click" | "eager"
 *   data-preload-margin— IntersectionObserver rootMargin (default: "200px")
 *   data-loop          — Loop playback
 *   style="aspect-ratio: W/H" — CLS prevention (set in Liquid)
 *
 * Events (bubble): spectrum-video:loaded, spectrum-video:play,
 *   spectrum-video:pause, spectrum-video:error, spectrum-video:unloaded,
 *   spectrum-video:mute, spectrum-video:unmute
 */

let _activeUnmutedVideo = null;

class SpectrumVideo extends HTMLElement {
  static get observedAttributes() {
    return ['data-src', 'data-sources'];
  }

  connectedCallback() {
    this._state = 'idle';
    this._video = null;
    this._loadObserver = null;
    this._visibilityObserver = null;
    this._wantsPlay = false;

    // CLS belt-and-suspenders (inline style in Liquid is primary)
    if (!this.style.display) this.style.display = 'block';
    if (!this.style.position) this.style.position = 'relative';
    this.style.overflow = 'hidden';

    this._setupLoad();
  }

  disconnectedCallback() {
    this._teardown();
    if (_activeUnmutedVideo === this) _activeUnmutedVideo = null;
  }

  attributeChangedCallback(name, oldVal, newVal) {
    if (oldVal === newVal) return;
    if (this._state !== 'idle') {
      this.unload();
      this._setupLoad();
    }
  }

  // ─── Public API ─────────────────────────────────────────────────────

  play() {
    this._wantsPlay = true;
    if (!this._video) {
      this._loadVideo();
      return;
    }
    if (this._state === 'ready') this._video.play().catch(() => {});
  }

  pause() {
    if (this._video) this._video.pause();
  }

  load() {
    if (!this._video) this._loadVideo();
  }

  unload() {
    if (this._state === 'idle' && !this._video) return;
    if (this._video) {
      this._video.pause();
      this._video.removeAttribute('src');
      this._video.load();
      this._video.remove();
      this._video = null;
    }
    this._showPoster();
    this._wantsPlay = false;
    this._state = 'idle';
    this._dispatch('unloaded');
  }

  mute() {
    if (this._video) this._video.muted = true;
    if (_activeUnmutedVideo === this) _activeUnmutedVideo = null;
    this._dispatch('mute');
  }

  unmute() {
    if (_activeUnmutedVideo && _activeUnmutedVideo !== this) {
      _activeUnmutedVideo.mute();
    }
    _activeUnmutedVideo = this;
    if (this._video) this._video.muted = false;
    this._dispatch('unmute');
  }

  get playing() {
    return this._state === 'ready' && this._video && !this._video.paused;
  }

  get loaded() {
    return this._state === 'ready';
  }

  get muted() {
    return this._video ? this._video.muted : true;
  }

  // ─── Private ────────────────────────────────────────────────────────

  _setupLoad() {
    const mode = this.dataset.load || 'viewport';

    if (mode === 'eager') {
      this._loadVideo();
      return;
    }

    if (mode === 'hover') {
      this._hoverHandler = () => { this._loadVideo(); this.removeEventListener('pointerenter', this._hoverHandler); };
      this.addEventListener('pointerenter', this._hoverHandler);
      return;
    }

    if (mode === 'click') {
      this._clickHandler = () => { this._wantsPlay = true; this._loadVideo(); this.removeEventListener('click', this._clickHandler); };
      this.addEventListener('click', this._clickHandler);
      return;
    }

    // Default: viewport
    const margin = this.dataset.preloadMargin || '200px';
    // Capture the observer locally — `this._loadObserver` can be nulled by
    // `_teardown()` (disconnectedCallback / attributeChangedCallback) between
    // the IO scheduling its delivery and the callback running. Reading
    // `this._loadObserver` inside the callback would throw against null;
    // disconnecting the captured local always targets the right observer.
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          this._loadVideo();
          observer.disconnect();
          if (this._loadObserver === observer) this._loadObserver = null;
        }
      },
      { rootMargin: margin }
    );
    this._loadObserver = observer;
    observer.observe(this);
  }

  _loadVideo() {
    if (this._state !== 'idle') return;
    this._state = 'loading';

    const video = document.createElement('video');
    video.muted = true;
    video.setAttribute('muted', '');
    video.loop = this.hasAttribute('data-loop');
    video.playsInline = true;
    video.setAttribute('playsinline', '');
    video.setAttribute('webkit-playsinline', '');
    video.setAttribute('disablepictureinpicture', '');
    video.preload = 'metadata';

    if (this.dataset.autoplay) video.setAttribute('autoplay', '');
    if (this.dataset.poster) video.poster = this.dataset.poster;

    Object.assign(video.style, {
      position: 'absolute',
      inset: '0',
      width: '100%',
      height: '100%',
      objectFit: 'cover',
    });

    video.addEventListener('loadedmetadata', () => this._onCanPlay(), { once: true });
    video.addEventListener('error', (e) => this._onError(e), { once: true });

    this._video = video;
    this.appendChild(video);
    video.src = this._pickSource();
    video.load();
  }

  _pickSource() {
    const sourcesAttr = this.dataset.sources;
    if (sourcesAttr) {
      try {
        const sources = JSON.parse(sourcesAttr);
        if (Array.isArray(sources) && sources.length > 0) {
          const target = this.clientWidth * (window.devicePixelRatio || 1);
          const sorted = sources.slice().sort((a, b) => a.width - b.width);
          const match = sorted.find((s) => s.width >= target);
          return (match || sorted[sorted.length - 1]).url;
        }
      } catch (_) { /* fall through to data-src */ }
    }
    return this.dataset.src || '';
  }

  _onCanPlay() {
    this._state = 'ready';
    this._hidePoster();
    this._dispatch('loaded', { src: this._video.src });
    // Set up visibility observer first so it becomes the single source of truth
    // for play/pause on autoplay elements — its initial fire handles the first play.
    if (this.dataset.autoplay) {
      this._setupVisibility();
    } else if (this._wantsPlay) {
      // Non-autoplay element with queued play intent (e.g., controller called play())
      this._video.play().catch(() => {});
    }
    this._wantsPlay = false;
  }

  _onError(_e) {
    const errorMsg = this._video?.error?.message || 'Video load failed';
    const errorCode = this._video?.error?.code;
    this._state = 'idle';
    if (this._video) {
      this._video.remove();
      this._video = null;
    }
    this._showPoster();
    this._dispatch('error', { error: errorMsg, code: errorCode });
  }

  _setupVisibility() {
    if (!this.dataset.autoplay) return;

    // `data-visibility-threshold` lets snippets opt out of the default 0.5
    // pause heuristic. The default (0.5) suits hero-on-a-marketing-page
    // surfaces where you don't want a half-clipped video burning bandwidth.
    // Surfaces where any visibility should keep playback alive (e.g. a
    // shop-the-look hero embedded mid-PDP, where the user scrolls the hero
    // partially in and out as they read product details) can set
    // `data-visibility-threshold="0"` — the IO then fires on a single
    // intersecting pixel and pauses only when the element is fully clipped.
    // Accepted: any number in [0, 1]; anything else falls back to 0.5.
    const rawThreshold = this.dataset.visibilityThreshold;
    const parsed = rawThreshold == null ? 0.5 : parseFloat(rawThreshold);
    const threshold =
      Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : 0.5;

    this._visibilityObserver = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          this._video?.play().catch(() => {});
          this._dispatch('play');
        } else {
          this._video?.pause();
          this._dispatch('pause');
        }
      },
      { threshold }
    );
    this._visibilityObserver.observe(this);
  }

  _hidePoster() {
    const img = this.querySelector(':scope > img');
    if (img) img.style.display = 'none';
  }

  _showPoster() {
    const img = this.querySelector(':scope > img');
    if (img) img.style.display = '';
  }

  _teardown() {
    if (this._loadObserver) { this._loadObserver.disconnect(); this._loadObserver = null; }
    if (this._visibilityObserver) { this._visibilityObserver.disconnect(); this._visibilityObserver = null; }
    if (this._hoverHandler) { this.removeEventListener('pointerenter', this._hoverHandler); this._hoverHandler = null; }
    if (this._clickHandler) { this.removeEventListener('click', this._clickHandler); this._clickHandler = null; }
    if (this._video) { this._video.pause(); this._video = null; }
  }

  _dispatch(name, detail = {}) {
    this.dispatchEvent(new CustomEvent(`spectrum-video:${name}`, { bubbles: true, detail }));
  }
}

if (typeof customElements !== 'undefined' && !customElements.get('spectrum-video')) {
  customElements.define('spectrum-video', SpectrumVideo);
}

// ─── Countdown ───────────────────────────────────────────────────────

/**
 * SpectrumCountdown — generic countdown/timer primitive for snippets.
 *
 * Math + events; the snippet owns DOM, triggers, and lifecycle. Three
 * config modes: 'duration' (relative ms with optional persistence),
 * 'epoch' (absolute end timestamp), and 'recurring' (typed recurrence
 * rule, optionally windowed). Zod schemas in
 * `packages/snippet-library/src/schemas.ts` mirror the accepted config
 * shapes.
 *
 * Event surface:
 *   tick    — every interval (default 1s) and once on start()
 *   expire  — Duration / Epoch only; once when remainingMs hits 0
 *   enter   — Recurring; per occurrence (Intent A) or window start (Intent B)
 *   exit    — Recurring (Intent B only); at window end, before re-arm
 *
 * TickState payload:
 *   { remainingMs, totalMs, percent, days, hours, minutes, seconds, state? }
 *   `state` is 'before' | 'in' for Recurring, omitted otherwise.
 *
 * `percent` semantics: 0..100, clamped, measured against `totalMs`. For
 * Duration / Epoch (with `startsAt`) it counts up to 100 across the
 * configured span. For Recurring it is meaningful only in the `'in'`
 * state (window progress); in the `'before'` state, `totalMs` equals
 * `remainingMs` so `percent` stays at 0 by construction — render
 * "starts in X" copy from `remainingMs` directly, not from `percent`.
 */

const _COUNTDOWN_TICK_MS = 1000;
const _COUNTDOWN_STORAGE_PREFIX = '__spectrum_countdown_';

/**
 * Resolve a wall-clock (Y/M/D h:m) in `tz` to a UTC epoch. Iterates 3 times
 * to converge across DST transitions and TZ-offset wraps.
 *
 * Uses `Date.UTC` for both the target and the format-derived "actual" wall-
 * clock so the minute delta represents real elapsed time even when the two
 * straddle a month boundary (a flat ordinal encoding overcounts the gap
 * across short months and causes runaway iterations).
 */
function _zonedToEpoch(year, month, day, hour, minute, tz) {
  const targetMs = Date.UTC(year, month - 1, day, hour, minute, 0);
  let guess = targetMs;
  for (let i = 0; i < 3; i++) {
    const parts = _zonedParts(guess, tz);
    const actualMs = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      0,
    );
    const diffMs = actualMs - targetMs;
    if (diffMs === 0) break;
    guess -= diffMs;
  }
  return guess;
}

/** Decompose an epoch into wall-clock parts in `tz`. */
function _zonedParts(epochMs, tz) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = fmt.formatToParts(new Date(epochMs));
  const map = {};
  for (const p of parts) map[p.type] = p.value;
  // Some runtimes return "24" for midnight in en-CA; normalise to "00".
  const hourValue = map.hour === '24' ? 0 : parseInt(map.hour, 10);
  return {
    year: parseInt(map.year, 10),
    month: parseInt(map.month, 10),
    day: parseInt(map.day, 10),
    hour: hourValue,
    minute: parseInt(map.minute, 10),
  };
}

/** Days since Unix epoch for a TZ-local date. */
function _daysSinceEpoch(year, month, day) {
  // Treat as UTC noon to avoid TZ-rounding off-by-one issues.
  return Math.floor(Date.UTC(year, month - 1, day, 12) / 86_400_000);
}

/**
 * Smallest occurrence epoch ≥ `from` for the recurrence rule, evaluated in
 * `tz`. Walks day-by-day from `from`'s local date; bounded at 400 iterations
 * to cap worst-case cost (e.g. monthly with `dayOfMonth: 31` skipping short
 * months, or annual recurrence which needs ~365 days of headroom).
 */
function _nextOccurrence(rule, from, tz) {
  const start = _zonedParts(from, tz);
  let { year, month, day } = start;
  for (let i = 0; i < 400; i++) {
    const matches = _occurrencesOnDay(rule, year, month, day, tz);
    for (const epochMs of matches) {
      if (epochMs >= from) return epochMs;
    }
    // Advance one day in the local calendar.
    const nextDayEpoch = _zonedToEpoch(year, month, day, 12, 0, tz) + 86_400_000;
    const nextParts = _zonedParts(nextDayEpoch, tz);
    year = nextParts.year;
    month = nextParts.month;
    day = nextParts.day;
  }
  throw new Error('SpectrumCountdown: no upcoming occurrence within search window');
}

/** Occurrence epochs (sorted ascending) on a given local date for the rule. */
function _occurrencesOnDay(rule, year, month, day, tz) {
  switch (rule.every) {
    case 'hour': {
      const result = [];
      for (let h = 0; h < 24; h += rule.interval) {
        result.push(_zonedToEpoch(year, month, day, h, rule.atMinute, tz));
      }
      return result;
    }
    case 'day': {
      if (_daysSinceEpoch(year, month, day) % rule.interval !== 0) return [];
      return [_zonedToEpoch(year, month, day, rule.atHour, rule.atMinute, tz)];
    }
    case 'month': {
      if (day !== rule.dayOfMonth) return [];
      const monthsSinceEpoch = (year - 1970) * 12 + (month - 1);
      if (monthsSinceEpoch % rule.interval !== 0) return [];
      return [_zonedToEpoch(year, month, day, rule.atHour, rule.atMinute, tz)];
    }
    default:
      return [];
  }
}

/** Compute the breakdown fields from a non-negative ms remainder. */
function _splitDuration(remainingMs) {
  const totalSeconds = Math.max(0, Math.floor(remainingMs / 1000));
  return {
    days: Math.floor(totalSeconds / 86400),
    hours: Math.floor((totalSeconds % 86400) / 3600),
    minutes: Math.floor((totalSeconds % 3600) / 60),
    seconds: totalSeconds % 60,
  };
}

class SpectrumCountdown {
  constructor(config) {
    this._config = SpectrumCountdown._normalizeConfig(config);
    this._listeners = { tick: [], expire: [], enter: [], exit: [] };
    this._running = false;
    this._timeoutId = null;
    this._anchor = null;
    this._expired = false;
    this._lastSnapshot = null;
    this._constructionTime = Date.now();
    this._tick = this._tick.bind(this);
    this._onVisibilityChange = this._onVisibilityChange.bind(this);
  }

  /**
   * Normalises raw config to the internal shape with sensible defaults
   * (persist=none, occurrenceDurationMs=0, tz=visitor browser). Studio is the
   * authoring path and is responsible for validating config shape — the class
   * trusts what it receives. Genuinely malformed input (missing required
   * fields, wrong types) surfaces as `TypeError` from downstream math or a
   * "no upcoming occurrence" throw from `_nextOccurrence` — loud enough.
   */
  static _normalizeConfig(config) {
    const { kind } = config;
    if (kind === 'duration') {
      return {
        kind: 'duration',
        ms: config.ms,
        persist: config.persist || 'none',
        persistKey:
          typeof config.persistKey === 'string' && config.persistKey.length > 0
            ? config.persistKey
            : null,
      };
    }
    if (kind === 'epoch') {
      return {
        kind: 'epoch',
        endsAt: config.endsAt,
        startsAt: typeof config.startsAt === 'number' ? config.startsAt : null,
      };
    }
    if (kind === 'recurring') {
      return {
        kind: 'recurring',
        recurrence: config.recurrence,
        occurrenceDurationMs:
          typeof config.occurrenceDurationMs === 'number' ? config.occurrenceDurationMs : 0,
        tz:
          typeof config.tz === 'string' && config.tz.length > 0
            ? config.tz
            : Intl.DateTimeFormat().resolvedOptions().timeZone,
      };
    }
    throw new Error(`SpectrumCountdown: unknown kind "${kind}"`);
  }

  on(event, fn) {
    const list = this._listeners[event];
    if (!list || typeof fn !== 'function') return () => {};
    list.push(fn);
    return () => {
      const idx = list.indexOf(fn);
      if (idx !== -1) list.splice(idx, 1);
    };
  }

  start() {
    if (this._running) return;
    this._running = true;
    if (this._config.kind === 'duration') this._initDurationAnchor();
    document.addEventListener('visibilitychange', this._onVisibilityChange);
    this._tick();
  }

  destroy() {
    this._running = false;
    if (this._timeoutId !== null) {
      clearTimeout(this._timeoutId);
      this._timeoutId = null;
    }
    document.removeEventListener('visibilitychange', this._onVisibilityChange);
    this._listeners = { tick: [], expire: [], enter: [], exit: [] };
    // Reset semantic state so a future start() begins fresh — without this,
    // re-starting a Recurring timer would compare against a stale snapshot
    // and fire spurious enter/exit, and Duration with persist:'none' would
    // continue counting from a pre-destroy anchor. Storage records survive
    // (matching the documented "Does NOT clear storage" contract).
    this._lastSnapshot = null;
    this._expired = false;
    this._anchor = null;
  }

  _onVisibilityChange() {
    if (document.visibilityState === 'visible') {
      if (this._timeoutId !== null) {
        clearTimeout(this._timeoutId);
        this._timeoutId = null;
      }
      if (this._running) this._tick();
    }
  }

  _storageBackend() {
    const c = this._config;
    if (c.kind !== 'duration' || c.persist === 'none') return null;
    return c.persist === 'session' ? window.sessionStorage : window.localStorage;
  }

  _storageKey() {
    const c = this._config;
    // persistKey is guaranteed non-null when persist !== 'none' (validated in
    // _normalizeConfig); _storageBackend short-circuits this method otherwise.
    return `${_COUNTDOWN_STORAGE_PREFIX}${c.persistKey}_${c.ms}`;
  }

  _initDurationAnchor() {
    if (this._anchor !== null) return;
    const storage = this._storageBackend();
    if (!storage) {
      this._anchor = Date.now();
      return;
    }
    const key = this._storageKey();
    const raw = storage.getItem(key);
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (typeof parsed.startedAt === 'number' && Number.isFinite(parsed.startedAt)) {
          this._anchor = parsed.startedAt;
          return;
        }
      } catch (_err) {
        // Fall through and write a fresh anchor.
      }
    }
    this._anchor = Date.now();
    storage.setItem(key, JSON.stringify({ startedAt: this._anchor }));
  }

  _tick() {
    if (!this._running) return;
    if (this._config.kind === 'recurring') {
      this._tickRecurring();
    } else {
      this._tickTerminal();
    }
  }

  _tickTerminal() {
    const c = this._config;
    const now = Date.now();
    let startedAt;
    let totalMs;
    let endsAt;
    if (c.kind === 'duration') {
      startedAt = this._anchor;
      totalMs = c.ms;
      endsAt = this._anchor + c.ms;
    } else {
      startedAt = c.startsAt !== null ? c.startsAt : this._constructionTime;
      totalMs = Math.max(1, c.endsAt - startedAt);
      endsAt = c.endsAt;
    }
    const remainingMs = Math.max(0, endsAt - now);
    this._dispatchTick(this._buildTickState(remainingMs, totalMs, undefined));
    if (remainingMs <= 0) {
      if (!this._expired) {
        this._expired = true;
        this._dispatch('expire');
      }
      return;
    }
    this._scheduleTick(_COUNTDOWN_TICK_MS);
  }

  _tickRecurring() {
    const c = this._config;
    const now = Date.now();
    const snap = SpectrumCountdown._computeRecurringSnapshot(
      c.recurrence,
      c.occurrenceDurationMs,
      now,
      c.tz,
    );
    this._fireRecurringTransitions(this._lastSnapshot, snap, c.occurrenceDurationMs);
    let totalMs;
    let remainingMs;
    if (snap.state === 'in') {
      totalMs = c.occurrenceDurationMs;
      remainingMs = Math.max(0, snap.windowEnd - now);
    } else {
      totalMs = Math.max(1, snap.nextStart - now);
      remainingMs = totalMs;
    }
    this._dispatchTick(this._buildTickState(remainingMs, totalMs, snap.state));
    this._lastSnapshot = snap;
    const target = snap.state === 'in' ? snap.windowEnd : snap.nextStart;
    const delay = Math.max(50, Math.min(_COUNTDOWN_TICK_MS, target - now));
    this._scheduleTick(delay);
  }

  static _computeRecurringSnapshot(rule, durationMs, now, tz) {
    if (durationMs > 0) {
      const candidateStart = _nextOccurrence(rule, now - durationMs, tz);
      if (candidateStart <= now && candidateStart + durationMs > now) {
        return {
          state: 'in',
          windowStart: candidateStart,
          windowEnd: candidateStart + durationMs,
          nextStart: null,
        };
      }
      const upcoming = candidateStart > now ? candidateStart : _nextOccurrence(rule, now, tz);
      return { state: 'before', windowStart: null, windowEnd: null, nextStart: upcoming };
    }
    const upcoming = _nextOccurrence(rule, now + 1, tz);
    return { state: 'before', windowStart: null, windowEnd: null, nextStart: upcoming };
  }

  _fireRecurringTransitions(prev, current, durationMs) {
    if (prev === null) return;
    if (durationMs === 0) {
      if (current.nextStart !== prev.nextStart) this._dispatch('enter');
      return;
    }
    const sameWindow =
      prev.state === 'in' && current.state === 'in' && prev.windowStart === current.windowStart;
    const sameBefore =
      prev.state === 'before' &&
      current.state === 'before' &&
      prev.nextStart === current.nextStart;
    if (sameWindow || sameBefore) return;
    if (prev.state === 'in') this._dispatch('exit');
    if (current.state === 'in') this._dispatch('enter');
    if (prev.state === 'before' && current.state === 'before') {
      // A whole window came and went between ticks; surface both transitions.
      this._dispatch('enter');
      this._dispatch('exit');
    }
  }

  _scheduleTick(delayMs) {
    this._timeoutId = setTimeout(this._tick, delayMs);
  }

  _buildTickState(remainingMs, totalMs, state) {
    const safeRemaining = Math.max(0, remainingMs);
    const safeTotal = totalMs > 0 ? totalMs : 1;
    const percent = Math.max(0, Math.min(100, ((safeTotal - safeRemaining) / safeTotal) * 100));
    const split = _splitDuration(safeRemaining);
    const out = {
      remainingMs: safeRemaining,
      totalMs: safeTotal,
      percent,
      days: split.days,
      hours: split.hours,
      minutes: split.minutes,
      seconds: split.seconds,
    };
    if (state !== undefined) out.state = state;
    return out;
  }

  _dispatchTick(state) {
    this._dispatchListeners('tick', state);
  }

  _dispatch(event) {
    this._dispatchListeners(event, undefined);
  }

  _dispatchListeners(event, payload) {
    const list = this._listeners[event];
    if (!list || list.length === 0) return;
    // Iterate a copy so handlers that mutate listeners don't skip neighbours.
    const snapshot = list.slice();
    for (const fn of snapshot) {
      try {
        if (payload === undefined) fn();
        else fn(payload);
      } catch (err) {
        console.warn(`SpectrumCountdown: ${event} listener threw`, err);
      }
    }
  }
}

// ─── Native (Mobile WebView) ─────────────────────────────────────────

/**
 * Native bridge helpers — used by the mobile WebView shell.
 *
 * Surfaces a checkout URL resolver. The native shell calls this when the
 * user taps Checkout, then hands the resolved URL to ShopifyCheckoutSheetKit.
 * Web traffic never calls this; gating happens at the call site in the
 * theme handler (checks `window.__spectrumMobileApp`).
 */
const native = {
  /**
   * Resolve the absolute checkout URL for the user's current cart.
   *
   * - 'default' — follows /checkout's redirect chain and returns the
   *   resolved URL (the same URL Shopify would have landed on).
   * - 'bundle'  — reads the Spectrum bundle cart for the given slug and
   *   returns its checkoutUrl. Requires `window.__spectrumAi.bundle`
   *   (the edge SDK cart bundle) to be loaded.
   *
   * @param {Object}             [opts]
   * @param {'default'|'bundle'} [opts.cartType]  Default 'default'.
   * @param {string}             [opts.slug]      Required for 'bundle'.
   * @returns {Promise<string>}  Absolute checkout URL.
   * @throws  {Error}            On resolver failure (never returns empty).
   */
  async getCheckoutUrl({ cartType = 'default', slug } = {}) {
    if (cartType === 'default') {
      const res = await fetch(`${_root()}checkout`, {
        redirect: 'follow',
        credentials: 'include',
      });
      if (!res.url) throw new Error('Failed to resolve default checkout URL');
      return res.url;
    }

    if (cartType === 'bundle') {
      if (!slug) throw new Error('slug required for bundle cart');
      const bundleApi = window.__spectrumAi?.bundle;
      if (!bundleApi) throw new Error('Bundle cart SDK not loaded');
      const result = await bundleApi.getCart(slug);
      if (!result?.ok) throw new Error('Failed to fetch bundle cart');
      const url = result.data?.checkoutUrl;
      if (!url) throw new Error('Bundle cart has no checkout URL');
      return url;
    }

    throw new Error(`Unsupported cartType: ${cartType}`);
  },

  /**
   * Create a standalone cart and return the checkout URL.
   * Does not touch the user's browsing cart.
   *
   * @param {Object}  opts
   * @param {Array<{variantId:number, quantity?:number, properties?:Object}>} opts.lines  Items to add.
   *   `properties` carries per-line custom attributes (e.g. line-item properties for a
   *   custom design). They survive to the order line item so the order stays fulfillable.
   * @param {string[]} [opts.discountCodes] Optional discount codes.
   * @returns {Promise<{ok:boolean, data?:{checkoutUrl:string, cartId:string}, error?:{message:string, code:string}}>}
   */
  async expressCheckout({ lines, discountCodes } = {}) {
    if (!lines?.length) return _normalizeError('lines is required', 'MISSING_LINES');
    const base = _proxyBase();
    if (!base) return _normalizeError('Proxy not configured', 'NO_PROXY');
    const result = await _postJSON(_buildUrl(`${base}/express-checkout`, '/create-cart'), {
      lines: lines.map(l => ({
        variant_id: Number(l.variantId),
        quantity: Number(l.quantity || 1),
        properties: l.properties && typeof l.properties === 'object' && !Array.isArray(l.properties) ? l.properties : undefined,
      })),
      discount_codes: discountCodes?.length ? discountCodes : undefined,
    });
    if (!result.ok) return result;
    if (!result.data?.checkout_url) {
      return _normalizeError('No checkout URL in response', 'MISSING_CHECKOUT_URL');
    }
    return _normalizeSuccess({ checkoutUrl: result.data.checkout_url, cartId: result.data.cart_id });
  },
};

// ─── Public SDK ──────────────────────────────────────────────────────

const SpectrumSDK = {
  VERSION,
  configure,
  getActiveCurrency,
  cart,
  products,
  recentlyViewed,
  sections,
  platform,
  priceAdjustments,
  money,
  reviews,
  wishlist,
  search,
  events,
  native,
  VideoElement: SpectrumVideo,
  Countdown: SpectrumCountdown,
};

window.Spectrum = SpectrumSDK;

// ─── Recently-viewed: auto-track current PDP ─────────────────────────
//
// PDP detection is URL-based (`/products/<handle>`) — theme-agnostic and
// independent of `ShopifyAnalytics.meta` (not present on every theme). Runs
// once at SDK load. Off-PDP pages match nothing and skip silently.
try {
  const _rvPathMatch = window.location.pathname.match(/\/products\/([^/?#]+)/);
  if (_rvPathMatch && _rvPathMatch[1]) {
    recentlyViewed.push(_rvPathMatch[1]);
  }
} catch {}

// ─── Auto-Merge Guest Wishlist on Login ──────────────────────────────

if (_isLoggedIn()) {
  const guestItems = _getGuestItems();
  if (guestItems.length > 0) {
    _mergeGuestToServer().then((result) => {
      if (result.ok) _clearGuestItems();
      const merged = result.ok ? result.data?.merged ?? guestItems.length : 0;
      const duplicates = result.ok ? result.data?.duplicates ?? 0 : 0;
      _track('wishlist_merge', { itemsMerged: merged, duplicatesSkipped: duplicates });
      _emit('wishlist:merged', {});
    });
  }
}

})();
