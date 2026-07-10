/* =============================================================================
 * Virtual Try-On (o1uear1c)
 *
 * Storefront runtime for the VTO snippet. The Liquid template server-renders
 * the CTA button (for LCP) plus a <script type="application/json"> data block
 * carrying product variants, the editorial-look outfit companions, the FBT
 * recommendations payload, the saved customer photo, and an optional
 * model-worn reference image. This runtime:
 *
 *   1. Defines the <sai-o1uear1c> custom element. Reading the data block and
 *      wiring the CTA happen once in connectedCallback.
 *   2. Binds each container via __spectrumAi.snippet.bind(node, callback) to
 *      capture the analytics `track` handle.
 *   3. Opens a multi-step <dialog> try-on flow when the CTA is clicked:
 *      consent → photo → AI processing → result (scene changer +
 *      complete-the-look companions + add-to-cart). The variant to try on is
 *      the PDP's selected variant (URL `?variant=` / current-variant API, else
 *      the first available), resolved once in openTryOn — there is no in-modal
 *      variant picker.
 *
 * Why a native <dialog>: showModal() puts the modal in the browser top layer,
 * so it escapes the host theme's overflow/transform clipping, traps focus,
 * closes on Esc, and exposes ::backdrop — all without a hand-rolled focus
 * trap. The dialog is created once on first open and appended to <body>; a
 * click-triggered overlay is a user action, not a load-time side effect.
 *
 * Scope: this file ships to merchant themes and runs only as a <script src>
 * from a theme — a browser DOM is the single execution environment. It does
 * not guard on `typeof window` (there is no non-DOM path); it does
 * feature-detect optional browser APIs.
 *
 * No-bind fallback: if window.__spectrumAi is absent (theme without the
 * Spectrum embed, or local dev without the bootstrap SDK), the SSR'd CTA still
 * renders and the modal still opens; analytics are silently skipped
 * (track = noop).
 *
 * Endpoint contract (all under data-proxy-base, default /apps/spectrum):
 *   POST   /vto/upload-url   multipart `photo` part → { r2Key, publicUrl }
 *   POST   /vto/generate     JSON → { resultImageUrl, validationWarnings[] }
 *   GET    /vto/scenes       → { scenes: [{ id, name, thumbnailUrl, imageUrl }] }
 *   GET    /vto/rate-limit   ?limit=N → { remaining, limit, resetAt }
 *   DELETE /vto/photo        clears the saved photo + R2 object
 *   POST   /customer/metafield  saves a logged-in shopper's photo reference
 * ============================================================================= */

;(() => {
  if (window.__sai_o1uear1c_initialized__) return
  window.__sai_o1uear1c_initialized__ = true

  const SNIPPET_ID = 'o1uear1c'
  const TAG = 'sai-o1uear1c'
  const FEATURE_SLUG = 'virtual_try_on'

  // The "keep my own background" scene is the generation baseline: when it is
  // selected, /vto/generate is called WITHOUT sceneImageUrl, so the server
  // preserves the shopper's own background (in-place mode). It is synthesized
  // client-side (buildKeepBackgroundScene) and prepended to the server's scene
  // list. Every other scene — including "Studio" — passes its imageUrl through.
  const BASELINE_SCENE_ID = 'keep-background'

  // Hard ceiling matching the worker's VTO_MAX_PHOTO_BYTES — rejecting an
  // oversized file client-side avoids a wasted multipart round-trip.
  const MAX_PHOTO_BYTES = 10 * 1024 * 1024

  // Generation is mostly FAL queue/poll I/O wait (server auto-retries once).
  // A multi-garment "Complete Look" composites several reference images and
  // runs longer than a single-garment try-on, so the ceiling sits above the
  // server's per-attempt budget plus its result-persist step. A genuinely
  // wedged request still surfaces an error here instead of spinning forever.
  const GENERATE_TIMEOUT_MS = 120000

  // FBT items contributing to a "Complete Look" are capped so the
  // multi-garment /vto/generate call stays within a sane reference-image count.
  const MAX_COMPLETE_LOOK_ITEMS = 3

  // The synthetic first filmstrip tile: the current product worn on its own.
  // Distinguished from a named editorial look so generation sends no extra
  // garments and the products list is suppressed for it.
  const SOLO_LOOK_ID = 'solo'

  // Shopify's `| image_url` filter emits protocol-relative URLs (`//cdn.shopify.com/…`).
  // The VTO API expects absolute `https:` URLs.
  function absUrl(url) {
    if (typeof url === 'string' && url.startsWith('//')) return `https:${url}`
    return url
  }

  // Reassurance copy cycled during the processing step.
  const PROCESSING_MESSAGES = ['Styling your complete look…', 'Perfecting the details…', 'Almost there…']

  // Consent record constants — HAND-MIRRORED from @spectrum/core/types/vto-photo.ts
  // (VTO_CONSENT_VERSION, VTO_CONSENT_SCOPES). This standalone IIFE ships to
  // merchant themes and cannot import core, so the values are copied as literals.
  // A drift-guard test asserts they equal the core constants, so the two cannot
  // silently diverge.
  //
  // LEGAL GATE: the `biometric` scope and the consent/disclaimer copy below are
  // an engineering default. Enabling live biometric collection requires legal
  // sign-off and a publicly available written biometric retention policy first;
  // the copy shipped here is not legal-approved.
  const CONSENT_VERSION = 'v3'
  const CONSENT_SCOPES = ['upload', 'processing', 'storage', 'biometric']

  // Per-scope consent-row copy, keyed by scope: [title, description]. The consent
  // step builds one toggle row per CONSENT_SCOPES entry from this map, so the
  // "every scope required to proceed" gate and the persisted consentScope stay in
  // lockstep — a scope added to CONSENT_SCOPES gains a row and extends the gate
  // automatically. `biometric` names the face-data collection and the third-party
  // AI processor in plain shopper terms.
  const CONSENT_SCOPE_COPY = {
    upload: ['Upload my photo', 'I have the rights to the photo I share.'],
    processing: ['Process it with AI', 'Generate a try-on preview from my photo.'],
    storage: ['Store it securely to reuse', 'Skip re-uploading next time. Delete anytime.'],
    biometric: [
      'Use the biometric data in my photo',
      'My photo shows my face. Allow AI — via our provider FAL — to read its facial features to place the product, and store it briefly to power try-on.',
    ],
  }

  // Default consent + result copy. Both can be overridden per placement via the
  // `consentText` / `disclaimerText` props. The consent default carries the
  // biometric/face disclosure: a try-on photo contains the shopper's facial
  // features (biometric data), processed by a third-party AI provider to
  // visualise the product, stored briefly, and deletable. Mirrors
  // VTO_BIOMETRIC_DISCLOSURE in core under the same LEGAL GATE noted above.
  const DEFAULT_CONSENT_TEXT =
    "To create your virtual try-on, we use AI to process biometric data from the photo you upload — the facial features that let us show this product on you. Your photo is sent to our third-party AI provider to generate the image and is stored securely so you can reuse it; you can delete it anytime and it's removed within 5 days. We keep your own face and your own background."
  const DEFAULT_DISCLAIMER_TEXT =
    "This image is AI-generated from your photo and may not perfectly reflect the product's fit, colour, or finish — or your exact facial features."

  function noop() {}

  // safeTrack wraps every track call so a malformed payload or a downstream
  // analytics bug never breaks the modal flow.
  function safeTrack(track) {
    return (name, payload) => {
      try {
        track(name, payload)
      } catch (_) {
        /* swallow — analytics is best-effort */
      }
    }
  }

  // ── Observational try-on instrumentation. A privacy-safe engagement funnel
  // that runs ALONGSIDE the detailed _emit events. It carries no biometric
  // data by construction: every event is built by buildEngagementPayload, the
  // single chokepoint below.

  // Mint a fresh anonymous correlation id for one try-on session. Random and
  // opaque: it stitches a single modal session's engagement signals
  // (open → generate → add-to-cart) into one funnel WITHOUT carrying shopper
  // identity. It is not derived from the photo, the customer, or any stable
  // identifier, and is never persisted — a new id is minted on every modal
  // open. crypto.randomUUID is feature-detected for the rare browser lacking it.
  function newTryOnId() {
    const c = globalThis.crypto
    if (c && typeof c.randomUUID === 'function') return c.randomUUID()
    return `to-${Math.random().toString(36).slice(2, 12)}${Date.now().toString(36)}`
  }

  // Build the observational engagement payload. Deliberately minimal — the
  // family tag, the session correlation id, and an outcome status, and NOTHING
  // else. By contract it must never carry the shopper-photo URL, any mask or
  // biometric-derived reference, or the generated result-image URL, so the
  // try-on engagement funnel is analysable without ever touching biometric
  // data. This builder is that contract's single enforcement point: the emit
  // path passes only these three values, so no biometric pointer can reach the
  // analytics stream. Pure + exported for the contract test.
  function buildEngagementPayload(family, tryOnId, status) {
    return {
      family: family || 'garment',
      try_on_id: tryOnId || null,
      status: status || null,
    }
  }

  // Parse the SSR JSON data block. Returns null when the block is missing or
  // malformed — callers degrade rather than throw. The block is emitted by the
  // Liquid template with per-value `| json` escaping, so JSON.parse is safe.
  function readPayload(root) {
    const el = root.querySelector('script[type="application/json"][data-vto-payload]')
    if (!el) return null
    try {
      return JSON.parse(el.textContent || '')
    } catch (_) {
      return null
    }
  }

  // sessionStorage key for the per-instance consent record. Keyed on the
  // mutation handle so two VTO placements on one page track consent
  // independently; the handle is the wrapper's [data-spectrum-instance-id].
  function consentStorageKey(mutationHandle) {
    return `${mutationHandle || SNIPPET_ID}:vto-consent`
  }

  // sessionStorage key for the anonymous shopper's saved photo reference.
  function photoStorageKey(mutationHandle) {
    return `${mutationHandle || SNIPPET_ID}:vto-photo`
  }

  // Read the variant id the shopper has selected on the PDP. The page URL's
  // `?variant=` param is the most reliable cross-theme signal; a Spectrum
  // current-variant API is consulted first when present.
  function extractSelectedVariantId(loc, spectrumApi) {
    const fromApi = spectrumApi?.product?.currentVariantId
    if (fromApi != null) return String(fromApi)
    try {
      const params = new URLSearchParams(loc?.search || '')
      const v = params.get('variant')
      return v ? String(v) : null
    } catch (_) {
      return null
    }
  }

  // Pick the variant to try on: the explicitly-selected one when it exists in
  // the payload, else the first available variant, else the first variant.
  // Never returns undefined when the product has at least one variant.
  function pickActiveVariant(variants, selectedId) {
    const list = Array.isArray(variants) ? variants : []
    if (list.length === 0) return null
    if (selectedId != null) {
      const match = list.find((v) => String(v.id) === String(selectedId))
      if (match) return match
    }
    return list.find((v) => v.available) || list[0]
  }

  // Normalise the FBT metafield payload into a flat array of recommendation
  // objects. Data ingestion authors this metafield; the exact shape is
  // tolerated loosely — an array, or an object with a `recommendations` /
  // `products` / `items` array — so a schema tweak upstream doesn't blank the
  // section. Returns [] when nothing usable is present.
  function parseFbtRecommendations(fbt) {
    let raw = fbt
    if (raw && typeof raw === 'string') {
      try {
        raw = JSON.parse(raw)
      } catch (_) {
        return []
      }
    }
    let list = null
    if (Array.isArray(raw)) list = raw
    else if (raw && typeof raw === 'object') {
      list = raw.recommendations || raw.products || raw.items || null
    }
    if (!Array.isArray(list)) return []
    return list
      .map((item) => {
        if (!item || typeof item !== 'object') return null
        const variantId = item.variantId ?? item.variant_id ?? item.firstAvailableVariantId ?? null
        return {
          id: item.id ?? item.productId ?? item.handle ?? null,
          handle: item.handle ?? null,
          title: item.title ?? item.name ?? 'Product',
          imageUrl: item.imageUrl ?? item.image ?? item.featuredImageUrl ?? null,
          price: item.priceFormatted ?? item.price ?? null,
          variantId: variantId != null ? String(variantId) : null,
        }
      })
      .filter((item) => item !== null)
  }

  // Normalise the editorial-looks payload (product.metafields.spectrum.
  // editorial_looks_<state>, walked server-side to the current product's outfit
  // companions) into the same flat item shape parseFbtRecommendations returns,
  // so every downstream helper — fbtItemKey, selectCompleteLookGarments, the
  // grid renderer, add-to-cart — works against either source unchanged.
  // Returns [] when the array is missing or carries nothing usable.
  function parseEditorialLookGarments(editorialLooks) {
    let raw = editorialLooks
    if (raw && typeof raw === 'string') {
      try {
        raw = JSON.parse(raw)
      } catch (_) {
        return []
      }
    }
    if (!Array.isArray(raw)) return []
    return raw
      .map((item) => {
        if (!item || typeof item !== 'object') return null
        const variantId = item.variant_id ?? item.variantId ?? null
        return {
          id: item.product_id ?? item.id ?? item.handle ?? null,
          handle: item.handle ?? null,
          title: item.title ?? 'Product',
          imageUrl: item.image_url ?? item.imageUrl ?? null,
          price: item.price ?? null,
          variantId: variantId != null ? String(variantId) : null,
        }
      })
      .filter((item) => item !== null)
  }

  // Normalise the grouped editorial-looks payload (product.metafields.spectrum.
  // editorial_looks_<state>, walked server-side into named look groups) into
  // [{ id, title, products[] }] where each product carries the same flat item
  // shape the FBT / companion parsers return, plus `isCurrent` (the look's copy
  // of the product being tried on) and `role`. A look with no usable product is
  // dropped. Returns [] when the array is missing or carries nothing usable.
  function parseLooks(looks) {
    let raw = looks
    if (raw && typeof raw === 'string') {
      try {
        raw = JSON.parse(raw)
      } catch (_) {
        return []
      }
    }
    if (!Array.isArray(raw)) return []
    return raw
      .map((look) => {
        if (!look || typeof look !== 'object') return null
        const products = (Array.isArray(look.products) ? look.products : [])
          .map((item) => {
            if (!item || typeof item !== 'object') return null
            const variantId = item.variant_id ?? item.variantId ?? null
            const variants = (Array.isArray(item.variants) ? item.variants : [])
              .map((v) => {
                if (!v || typeof v !== 'object' || v.id == null) return null
                return { id: String(v.id), title: v.title ?? '', available: v.available !== false }
              })
              .filter(Boolean)
            return {
              id: item.product_id ?? item.id ?? item.handle ?? null,
              handle: item.handle ?? null,
              title: item.title ?? 'Product',
              imageUrl: item.image_url ?? item.imageUrl ?? null,
              price: item.price ?? null,
              variantId: variantId != null ? String(variantId) : null,
              variants,
              role: item.role ?? null,
              isCurrent: item.is_current === true,
            }
          })
          .filter((item) => item !== null)
        if (products.length === 0) return null
        return {
          id: String(look.id ?? look.title),
          title: look.title ?? 'Look',
          heroImage: look.hero_image || look.heroImage || null,
          products,
        }
      })
      .filter((look) => look !== null)
  }

  // Stable identity for an FBT recommendation, used both as the key in the
  // Complete Look selection Set and to map a selection back to its item. Must
  // agree everywhere it is computed: id first, then handle, then title.
  function fbtItemKey(item) {
    return String(item.id ?? item.handle ?? item.title)
  }

  // Resolve the selected Complete Look FBT keys to the id-tuples the labelled
  // multi-garment generation needs: { productId, variantId, imageUrl } per item.
  // The productId is what lets the server resolve each additional's per-product
  // config (family, category, packshot) so the prompt can NAME it; imageUrl is
  // the index-aligned fallback for an item whose product has no config row. A
  // selected item with no usable image or no product id is skipped. Order
  // follows `fbtItems` (the rendered order), not Set insertion order, so the
  // request is deterministic for a given recommendation list.
  function selectCompleteLookGarments(fbtItems, selectedKeys) {
    const out = []
    for (const item of fbtItems) {
      if (selectedKeys.has(fbtItemKey(item)) && item.imageUrl && item.id != null) {
        out.push({
          productId: String(item.id),
          variantId: item.variantId != null ? String(item.variantId) : undefined,
          imageUrl: item.imageUrl,
        })
      }
    }
    return out
  }

  // Synthesize the "keep my own background" baseline scene. It carries no
  // imageUrl, so buildGenerateBody omits sceneImageUrl for it and the server
  // preserves the shopper's own background. The thumbnail is the shopper's own
  // photo, so the strip reads as "your photo".
  function buildKeepBackgroundScene(photoUrl) {
    return { id: BASELINE_SCENE_ID, name: 'Your photo', thumbnailUrl: photoUrl || '' }
  }

  // Assemble the /vto/generate request body from flow + payload state. Pure so
  // the per-family branch, the look-image fallback, and the scene gate stay
  // unit-testable. Returns null when the shopper photo or a garment image is
  // missing (the caller surfaces a missing-input outcome).
  //
  // Family branch: the single-product families (jewellery, makeup) send only the
  // product id + the shopper photo + the product image. garmentImageUrl stays
  // populated because the request schema still requires it, but the route
  // server-resolves the real packshot from per-product config and ignores the
  // body value for these families. They carry no look image, no scene, no
  // composited garments, and no garment-region hints — those are garment-only
  // signals. Garment keeps the whole-look path unchanged: modelWornImageUrl
  // prefers the `vto_reference_image` metafield and falls back to the featured
  // image; a scene is forwarded only when it overrides the keep-background
  // baseline (so keep-background / no scene preserves the shopper's own
  // background in place).
  function buildGenerateBody(opts) {
    const payload = opts.payload
    const product = payload && payload.product
    const variant = opts.variant
    const garmentImageUrl = absUrl((variant && variant.imageUrl) || (product && product.featuredImageUrl))
    if (!opts.photoUrl || !garmentImageUrl) return null

    const family = resolveFamily(opts.family)

    const body = {
      personImageUrl: opts.photoUrl,
      garmentImageUrl,
      dailyLimit: opts.dailyLimit,
    }
    // Forward the product id so the server resolves per-product config (garment
    // body region; or, for the single-product families, the packshot/shade).
    // Absent on older payloads.
    if (product && (typeof product.id === 'number' || typeof product.id === 'string')) {
      body.productId = String(product.id)
    }
    // Forward the selected variant id so the server can resolve a variant-scoped
    // config row (e.g. one makeup shade), falling back to the product-level row
    // when the variant isn't configured. Sent for every family; garment ignores it.
    if (variant && (typeof variant.id === 'number' || typeof variant.id === 'string')) {
      body.variantId = String(variant.id)
    }

    // Single-product families stop here — no look/scene/composite/garment-region
    // fields reach the wire; the server owns those inputs from config.
    if (family !== 'garment') return body

    // ── Garment (whole-look path) ──
    if (product && typeof product.type === 'string' && product.type) {
      body.garmentType = product.type
    }
    if (product && typeof product.category === 'string' && product.category) {
      body.garmentTaxonomy = product.category
    }
    // Complete Look additionals go on the wire as BOTH: `additionalGarments`
    // (id-only tuples — the labelled path the server config-resolves per item)
    // AND `additionalGarmentImageUrls` (the SAME items, same order — the
    // index-aligned flat-lay fallback for an additional whose product has no
    // config row). The two arrays are built from one ordered list so slot i is
    // the same item in both; a drift would hand the server the wrong fallback.
    const extraGarments = opts.additionalGarments
    if (Array.isArray(extraGarments) && extraGarments.length > 0) {
      body.additionalGarments = extraGarments.map((g) =>
        g.variantId != null
          ? { productId: g.productId, variantId: g.variantId }
          : { productId: g.productId },
      )
      body.additionalGarmentImageUrls = extraGarments.map((g) => absUrl(g.imageUrl))
    }
    // The look image: prefer the curated metafield, else the product's featured
    // image. Drives the whole styled look and the primary garment's fit.
    const lookImage = (payload && payload.vtoReferenceImage) || (product && product.featuredImageUrl)
    if (lookImage) body.modelWornImageUrl = absUrl(lookImage)
    // Forward a scene only when it overrides the keep-background baseline.
    const scene = opts.activeScene
    if (scene && scene.id !== BASELINE_SCENE_ID && scene.imageUrl) {
      body.sceneImageUrl = absUrl(scene.imageUrl)
    }
    return body
  }

  // Photo-guidance copy per try-on family. The upload-affordance lede states
  // what the shopper photo needs to show; it differs by family because apparel
  // needs the full body, a necklace the neckline, and a lip shade the face.
  // Garment is the default and its copy is unchanged. The result/preview display
  // crop is the CSS counterpart, gated on data-vto-family on the dialog.
  const FAMILY_PHOTO_COPY = {
    garment: {
      lede: 'One person, full-body, standing straight, in good lighting. We keep your face and background.',
    },
    jewellery: {
      lede: 'A front-facing photo with your shoulders visible, in good lighting. We keep your face and background.',
    },
    makeup: {
      lede: 'A clear, close-up photo of your face, in good lighting. We keep your features and background.',
    },
  }

  // Normalise a payload family signal to a known family. Only the recognised
  // non-garment families pass through; anything else (absent, garbled, or a
  // future family this runtime predates) falls back to the garment path — the
  // safe default. Keeping this an explicit allow-list (not a denylist) is what
  // stops a new server-side family from silently coercing to garment and
  // rendering with the wrong display crop / engagement tag.
  function resolveFamily(raw) {
    return raw === 'jewellery' || raw === 'makeup' || raw === 'eyewear' ? raw : 'garment'
  }

  // Photo-step guidance copy for a family, falling back to garment for any
  // unrecognised value so a missing signal degrades safely.
  function familyPhotoCopy(family) {
    return FAMILY_PHOTO_COPY[family] || FAMILY_PHOTO_COPY.garment
  }

  // Build the VtoPhotoMetafield consent record persisted on upload — see
  // packages/core/types/vto-photo.ts for the shape. consentVersion / consentScope
  // are taken from the hand-mirrored CONSENT_VERSION / CONSENT_SCOPES literals, so
  // the record always reflects the current consent contract (every scope the
  // shopper had to agree to, including biometric). Pure + exported for the
  // drift-guard test; `_persistPhoto` calls it with the live flow values.
  function buildConsentRecord(photoUrl, r2Key) {
    return {
      photoUrl,
      r2Key,
      consentedAt: new Date().toISOString(),
      consentVersion: CONSENT_VERSION,
      consentScope: CONSENT_SCOPES.slice(),
    }
  }

  // A stored consent-bearing record — a saved photo (customer metafield or the
  // anonymous sessionStorage photo) or the sessionStorage consent flag — only
  // counts as prior consent when it was captured under the CURRENT
  // CONSENT_VERSION. A record from an older version, or one predating the
  // consentVersion field, must re-prompt: re-consent is the entire purpose of a
  // version bump. The photo such a record points at stays usable for prefill;
  // only the consent-skip is gated on the version. Pure + exported for the tests.
  function consentRecordCurrent(record) {
    return !!record && record.consentVersion === CONSENT_VERSION
  }

  // ── Test surface — pure helpers exposed for unit tests when the harness
  // flag is set. Production never sets the flag.
  if (typeof globalThis !== 'undefined' && globalThis.__SAI_TEST_HARNESS__ === true) {
    globalThis.__saiO1uear1c = {
      readPayload,
      safeTrack,
      consentStorageKey,
      photoStorageKey,
      extractSelectedVariantId,
      pickActiveVariant,
      parseFbtRecommendations,
      parseEditorialLookGarments,
      parseLooks,
      fbtItemKey,
      selectCompleteLookGarments,
      buildKeepBackgroundScene,
      buildGenerateBody,
      resolveFamily,
      familyPhotoCopy,
      buildConsentRecord,
      consentRecordCurrent,
      newTryOnId,
      buildEngagementPayload,
      BASELINE_SCENE_ID,
      CONSENT_VERSION,
      CONSENT_SCOPES,
      DEFAULT_CONSENT_TEXT,
      DEFAULT_DISCLAIMER_TEXT,
    }
  }

  // ── Small DOM helpers. The modal is built entirely via element creation —
  // never innerHTML string interpolation. Every server-supplied value (product
  // titles, FBT names, scene names, props copy) lands through the `text` key,
  // i.e. textContent: no XSS surface and no manual escaping. There is
  // deliberately no innerHTML path here.

  function el(tag, className, props) {
    const node = document.createElement(tag)
    if (className) node.className = className
    if (props) {
      for (const key of Object.keys(props)) {
        const value = props[key]
        if (key === 'text') node.textContent = value
        else if (key in node) node[key] = value
        else node.setAttribute(key, value)
      }
    }
    return node
  }

  // A lucide-style stroked SVG icon. `paths` is an array of `d` strings.
  // `paths` are drawn in a `box`×`box` coordinate space (default 24 — the
  // standard lucide grid). `size` is the rendered pixel size. Passing `box`
  // explicitly is required whenever the path data isn't authored at `size`
  // scale; getting it wrong clips the icon to a fragment.
  function icon(paths, size, box) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    const s = String(size || 18)
    const vb = String(box || size || 18)
    svg.setAttribute('width', s)
    svg.setAttribute('height', s)
    svg.setAttribute('viewBox', `0 0 ${vb} ${vb}`)
    svg.setAttribute('fill', 'none')
    svg.setAttribute('focusable', 'false')
    svg.setAttribute('aria-hidden', 'true')
    for (const d of paths) {
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
      path.setAttribute('d', d)
      path.setAttribute('stroke', 'currentColor')
      path.setAttribute('stroke-width', '1.6')
      path.setAttribute('stroke-linecap', 'round')
      path.setAttribute('stroke-linejoin', 'round')
      svg.appendChild(path)
    }
    return svg
  }

  // The Spectrum logo (mark + wordmark), rendered filled. Uses
  // fill=currentColor so the watermark CSS controls its colour; the mark path
  // needs evenodd to keep its interior cutouts. viewBox matches the source
  // asset's intrinsic 423×64 box.
  function spectrumLogo() {
    const ns = 'http://www.w3.org/2000/svg'
    const svg = document.createElementNS(ns, 'svg')
    svg.setAttribute('viewBox', '0 0 423 64')
    svg.setAttribute('fill', 'currentColor')
    svg.setAttribute('focusable', 'false')
    svg.setAttribute('aria-hidden', 'true')
    const wordmark = document.createElementNS(ns, 'path')
    wordmark.setAttribute('d', 'M79.52 26.24C79.52 31.952 108.992 23.36 108.992 39.44C108.992 43.328 107.504 49.952 92.816 49.952H86.672C71.984 49.952 70.496 41.888 70.496 38H79.568C79.568 39.008 80.192 41.36 84.224 41.36H96.704C99.248 41.36 99.92 40.448 99.92 39.44C99.92 33.296 70.4 42.368 70.4 26.24C70.4 22.304 71.888 15.68 86.624 15.68H92.72C107.456 15.68 108.944 23.744 108.944 27.68H99.824C99.824 26.624 99.248 24.32 95.168 24.32H82.688C80.048 24.32 79.52 25.184 79.52 26.24ZM136.004 15.68C142.196 15.68 152.372 16.64 152.372 28.496C152.372 40.352 142.196 41.312 136.004 41.312H120.596V49.952H111.476V15.68H136.004ZM136.772 32.72C141.62 32.72 142.82 31.184 142.82 28.496C142.82 25.808 141.62 24.32 136.772 24.32H120.596V32.72H136.772ZM154.801 15.68H192.097V24.176H163.873V28.928H192.097V36.944H163.873V41.456H192.097V49.952H154.801V15.68ZM210.118 24.32C205.27 24.32 204.118 28.496 204.118 32.816C204.118 37.184 205.27 41.36 210.118 41.36H222.598C226.198 41.36 227.686 39.536 228.358 35.936H238.006C236.518 48.752 225.814 49.952 220.102 49.952H212.614C206.47 49.952 194.518 48.608 194.518 32.816C194.518 17.072 206.47 15.68 212.614 15.68H220.102C225.814 15.68 236.518 16.88 238.006 29.696H228.358C227.926 26.384 226.198 24.32 222.598 24.32H210.118ZM238.499 24.32V15.68H273.011V24.32H260.147V49.952H251.075V24.32H238.499ZM316.346 28.496C316.346 36.032 312.218 39.152 307.658 40.448L318.074 49.952H305.642L296.618 41.312H284.57V49.952H275.45V15.68H299.978C306.17 15.68 316.346 16.64 316.346 28.496ZM284.57 24.32V32.72H300.746C305.594 32.72 306.794 31.184 306.794 28.496C306.794 25.808 305.594 24.32 300.746 24.32H284.57ZM353.148 32.816V15.68H362.268V32.816C362.268 48.608 350.316 49.952 344.172 49.952H336.684C330.54 49.952 318.588 48.608 318.588 32.816V15.68H327.708V32.816C327.708 37.184 329.34 41.36 334.188 41.36H347.148C351.996 41.36 353.148 37.184 353.148 32.816ZM392.305 40.256L404.209 15.68H418.993V49.952H409.873V25.136L398.113 49.952H386.449L374.689 25.136V49.952H365.617V15.68H380.353L392.305 40.256Z')
    const mark = document.createElementNS(ns, 'path')
    mark.setAttribute('fill-rule', 'evenodd')
    mark.setAttribute('clip-rule', 'evenodd')
    mark.setAttribute('d', 'M22.3286 0C22.963 0.0413433 23.6023 0.0375721 24.227 0.0771484C30.6625 0.484851 36.9437 3.62804 41.8969 7.42578C42.6755 8.02258 44.189 9.23645 44.8432 9.91504L33.6713 20.9541C34.917 22.2163 36.1344 23.3551 37.2875 24.7178C42.0091 30.2963 45.6281 37.315 44.725 44.6582C44.2491 48.7077 42.497 52.5253 39.6996 55.6084C37.4206 58.1146 34.5303 60.072 31.3666 61.4346C29.8672 62.08 28.2402 62.6334 26.7104 63.2344C25.4952 63.7114 23.9291 63.9031 22.6293 63.9932C22.0023 64.0019 21.2671 64.0086 20.6411 63.9688C14.2754 63.5625 8.12043 60.4825 3.19867 56.7715C2.35948 56.1385 0.748809 54.8513 0.0502322 54.1064C1.5444 52.6952 3.04881 51.1643 4.5141 49.7158L11.2192 43.0918C8.80053 40.7773 6.67142 38.428 4.82367 35.666C1.55523 30.7804 -0.611089 24.9787 0.154724 19.1328C0.66123 15.0635 2.45637 11.2375 5.30219 8.16406C8.48682 4.75101 12.2397 2.76515 16.7123 1.28613C18.724 0.620894 20.1163 0.121257 22.3286 0ZM15.3735 39.0264C14.0337 40.3484 12.5865 41.7287 11.2875 43.0762C15.1019 46.5593 19.3059 49.3135 24.2338 51.1924C26.5689 52.036 30.3685 53.0813 32.9037 52.915C33.2021 52.7202 33.3241 52.6049 33.5307 52.3193C33.5239 50.3853 33.1699 48.7255 32.558 46.8789C30.7096 41.2989 27.0028 36.288 22.643 32.2188C22.5625 32.1437 22.5297 32.0892 22.4203 32.0732L15.3735 39.0264ZM11.9174 11.0889C11.5924 11.1919 11.3827 11.5323 11.2045 11.8008L11.2319 11.8594C11.3608 12.1432 11.3803 12.2916 11.3842 12.5986C11.3904 13.0896 11.4683 13.5641 11.5483 14.0479C11.6866 14.8705 11.8771 15.6854 12.1176 16.4863C13.6202 21.4711 16.6698 26.0836 20.311 29.9053C20.8425 30.4632 21.8645 31.5401 22.4477 31.9443C22.9289 31.5725 23.8764 30.5872 24.3383 30.1289L27.5688 26.9336L31.4399 23.1152C32.0844 22.4786 33.0103 21.6143 33.5873 20.958C32.8467 20.2443 32.0551 19.594 31.2495 18.9482C26.0261 14.7612 18.8613 11.1838 11.9174 11.0889Z')
    svg.appendChild(wordmark)
    svg.appendChild(mark)
    return svg
  }

  if (!customElements.get(TAG)) {
    class SaiVirtualTryOn extends HTMLElement {
      connectedCallback() {
        if (this._initialized) return
        this._initialized = true

        // Defaults; replaced via setAnalytics() once bindAllContainers runs.
        this._track = noop

        // Parsed once. `editorialLooks` is the current product's curated outfit
        // companions ([] when the product has no editorial look); `fbt` is null
        // when the FBT metafield is absent; `customerPhoto` is null for
        // anonymous shoppers or shoppers with no saved photo; `vtoReferenceImage`
        // is null when the product has no model-worn reference metafield.
        this._payload = readPayload(this) || {}

        // The try-on family (garment | jewellery | makeup) selects the
        // photo-guidance copy and the result/preview display-crop CSS hook.
        // Server-resolved per product; absent on the garment payload (the
        // default). Constant for this instance, so it is resolved once.
        this._family = resolveFamily(this._payload?.family)

        // Identity / config read off the wrapper + payload, resolved once.
        this._mutationHandle =
          this.closest('[data-spectrum-instance-id]')?.getAttribute('data-spectrum-instance-id') ||
          ''
        this._proxyBase =
          window.__spectrumAi?.baseProxyUrl ||
          this.getAttribute('data-proxy-base') ||
          '/apps/spectrum'
        this._dailyLimit = Number(this._payload?.props?.dailyGenerationLimit) || 10
        // Spectrum watermark on the result image. Internal-only prop; defaults
        // to shown — only an explicit `false` hides it.
        this._showBranding = this._payload?.props?.showBranding !== false

        // Modal state — built lazily on first open and reused thereafter.
        this._dialog = null
        this._refs = null
        // Mutable per-session flow state. Reset each time the modal opens.
        this._flow = null

        // In-flight async work that must be cancellable when the modal closes
        // or the shopper navigates away from the step that started it:
        //   _genController — AbortController for the active /vto/generate fetch
        //   _genCycle      — setInterval handle rotating the processing copy
        //   _genTimeout    — setTimeout handle backing the generate deadline
        // _genSerial is a monotonic counter bumped on every async-work start;
        // each callback captures the serial it belongs to and no-ops when the
        // serial has since moved (modal closed/reopened, or a newer request
        // started). A new modal session is always a new serial because every
        // start path bumps it.
        this._genController = null
        this._genCycle = null
        this._genTimeout = null
        this._genSerial = 0

        this._initButton()
      }

      // Called once per page-load by bindAllContainers, before the bind
      // callback fires. Until then, all tracking is a noop.
      setAnalytics(track) {
        this._track = typeof track === 'function' ? safeTrack(track) : noop
      }

      _initButton() {
        const button = this.querySelector('[data-action="open-try-on"]')
        if (!button || this._buttonBound) return
        this._buttonBound = true
        button.addEventListener('click', (e) => {
          e.preventDefault()
          this.openTryOn()
        })
      }

      // ── Analytics — every event is `virtual_try_on:<event>`; the SDK adds the
      // `$spectrum:` prefix. product_id / variant_id are attached where known.
      _emit(event, extra) {
        const variant = this._flow?.variant || null
        this._track(`${FEATURE_SLUG}:${event}`, {
          product_id: this._payload?.product?.id ?? null,
          variant_id: variant ? variant.id : null,
          ...(extra || {}),
        })
      }

      // ── Observational engagement instrumentation — a privacy-safe funnel
      // distinct from _emit. Every event carries ONLY the family, the
      // per-session anonymous correlation id, and an outcome status — never the
      // product/variant ids, the shopper photo, the result image, or any
      // biometric reference. Shares the safeTrack-wrapped _track path, so an
      // analytics failure can never block or break the try-on. A fire before a
      // session exists degrades to a null id rather than throwing.
      _emitEngagement(event, status) {
        this._track(
          `${FEATURE_SLUG}:${event}`,
          buildEngagementPayload(this._family, this._flow?.tryOnId, status),
        )
      }

      // The "Complete the look" source. The merchant-curated editorial-look
      // outfit wins when present; FBT co-purchase recommendations are the
      // fallback so products without an editorial look still get companions.
      // Both resolve to the same item shape, so callers don't branch.
      _completeLookItems() {
        // "Complete the look" (editorial-look + FBT companions) is a garment-only
        // surface; the single-product families composite no extra garments, so
        // their generation body never carries additionalGarmentImageUrls.
        if (this._family !== 'garment') return []
        const editorial = parseEditorialLookGarments(this._payload?.editorialLooks)
        if (editorial.length > 0) return editorial
        return parseFbtRecommendations(this._payload?.fbt)
      }

      // ── Editorial-look filmstrip ───────────────────────────────────────────
      // The named editorial looks for the result-step filmstrip ([] when the
      // product has none — the result step then falls back to the flat FBT
      // "Complete the look" grid).
      _namedLooks() {
        // The "Tap to wear" filmstrip is a garment-only surface; the
        // single-product families show no look switching, so the result step
        // renders a single try-on with no filmstrip.
        if (this._family !== 'garment') return []
        return parseLooks(this._payload?.looks)
      }

      // The current product as a look-product item: the "Just this" tile's lone
      // product and the main garment every named look composites around.
      _currentProductItem() {
        const product = this._payload?.product || {}
        const variant = this._flow?.variant || null
        // Map the product's variants into the {id,title,available} shape the
        // product-row size picker consumes (same shape as look products), so the
        // current product gets a variant selector too — not just look products.
        const variants = (Array.isArray(product.variants) ? product.variants : [])
          .map((v) =>
            v && v.id != null
              ? { id: String(v.id), title: v.title ?? '', available: v.available !== false }
              : null,
          )
          .filter(Boolean)
        return {
          id: product.id != null ? String(product.id) : null,
          handle: product.handle ?? null,
          title: product.title ?? 'This item',
          imageUrl: (variant && variant.imageUrl) || product.featuredImageUrl || null,
          price: product.price ?? null,
          variantId: variant ? String(variant.id) : null,
          variants,
          role: null,
          isCurrent: true,
        }
      }

      // Filmstrip tiles: the synthetic "Just this" solo look first, then every
      // named editorial look in merchant order.
      _filmstripLooks() {
        const solo = {
          id: SOLO_LOOK_ID,
          title: 'Just this',
          products: [this._currentProductItem()],
        }
        return [solo, ...this._namedLooks()]
      }

      // The currently-worn look, defaulting to solo.
      _activeLook() {
        const looks = this._filmstripLooks()
        return looks.find((l) => l.id === this._flow.activeLookId) || looks[0]
      }

      // Garments the active look composites in addition to the main garment, as
      // the same { productId, variantId, imageUrl } id-tuples selectCompleteLook-
      // Garments returns: every look product that is not the current product and
      // has a usable image + product id, capped. Solo (and a look that reduces to
      // just the current product) → []. Order follows the look's product order.
      _activeLookGarments() {
        const look = this._activeLook()
        if (!look || look.id === SOLO_LOOK_ID) return []
        const out = []
        for (const item of look.products) {
          if (item.isCurrent || !item.imageUrl || item.id == null) continue
          out.push({
            productId: String(item.id),
            variantId: item.variantId != null ? String(item.variantId) : undefined,
            imageUrl: item.imageUrl,
          })
          if (out.length >= MAX_COMPLETE_LOOK_ITEMS) break
        }
        return out
      }

      // ── Entry point. Resets per-session state, builds the dialog on first
      // call, opens it, and routes to the first step.
      openTryOn() {
        // A second CTA click while the modal is already open and generating
        // must not reset _flow out from under the in-flight request — that
        // would orphan the running fetch's callbacks against a fresh session.
        // Re-focus the open modal instead of restarting the flow.
        if (this._dialog?.open && this._flow?.generating) {
          this._dialog.focus?.()
          return
        }

        // Past the guard the session is being (re)built. Invalidate any
        // in-flight work from a prior session — most importantly a photo
        // upload, whose fetch is not routed through _beginGeneration and would
        // otherwise resolve into the fresh _flow built below.
        this._cancelGeneration()

        this._emit('started')

        const product = this._payload?.product || {}
        const variants = Array.isArray(product.variants) ? product.variants : []
        const selectedId = extractSelectedVariantId(window.location, window.__spectrumAi)
        const savedPhoto = this._resolveSavedPhoto()

        this._flow = {
          // Anonymous per-session correlation id for the observational
          // engagement funnel — minted once per open, never identifying, never
          // persisted. Stitches this session's open/generate/add-to-cart
          // signals together with no biometric or shopper reference.
          tryOnId: newTryOnId(),
          // A saved photo (customer metafield or the anonymous sessionStorage
          // record) skips consent ONLY when it was captured under the current
          // CONSENT_VERSION — a version bump re-prompts every returning shopper,
          // logged-in or anonymous. The consent flag covers the in-session
          // window between consenting and the first upload. The photo itself
          // still prefills below regardless of version.
          consented: consentRecordCurrent(savedPhoto) || this._readConsent(),
          variant: pickActiveVariant(variants, selectedId),
          photoUrl: savedPhoto ? savedPhoto.photoUrl : null,
          photoSource: savedPhoto ? savedPhoto.source : null,
          resultImageUrl: null,
          validationWarnings: [],
          // A one-shot notice for the result step (set by a failed Complete
          // Look); cleared by `_renderResult` after it is shown once.
          transientNotice: null,
          scenes: null,
          activeSceneId: BASELINE_SCENE_ID,
          // Which filmstrip tile is worn: a named editorial look id, or
          // SOLO_LOOK_ID (current product alone) when the product has no looks.
          // Default to the first styled look so the result opens on a shoppable
          // outfit (with its products + size pickers) rather than the bare item.
          activeLookId: this._namedLooks()[0]?.id || SOLO_LOOK_ID,
          fbtSelectedIds: new Set(),
          generating: false,
        }

        // Record the try-on open as an observational engagement signal. Fired
        // after the flow is built so the session correlation id exists; carries
        // no product, photo, or biometric reference, and is fail-open via _track.
        this._emitEngagement('engagement_opened', 'opened')

        this._ensureDialog()
        if (!this._dialog.open) {
          // Lock background scroll while the modal owns the screen — showModal()
          // makes the page inert but does not stop it scrolling behind the
          // dialog. Restored on the `close` event.
          this._prevHtmlOverflow = document.documentElement.style.overflow
          document.documentElement.style.overflow = 'hidden'
          this._dialog.showModal()
        }

        if (!this._flow.consented) this._renderConsent()
        else this._renderPhoto()
      }

      // Saved-photo resolution: a logged-in shopper's photo on the customer
      // metafield wins; otherwise an anonymous shopper's sessionStorage record.
      // Returns { photoUrl, source, consentVersion } or null. consentVersion is
      // carried through so the consent gate can require a re-prompt when the
      // saved photo predates the current CONSENT_VERSION (it may be undefined on
      // older records — that also re-prompts).
      _resolveSavedPhoto() {
        const fromMeta = this._payload?.customerPhoto
        if (fromMeta) {
          let parsed = fromMeta
          if (typeof parsed === 'string') {
            try {
              parsed = JSON.parse(parsed)
            } catch (_) {
              parsed = null
            }
          }
          const url = parsed && (parsed.photoUrl || parsed.url)
          if (url) {
            return {
              photoUrl: url,
              source: 'metafield',
              consentVersion: parsed.consentVersion,
            }
          }
        }
        const session = this._readPhotoSession()
        if (session?.photoUrl) {
          return {
            photoUrl: session.photoUrl,
            source: 'session',
            consentVersion: session.consentVersion,
          }
        }
        return null
      }

      // The in-session consent flag is a versioned record, not a bare '1', so a
      // CONSENT_VERSION bump invalidates a flag written under the old contract
      // and the shopper re-consents. A legacy '1' value parses to a versionless
      // record and correctly reads as not-current.
      _readConsent() {
        try {
          const raw = window.sessionStorage.getItem(consentStorageKey(this._mutationHandle))
          return raw ? consentRecordCurrent(JSON.parse(raw)) : false
        } catch (_) {
          return false
        }
      }

      _writeConsent() {
        try {
          window.sessionStorage.setItem(
            consentStorageKey(this._mutationHandle),
            JSON.stringify({ consentVersion: CONSENT_VERSION }),
          )
        } catch (_) {
          /* private mode / storage disabled — consent simply re-prompts */
        }
      }

      _readPhotoSession() {
        try {
          const raw = window.sessionStorage.getItem(photoStorageKey(this._mutationHandle))
          return raw ? JSON.parse(raw) : null
        } catch (_) {
          return null
        }
      }

      _writePhotoSession(record) {
        try {
          window.sessionStorage.setItem(
            photoStorageKey(this._mutationHandle),
            JSON.stringify(record),
          )
        } catch (_) {
          /* storage disabled — photo just won't persist for next visit */
        }
      }

      _clearPhotoSession() {
        try {
          window.sessionStorage.removeItem(photoStorageKey(this._mutationHandle))
        } catch (_) {
          /* nothing to clean up */
        }
      }

      // ── Dialog shell — created once, reused. The shell holds a fixed header
      // (title + close) and footer; step renderers swap the body + footer
      // contents. The dialog stays in the DOM between opens.
      _ensureDialog() {
        if (this._dialog) return

        const dialog = el('dialog', 'sai-o1uear1c__dialog')
        // Display-crop hook for the per-family aspect-ratio rules. A 'garment'
        // value matches no override, so the default 3/4 crop stays in place.
        dialog.setAttribute('data-vto-family', this._family)
        // The dialog title is referenced by aria-labelledby; the id is made
        // unique per instance so multiple placements don't collide.
        const titleId = `sai-o1uear1c-title-${this._mutationHandle || 'x'}`
        dialog.setAttribute('aria-labelledby', titleId)

        const shell = el('div', 'sai-o1uear1c__shell')

        const header = el('div', 'sai-o1uear1c__header')
        const title = el('h2', 'sai-o1uear1c__title', { id: titleId, text: 'Virtual Try-On' })
        const close = el('button', 'sai-o1uear1c__close', {
          type: 'button',
          'aria-label': 'Close try-on',
        })
        close.appendChild(icon(['M5 5l8 8', 'M13 5l-8 8'], 18))
        close.addEventListener('click', () => this._close())
        header.appendChild(title)
        header.appendChild(close)

        // The body is an aria-live region so the processing-step status
        // updates are announced to assistive tech.
        const body = el('div', 'sai-o1uear1c__body', {
          'aria-live': 'polite',
        })
        const footer = el('div', 'sai-o1uear1c__footer')

        shell.appendChild(header)
        shell.appendChild(body)
        shell.appendChild(footer)
        dialog.appendChild(shell)

        // Clicking the ::backdrop (outside the shell) closes the modal —
        // the click lands on the <dialog> itself, not on .sai-o1uear1c__shell.
        dialog.addEventListener('click', (e) => {
          if (e.target === dialog) this._close()
        })
        // Native dialog `close` (Esc, form method=dialog, backdrop click via
        // _close, or the close button). Whatever the path, abort in-flight
        // generation so a late fetch resolution can't mutate or re-render a
        // session that is already gone.
        dialog.addEventListener('close', () => {
          document.documentElement.style.overflow = this._prevHtmlOverflow || ''
          this._cancelGeneration()
        })

        document.body.appendChild(dialog)
        this._dialog = dialog
        this._refs = { title, body, footer }
      }

      _close() {
        // Cancel first so the work stops even on browsers/paths where the
        // `close` event is delayed; the `close` listener calling
        // _cancelGeneration again is harmless (it is idempotent).
        this._cancelGeneration()
        if (this._dialog?.open) this._dialog.close()
      }

      // Begin a fresh unit of cancellable async work: clear anything still
      // pending, bump the serial, and hand back the new serial plus an
      // AbortSignal. Returns the serial so the caller can detect, in its own
      // callbacks, whether its work is still the current one.
      _beginGeneration() {
        this._cancelGeneration()
        this._genSerial += 1
        this._genController = new AbortController()
        return { serial: this._genSerial, signal: this._genController.signal }
      }

      // Tear down any in-flight generation: abort the fetch, clear the
      // interval + timeout, and clear the `generating` flag. Idempotent — safe
      // to call when nothing is pending and safe to call repeatedly. Bumping
      // the serial means a callback from the aborted request sees a stale
      // serial and no-ops; clearing `generating` directly keeps the teardown
      // self-consistent rather than depending on a serial-guarded `finally`.
      _cancelGeneration() {
        if (this._genController) {
          this._genController.abort()
          this._genController = null
        }
        if (this._genCycle != null) {
          window.clearInterval(this._genCycle)
          this._genCycle = null
        }
        if (this._genTimeout != null) {
          window.clearTimeout(this._genTimeout)
          this._genTimeout = null
        }
        if (this._flow) this._flow.generating = false
        this._genSerial += 1
      }

      _setTitle(text) {
        if (this._refs) this._refs.title.textContent = text
      }

      // Replace the body + footer contents for the current step. `isResult`
      // toggles the result-only chrome — the result step drops the header bar
      // so the generated image bleeds edge-to-edge and the close floats over
      // it. Every other step calls this without the flag, which clears the
      // modifier, so the input steps always keep their normal header.
      _setStep(bodyNodes, footerNodes, isResult) {
        const { body, footer } = this._refs
        this._dialog.classList.toggle('sai-o1uear1c__dialog--result', !!isResult)
        // The two-pane looks modifier is opt-in per render; clear it on every
        // step so the input steps (and the single-column result) get the normal
        // narrow shell. `_renderLooksResult` re-adds it after this call.
        this._dialog.classList.remove('sai-o1uear1c__dialog--looks')
        body.replaceChildren(...bodyNodes)
        footer.replaceChildren(...(footerNodes || []))
        body.scrollTop = 0
      }

      // The left-pane visual on the pre-result steps. The selected variant's own
      // image wins so the preview always shows the colour the shopper picked on
      // the PDP — falling back to the product default here reads as the wrong
      // item when a non-default colour is selected. When the variant carries no
      // image of its own, fall back to the most aspirational image available: a
      // styled look hero, else any look product image, else the model-worn
      // reference or the product's own image. Empty when the product has nothing
      // — the caller falls back to a gradient placeholder.
      _studioVisualUrl() {
        const variantImg = this._flow?.variant?.imageUrl
        if (variantImg) return absUrl(variantImg)
        const looks = this._namedLooks()
        for (const look of looks) {
          const withHero = (look.products || []).find((p) => p.heroImage)
          if (withHero) return withHero.heroImage
        }
        for (const look of looks) {
          const withImg = (look.products || []).find((p) => p.imageUrl)
          if (withImg) return withImg.imageUrl
        }
        return (
          this._payload?.vtoReferenceImage ||
          this._payload?.product?.featuredImageUrl ||
          ''
        )
      }

      // The full-bleed stage visual for consent / photo / processing: an image
      // (when `url`) or a gradient placeholder with an icon, plus an optional
      // editorial caption. `scan` overlays the AI processing animation.
      _buildStageCard(url, { caption, dim, scan } = {}) {
        const card = el('div', 'sai-o1uear1c__stage-card')
        if (url) {
          card.appendChild(
            el('img', `sai-o1uear1c__stage-img${dim ? ' sai-o1uear1c__stage-img--dim' : ''}`, {
              src: url,
              alt: '',
            }),
          )
        } else {
          card.classList.add('sai-o1uear1c__stage-card--placeholder')
          card.appendChild(icon(['M4 17l5-5 4 4 3-3 4 4', 'M4 4h16v16H4z'], 40, 24))
        }
        if (scan) {
          card.appendChild(el('div', 'sai-o1uear1c__scan'))
          const label = el('div', 'sai-o1uear1c__scan-label')
          label.appendChild(icon(['M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z'], 13, 24))
          label.appendChild(el('span', null, { text: 'AI is working on your photo' }))
          card.appendChild(label)
        }
        if (caption) card.appendChild(el('div', 'sai-o1uear1c__stage-cap', { text: caption }))
        return card
      }

      // One circular close that floats over the whole frame, every step.
      _buildFloatClose() {
        const close = el('button', 'sai-o1uear1c__float-close', {
          type: 'button',
          'aria-label': 'Close try-on',
        })
        close.appendChild(icon(['M6 6l12 12', 'M18 6L6 18'], 17, 24))
        close.addEventListener('click', () => this._close())
        return close
      }

      // Progress dots header for the input steps (1-based: consent=1 … processing=3).
      _buildStepDots(step) {
        const head = el('div', 'sai-o1uear1c__panel-head')
        for (let i = 1; i <= 3; i++) {
          let cls = 'sai-o1uear1c__step-dot'
          if (i < step) cls += ' sai-o1uear1c__step-dot--done'
          else if (i === step) cls += ' sai-o1uear1c__step-dot--active'
          head.appendChild(el('span', cls))
        }
        head.appendChild(el('span', 'sai-o1uear1c__step-label', { text: `Step ${step} of 3` }))
        return head
      }

      // Lay a step out as the consistent two-pane studio (left stage visual,
      // right controls) so the modal frame never changes shape between steps.
      // A single floating close sits over the frame; the panel head carries the
      // step dots. Used by consent, photo, and processing; the result builds an
      // equivalent shell inline (it adds a filmstrip to the stage).
      _setStudioStep({ stageNodes, stageResult, step, panelBody, panelFoot, footRow }) {
        const stage = el(
          'div',
          `sai-o1uear1c__stage${stageResult ? ' sai-o1uear1c__stage--result' : ''}`,
        )
        for (const n of stageNodes || []) if (n) stage.appendChild(n)

        const panel = el('div', 'sai-o1uear1c__panel')
        if (step) panel.appendChild(this._buildStepDots(step))

        const pbody = el('div', 'sai-o1uear1c__panel-body')
        for (const n of panelBody || []) if (n) pbody.appendChild(n)
        panel.appendChild(pbody)

        if (panelFoot && panelFoot.some(Boolean)) {
          const foot = el(
            'div',
            `sai-o1uear1c__panel-foot${footRow ? ' sai-o1uear1c__panel-foot--row' : ''}`,
          )
          for (const n of panelFoot) if (n) foot.appendChild(n)
          panel.appendChild(foot)
        }

        const lightbox = el('div', 'sai-o1uear1c__lightbox')
        lightbox.appendChild(stage)
        lightbox.appendChild(panel)
        lightbox.appendChild(this._buildFloatClose())
        this._setStep([lightbox], [], false)
        this._dialog.classList.add('sai-o1uear1c__dialog--looks')
      }

      // ── Step 1 — Consent. One granular agreement card per consent scope —
      // including the BIPA-sensitive `biometric` face-data scope — built from
      // CONSENT_SCOPES so the gate and the persisted consentScope cannot drift.
      // The primary action unlocks only when every scope is toggled on. A "Not
      // now" decline routes to an explicit declined state (_renderConsentDeclined)
      // rather than silently closing — a decliner is never processed.
      _renderConsent() {
        this._setTitle('Before we start')

        const h2 = el('h2', 'sai-o1uear1c__panel-h2', { text: 'Before we start' })
        const lede = el('p', 'sai-o1uear1c__panel-lede', {
          text: this._payload?.props?.consentText || DEFAULT_CONSENT_TEXT,
        })

        const defs = CONSENT_SCOPES.map((key) => [key, ...CONSENT_SCOPE_COPY[key]])
        const checked = {}
        for (const key of CONSENT_SCOPES) checked[key] = false
        let proceed

        const list = el('div', 'sai-o1uear1c__consent')
        for (const [key, title, desc] of defs) {
          const row = el('button', 'sai-o1uear1c__consent-row', {
            type: 'button',
            'aria-pressed': 'false',
          })
          const box = el('span', 'sai-o1uear1c__consent-box')
          const tick = icon(['M5 12l4.5 4.5L19 7'], 14, 24)
          tick.style.display = 'none'
          box.appendChild(tick)
          const txt = el('span')
          txt.appendChild(el('span', 'sai-o1uear1c__consent-title', { text: title }))
          txt.appendChild(el('span', 'sai-o1uear1c__consent-desc', { text: desc }))
          row.appendChild(box)
          row.appendChild(txt)
          row.addEventListener('click', () => {
            checked[key] = !checked[key]
            row.setAttribute('aria-pressed', checked[key] ? 'true' : 'false')
            tick.style.display = checked[key] ? '' : 'none'
            if (proceed) proceed.disabled = !defs.every(([k]) => checked[k])
          })
          list.appendChild(row)
        }

        proceed = el('button', 'sai-o1uear1c__action sai-o1uear1c__action--primary', {
          type: 'button',
          text: 'I understand',
          disabled: true,
        })
        proceed.addEventListener('click', () => {
          this._flow.consented = true
          this._writeConsent()
          this._emit('consent_given')
          this._renderPhoto()
        })

        // Explicit decline. Leaves consent unset so no upload/generation can run,
        // and shows the declined state instead of closing the modal out from
        // under the shopper.
        const decline = el('button', 'sai-o1uear1c__action sai-o1uear1c__action--ghost', {
          type: 'button',
          text: 'Not now',
        })
        decline.addEventListener('click', () => {
          this._emit('consent_declined')
          this._renderConsentDeclined()
        })

        const reassure = el('div', 'sai-o1uear1c__reassure')
        reassure.appendChild(icon(['M5 11h14v9H5z', 'M8 11V8a4 4 0 0 1 8 0v3'], 12, 24))
        reassure.appendChild(el('span', null, { text: 'Encrypted in transit · delete anytime' }))

        this._setStudioStep({
          stageNodes: [
            this._buildStageCard(this._studioVisualUrl()),
          ],
          step: 1,
          panelBody: [h2, lede, list],
          panelFoot: [proceed, decline, reassure],
        })
      }

      // ── Consent declined. A decliner is never processed — no photo is uploaded
      // and nothing is generated (AE1). The try-on entry stays available: rather
      // than vanishing, the modal shows a short reconsider affordance so a shopper
      // who declined by mistake can step back into the consent step. `consented`
      // is deliberately left false; the only path back to processing is an
      // explicit re-consent through _renderConsent.
      _renderConsentDeclined() {
        this._setTitle('No problem')

        const h2 = el('h2', 'sai-o1uear1c__panel-h2', { text: 'No problem' })
        const lede = el('p', 'sai-o1uear1c__panel-lede', {
          text: "You've declined, so we won't upload or process any photo. Changed your mind? You can reconsider anytime.",
        })

        const reconsider = el('button', 'sai-o1uear1c__action sai-o1uear1c__action--primary', {
          type: 'button',
          text: 'Reconsider',
        })
        reconsider.addEventListener('click', () => this._renderConsent())

        const dismiss = el('button', 'sai-o1uear1c__action sai-o1uear1c__action--ghost', {
          type: 'button',
          text: 'Close',
        })
        dismiss.addEventListener('click', () => this._close())

        this._setStudioStep({
          stageNodes: [this._buildStageCard(this._studioVisualUrl())],
          panelBody: [h2, lede],
          panelFoot: [reconsider, dismiss],
        })
      }

      // ── Step 2 — Photo. Reuse a saved photo or upload a new one. Two-pane:
      // the photo (or an aspirational placeholder) fills the stage; the controls
      // sit in the panel.
      _renderPhoto() {
        this._setTitle('Your photo')

        if (this._flow.photoUrl) {
          const h2 = el('h2', 'sai-o1uear1c__panel-h2', { text: 'Your photo' })
          const lede = el('p', 'sai-o1uear1c__panel-lede', {
            text: 'Looks good? Try it on — or upload a different shot.',
          })
          const chip = el('div', 'sai-o1uear1c__ready-chip')
          chip.appendChild(icon(['M5 12l4.5 4.5L19 7'], 14, 24))
          chip.appendChild(el('span', null, { text: 'Photo ready' }))

          const generate = el('button', 'sai-o1uear1c__action sai-o1uear1c__action--primary', {
            type: 'button',
          })
          generate.appendChild(icon(['M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z'], 17, 24))
          generate.appendChild(el('span', null, { text: 'Try it on' }))
          generate.addEventListener('click', () => {
            // Returning shoppers reach generation via a saved photo.
            if (this._flow.photoSource && this._flow.photoSource !== 'fresh-upload') {
              this._emit('photo_reused')
            }
            this._renderProcessing()
          })
          const swap = el('button', 'sai-o1uear1c__action sai-o1uear1c__action--ghost', {
            type: 'button',
            text: 'Upload a different photo',
          })
          swap.addEventListener('click', () => {
            this._flow.photoUrl = null
            this._flow.photoSource = null
            this._renderPhoto()
          })
          const del = el('button', 'sai-o1uear1c__delete-link', {
            type: 'button',
            text: 'Delete my saved photo',
          })
          del.addEventListener('click', () => this._deletePhoto())

          this._setStudioStep({
            stageNodes: [this._buildStageCard(this._flow.photoUrl)],
            step: 2,
            panelBody: [h2, lede, chip],
            panelFoot: [generate, swap, del],
          })
          return
        }

        // No saved photo — upload affordance. The requirement copy is
        // family-specific (full body for apparel, neckline for a necklace, a
        // close-up face for a lip shade).
        const h2 = el('h2', 'sai-o1uear1c__panel-h2', { text: 'Add your photo' })
        const lede = el('p', 'sai-o1uear1c__panel-lede', {
          text: familyPhotoCopy(this._family).lede,
        })
        const inputId = `sai-o1uear1c-file-${this._mutationHandle || 'x'}`
        const input = el('input', 'sai-o1uear1c__file-input', {
          type: 'file',
          id: inputId,
          accept: 'image/jpeg,image/png,image/webp',
        })
        input.addEventListener('change', () => {
          const file = input.files?.[0]
          if (file) this._uploadPhoto(file)
        })
        const dropzone = el('label', 'sai-o1uear1c__dropzone', { for: inputId })
        const dzIcon = el('span', 'sai-o1uear1c__dropzone-icon')
        dzIcon.appendChild(
          icon(['M7 18a4 4 0 0 1-.5-7.97A5.5 5.5 0 0 1 17 9.5a3.5 3.5 0 0 1 .5 6.96', 'M12 12.5v6', 'M9.5 15L12 12.5 14.5 15'], 22, 24),
        )
        dropzone.appendChild(dzIcon)
        dropzone.appendChild(el('span', 'sai-o1uear1c__dropzone-hint', { text: 'Drag & drop a photo here' }))

        const pickLabel = el('label', 'sai-o1uear1c__action sai-o1uear1c__action--primary', {
          for: inputId,
        })
        pickLabel.appendChild(icon(['M14.4 4l1.4 2.4H20a1 1 0 0 1 1 1V18a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7.4a1 1 0 0 1 1-1h3.8L9.2 4z', 'M12 13m-3 0a3 3 0 1 0 6 0a3 3 0 1 0 -6 0'], 18, 24))
        pickLabel.appendChild(el('span', null, { text: 'Choose a photo' }))

        this._setStudioStep({
          stageNodes: [this._buildStageCard(this._studioVisualUrl())],
          step: 2,
          panelBody: [h2, lede, input, dropzone],
          panelFoot: [pickLabel],
        })
      }

      // Build a proxy URL, tagging it with the per-browser visitor id so the
      // worker can rate-limit per shopper instead of per IP. The Shopify app
      // proxy strips cookies and custom headers, so the id must ride on the URL
      // query; the worker validates it server-side. Sourced from the SDK's
      // analytics id, falling back to the __spectrum_fp fingerprint cookie.
      _proxyUrl(path) {
        const cid =
          window.__spectrumAi?.analytics?.getDistinctId?.() ||
          document.cookie.match(/(?:^|;\s*)__spectrum_fp=([^;]+)/)?.[1] ||
          ''
        const url = `${this._proxyBase}${path}`
        if (!cid) return url
        return `${url}${url.includes('?') ? '&' : '?'}cid=${encodeURIComponent(cid)}`
      }

      // Upload a freshly-picked photo as a multipart POST to /vto/upload-url.
      // The worker stores it and returns a durable publicUrl.
      _uploadPhoto(file) {
        if (file.size > MAX_PHOTO_BYTES) {
          this._showPhotoError('That photo is too large. Please use an image under 10MB.')
          return
        }
        if (file.type && !/^image\//.test(file.type)) {
          this._showPhotoError('Please choose an image file.')
          return
        }

        // Preview the picked file immediately so the uploading state shows the
        // shopper's own photo (not a blank panel). Revoked once upload settles.
        try {
          this._flow.uploadPreviewUrl = URL.createObjectURL(file)
        } catch (_) {
          this._flow.uploadPreviewUrl = null
        }
        this._renderUploading()

        const form = new FormData()
        form.append('photo', file)

        // Pin the current session: a late upload resolution must not write
        // photoUrl / re-render onto a _flow replaced by a modal close+reopen,
        // nor onto a session where generation has since taken over.
        const serial = this._genSerial

        fetch(this._proxyUrl('/vto/upload-url'), {
          method: 'POST',
          credentials: 'same-origin',
          body: form,
        })
          .then((res) => res.json().then((json) => ({ res, json })))
          .then(({ res, json }) => {
            if (this._genSerial !== serial) return
            if (res.ok && json && json.success && json.data && json.data.publicUrl) {
              this._flow.photoUrl = json.data.publicUrl
              this._flow.photoR2Key = json.data.r2Key
              this._flow.photoSource = 'fresh-upload'
              this._emit('photo_uploaded')
              this._persistPhoto()
              this._renderPhoto()
            } else {
              const msg = json?.error || "We couldn't upload that photo. Please try again."
              this._showPhotoError(msg)
            }
          })
          .catch(() => {
            if (this._genSerial !== serial) return
            this._showPhotoError(
              "We couldn't reach the server. Please check your connection and try again.",
            )
          })
          .finally(() => {
            if (this._flow.uploadPreviewUrl) {
              URL.revokeObjectURL(this._flow.uploadPreviewUrl)
              this._flow.uploadPreviewUrl = null
            }
          })
      }

      // Re-render the photo step with an upload error notice.
      _showPhotoError(message) {
        this._flow.photoUrl = null
        this._flow.photoSource = null
        this._renderPhoto()
        const notice = el('div', 'sai-o1uear1c__notice sai-o1uear1c__notice--error', {
          text: message,
        })
        // Errors render at the top of the body, above the upload affordance.
        this._refs.body.insertBefore(notice, this._refs.body.firstChild)
      }

      // Uploading state: the shopper's picked photo fills the stage while a
      // compact spinner + label sit centered in the panel. No full-screen
      // takeover and no stranded footer button — the panel centers short states.
      _renderUploading() {
        const wrap = el('div', 'sai-o1uear1c__processing')
        wrap.appendChild(el('span', 'sai-spinner'))
        wrap.appendChild(el('div', 'sai-o1uear1c__processing-text', { text: 'Uploading your photo…' }))
        this._setStudioStep({
          stageNodes: [this._buildStageCard(this._flow.uploadPreviewUrl || this._studioVisualUrl())],
          step: 2,
          panelBody: [wrap],
        })
      }

      // Persist the uploaded photo: sessionStorage for everyone, plus the
      // customer metafield for logged-in shoppers (best-effort — a failed
      // metafield write must not break the current try-on).
      _persistPhoto() {
        if (!this._flow.photoUrl) return
        // The full VtoPhotoMetafield record — see packages/core/types/vto-photo.ts.
        // r2Key is load-bearing: DELETE /vto/photo reads it back to locate the R2
        // object, so a record without it leaves the photo undeletable server-side.
        // consentVersion / consentScope come from buildConsentRecord, which carries
        // the hand-mirrored core constants; every scope (including biometric) was
        // required to reach this step.
        const record = buildConsentRecord(this._flow.photoUrl, this._flow.photoR2Key)
        this._writePhotoSession(record)

        const customer = window.__spectrumAi?.customer || null
        if (!customer) return
        fetch(`${this._proxyBase}/customer/metafield`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            namespace: 'spectrum_customer',
            key: 'vto_photo',
            value: JSON.stringify(record),
          }),
        }).catch(() => {
          /* photo persistence is best-effort — try-on still proceeds */
        })
      }

      // Delete the saved photo: clear sessionStorage and call DELETE /vto/photo
      // (which removes the R2 object and the customer metafield record).
      // Drops the shopper back to the upload affordance.
      _deletePhoto() {
        this._clearPhotoSession()
        this._emit('photo_deleted')
        fetch(`${this._proxyBase}/vto/photo`, {
          method: 'DELETE',
          credentials: 'same-origin',
        }).catch(() => {
          /* DELETE is best-effort; the local session is already cleared */
        })
        this._flow.photoUrl = null
        this._flow.photoSource = null
        this._renderPhoto()
      }

      // Build the processing studio: dimmed photo + scan band on the stage; a
      // progress bar + status stepper in the panel. Returns the live nodes the
      // stepper interval advances. Shared by the looks + complete-look paths.
      _processingStudio(title) {
        const card = this._buildStageCard(this._flow.photoUrl, { dim: true, scan: true })

        const h2 = el('h2', 'sai-o1uear1c__panel-h2', { text: title })

        const bar = el('div', 'sai-o1uear1c__proc-bar')
        const fill = el('div', 'sai-o1uear1c__proc-fill')
        bar.appendChild(fill)

        const stepsWrap = el('div', 'sai-o1uear1c__proc-steps')
        const stepEls = PROCESSING_MESSAGES.map((label) => {
          const row = el('div', 'sai-o1uear1c__proc-step')
          row.appendChild(el('span', 'sai-o1uear1c__proc-step-dot'))
          row.appendChild(el('span', null, { text: label }))
          stepsWrap.appendChild(row)
          return row
        })

        const foot = el('div', 'sai-o1uear1c__proc-foot')
        foot.appendChild(icon(['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z', 'M12 7v5l3 2'], 13, 24))
        foot.appendChild(el('span', null, { text: 'About 30 seconds — you can keep this open.' }))

        this._setStudioStep({
          stageNodes: [card],
          step: 3,
          panelBody: [h2, bar, stepsWrap],
          panelFoot: [foot],
        })
        return { fill, stepEls }
      }

      // Advance the processing progress bar + stepper on a timer. Caps at 95%
      // until the real result lands (we don't know the true %); the result
      // render supersedes it. Uses the cancellable `_genCycle` slot so the
      // standard teardown clears it.
      _startProcStepper({ fill, stepEls }) {
        const start = Date.now()
        const dur = Math.min(GENERATE_TIMEOUT_MS || 30000, 30000)
        const apply = () => {
          const p = Math.min(95, ((Date.now() - start) / dur) * 100)
          fill.style.inlineSize = p + '%'
          const idx = p < 40 ? 0 : p < 80 ? 1 : 2
          for (let i = 0; i < stepEls.length; i++) {
            stepEls[i].className =
              'sai-o1uear1c__proc-step' +
              (i < idx
                ? ' sai-o1uear1c__proc-step--done'
                : i === idx
                  ? ' sai-o1uear1c__proc-step--active'
                  : '')
          }
        }
        apply()
        this._genCycle = window.setInterval(apply, 200)
      }

      // ── Step 3 — Processing. POST /vto/generate, await it under a 60s
      // AbortController ceiling, advance the progress stepper, then route to the
      // result step or a friendly error.
      _renderProcessing() {
        if (this._flow.generating) return
        this._setTitle('Creating your try-on')

        const refs = this._processingStudio('Creating your try-on')

        // Take ownership of the cancellable-work slot. `serial` pins this
        // request; if the modal closes (or another generation starts) the
        // serial moves and every callback below short-circuits.
        const { serial, signal } = this._beginGeneration()
        // Set `generating` after _beginGeneration — it runs _cancelGeneration,
        // which resets the flag to false. Setting it here keeps it true for
        // the whole in-flight request, which the scene strip's disabled state
        // and the re-entry guards depend on.
        this._flow.generating = true

        this._startProcStepper(refs)
        this._genTimeout = window.setTimeout(
          () => this._genController?.abort(),
          GENERATE_TIMEOUT_MS,
        )

        this._emit('generation_started', { scene_id: this._flow.activeSceneId })

        // Which garments composite depends on the result-step mode. With named
        // editorial looks, the active filmstrip tile drives it (solo → none, a
        // named look → its other products). Without named looks, fall back to
        // the flat FBT "Complete Look" selection. Either way a scene change
        // re-composites the same garments rather than reverting to single.
        const extraGarments =
          this._namedLooks().length > 0
            ? this._activeLookGarments()
            : selectCompleteLookGarments(this._completeLookItems(), this._flow.fbtSelectedIds)
        this._callGenerate(signal, { additionalGarments: extraGarments })
          .then((outcome) => {
            // Modal closed or superseded mid-flight — drop the result rather
            // than mutate _flow or render into a stale (or replaced) session.
            if (this._genSerial !== serial) return
            // Clear `generating` before rendering. _renderResult repaints the
            // scene strip, and each scene button bakes `generating` into its
            // `disabled` state at creation time. Once the scene list is cached
            // that repaint is synchronous, so a flag cleared only in the
            // .finally() below — one microtask later — leaves every scene
            // button stuck disabled until the modal is reopened.
            this._flow.generating = false
            if (outcome.ok) {
              this._flow.resultImageUrl = outcome.resultImageUrl
              this._flow.validationWarnings = outcome.validationWarnings || []
              for (const warning of this._flow.validationWarnings) {
                this._emit('validation_warning', { warning })
              }
              this._emit('generation_completed', { scene_id: this._flow.activeSceneId })
              this._emitEngagement('engagement_generated', 'success')
              this._renderResult()
            } else {
              this._emit('generation_failed', { reason: outcome.reason })
              this._renderError(outcome.message)
            }
          })
          .finally(() => {
            if (this._genSerial !== serial) return
            window.clearInterval(this._genCycle)
            window.clearTimeout(this._genTimeout)
            this._genCycle = null
            this._genTimeout = null
            this._genController = null
          })
      }

      // Issue the /vto/generate request for the current flow state. Body shape
      // (look-image fallback, the keep-background scene gate, garment metadata,
      // and `options.additionalGarments` for a "Complete Look") is owned
      // by buildGenerateBody; this method owns the request + the discriminated
      // outcome. Never rejects.
      _callGenerate(signal, options) {
        // Body assembly (look-image fallback, scene gate, garment metadata) lives
        // in the pure buildGenerateBody helper so it stays unit-testable; this
        // method owns only the request + outcome handling.
        const body = buildGenerateBody({
          payload: this._payload,
          photoUrl: this._flow.photoUrl,
          variant: this._flow.variant,
          dailyLimit: this._dailyLimit,
          activeScene: this._activeScene(),
          additionalGarments: options?.additionalGarments,
          family: this._family,
        })
        if (!body) {
          return Promise.resolve({
            ok: false,
            reason: 'missing_input',
            message: "We're missing the photo or product image needed to generate a try-on.",
          })
        }

        return fetch(this._proxyUrl('/vto/generate'), {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal,
        })
          .then((res) => res.json().then((json) => ({ res, json })))
          .then(({ res, json }) => {
            if (res.ok && json && json.success && json.data) {
              return {
                ok: true,
                resultImageUrl: json.data.resultImageUrl,
                validationWarnings: json.data.validationWarnings || [],
              }
            }
            // The server distinguishes rate-limit and content-moderation cases;
            // both get a non-retry-flavoured message.
            const code = json?.code || 'GENERATION_FAILED'
            let message =
              json?.error ||
              "We couldn't create your try-on right now. Please try a different photo."
            if (code === 'RATE_LIMITED') {
              message =
                json?.error || "You've reached today's try-on limit. Please come back tomorrow."
            }
            return { ok: false, reason: code, message }
          })
          .catch((err) => {
            const aborted = err && err.name === 'AbortError'
            return {
              ok: false,
              reason: aborted ? 'timeout' : 'network_error',
              message: aborted
                ? 'That took longer than expected. Please try again.'
                : "We couldn't reach the server. Please check your connection and try again.",
            }
          })
      }

      // ── Generation error state — a friendly message plus a path back to the
      // photo step ("try a different photo"). Uses the same two-pane studio
      // shell as every other step (stage image on the left, floating close, no
      // header bar) so the error doesn't collapse to a bare full-width panel.
      _renderError(message) {
        const wrap = el('div', 'sai-o1uear1c__error-state')
        wrap.appendChild(icon(['M9 6v4', 'M9 13h.01', 'M9 1.5L16.5 15h-15z'], 32))
        wrap.appendChild(el('div', 'sai-o1uear1c__processing-text', { text: message }))

        const retry = el('button', 'sai-o1uear1c__action sai-o1uear1c__action--primary', {
          type: 'button',
          text: 'Try a different photo',
        })
        retry.addEventListener('click', () => {
          this._flow.photoUrl = null
          this._flow.photoSource = null
          this._renderPhoto()
        })
        this._setStudioStep({
          stageNodes: [this._buildStageCard(this._flow.photoUrl || this._studioVisualUrl())],
          panelBody: [wrap],
          panelFoot: [retry],
        })
      }

      // ── Step 4 — Result. The generated image with AI badge + watermark and
      // disclaimer, a scene-changer strip, FBT recommendations, and add-to-cart.
      _renderResult() {
        // One result layout for every case — single product, solo "Just this",
        // and multi-product looks all render the same two-pane lightbox (try-on
        // image on the left, product list + variant selector on the right).
        this._renderLooksResult()
      }

      // ── Two-pane editorial-look result. Left: the try-on image + the
      // "Tap to wear" filmstrip (the looks the shopper can try). Right: a panel
      // listing the worn look's products (add each, or add the whole look).
      // Tapping a filmstrip tile re-runs generation and repaints this whole
      // layout with the newly-worn look.
      _renderLooksResult() {
        this._setTitle('Your try-on')
        const activeLook = this._activeLook()
        const isSolo = !activeLook || activeLook.id === SOLO_LOOK_ID
        const hasNamedLooks = this._namedLooks().length > 0
        const pieceCount = isSolo ? 1 : activeLook.products.length

        // LEFT — stage: try-on hero, plus the "Tap to wear" filmstrip only when
        // the merchant curated looks to switch between (a single product has
        // nothing to tap, so the strip is omitted).
        const stage = el('div', 'sai-o1uear1c__stage sai-o1uear1c__stage--result')
        stage.appendChild(this._buildResultFrame())
        if (hasNamedLooks) stage.appendChild(this._buildLooksFilmstrip())

        // RIGHT — panel: eyebrow + name, products, disclaimer, add footer.
        const panel = el('div', 'sai-o1uear1c__panel')
        const pbody = el('div', 'sai-o1uear1c__panel-body sai-o1uear1c__panel-body--result')

        if (this._flow.transientNotice) {
          pbody.appendChild(
            el('div', 'sai-o1uear1c__notice sai-o1uear1c__notice--warning', {
              text: this._flow.transientNotice,
            }),
          )
          this._flow.transientNotice = null
        }

        pbody.appendChild(
          el('div', 'sai-o1uear1c__result-eyebrow', { text: isSolo ? 'Your try-on' : 'The look' }),
        )
        // Solo (main product only) repeats its name + price in the product row
        // below, so a title + piece-count headrow would just duplicate it. Show
        // the headrow only for curated multi-piece looks.
        if (!isSolo) {
          const headrow = el('div', 'sai-o1uear1c__result-headrow')
          headrow.appendChild(el('h2', 'sai-o1uear1c__result-name', { text: activeLook.title }))
          headrow.appendChild(
            el('span', 'sai-o1uear1c__result-pieces', {
              text: `${pieceCount} ${pieceCount === 1 ? 'piece' : 'pieces'}`,
            }),
          )
          pbody.appendChild(headrow)
        }

        // Always show the product list with a per-row Add — solo/single → the one
        // current product (with its variant selector); named look → every piece.
        // Consistent with the look rows; the footer add stays the bulk action.
        pbody.appendChild(this._buildLookProductsList(activeLook))

        pbody.appendChild(
          el('p', 'sai-o1uear1c__disclaimer', {
            text: this._payload?.props?.disclaimerText || DEFAULT_DISCLAIMER_TEXT,
          }),
        )
        panel.appendChild(pbody)

        const foot = el('div', 'sai-o1uear1c__panel-foot sai-o1uear1c__panel-foot--row')
        if (!isSolo) {
          const addable = activeLook.products.filter((p) => p.variantId && p.available !== false)
          const addLook = el('button', 'sai-o1uear1c__action sai-o1uear1c__action--primary', {
            type: 'button',
            text: 'Add to bag',
            disabled: addable.length === 0,
          })
          addLook.addEventListener('click', () => this._addLookToCart(activeLook, addLook))
          foot.appendChild(addLook)
        } else {
          const addToCart = el('button', 'sai-o1uear1c__action sai-o1uear1c__action--primary', {
            type: 'button',
            text: 'Add to bag',
            disabled: !this._selectedVariantId(this._currentProductItem()),
          })
          addToCart.addEventListener('click', () => this._addToCart(addToCart))
          foot.appendChild(addToCart)
        }
        foot.appendChild(this._buildNewPhotoButton())
        panel.appendChild(foot)

        const lightbox = el('div', 'sai-o1uear1c__lightbox')
        lightbox.appendChild(stage)
        lightbox.appendChild(panel)
        lightbox.appendChild(this._buildFloatClose())

        this._completeLookBtn = null
        this._setStep([lightbox], [], false)
        this._dialog.classList.add('sai-o1uear1c__dialog--looks')
      }

      // The generated-image frame with the AI badge + brand watermark. Shared by
      // the single-column result and the two-pane stage.
      _buildResultFrame() {
        const frame = el('div', 'sai-o1uear1c__result-frame')
        // Makeup shows a labelled before/after (the shopper's own photo beside
        // the generated look) so the lip-shade change is judgeable; garment and
        // necklace show the single generated image. The before/after needs the
        // shopper photo — absent it (shouldn't happen post-generation), fall back
        // to the single image so the result never renders blank.
        if (this._family === 'makeup' && this._flow.photoUrl) {
          frame.classList.add('sai-o1uear1c__result-frame--ba')
          frame.appendChild(this._buildBeforeAfter())
        } else {
          frame.appendChild(
            el('img', 'sai-o1uear1c__result-image', {
              src: this._flow.resultImageUrl,
              alt: 'AI-generated try-on result',
            }),
          )
        }
        frame.appendChild(el('span', 'sai-o1uear1c__badge', { text: 'AI Generated' }))
        if (this._showBranding) {
          const brandLink = el('a', 'sai-o1uear1c__watermark', {
            href: 'https://getspectrum.ai',
            target: '_blank',
            rel: 'noopener noreferrer',
            'aria-label': 'Powered by Spectrum',
          })
          const logo = spectrumLogo()
          logo.setAttribute('class', 'sai-o1uear1c__watermark-logo')
          brandLink.appendChild(logo)
          frame.appendChild(brandLink)
        }
        // While an in-result regeneration runs (filmstrip look change / scene
        // change), the loading state sits on the image only — the previous
        // result stays underneath and the filmstrip + products panel remain
        // interactive-looking. The first generation has no image yet and uses
        // the full-screen processing step instead.
        if (this._flow.generating) {
          // A frosted dim (::before) under a label pill — no spinner, no sweep.
          const overlay = el('div', 'sai-o1uear1c__result-loading')
          overlay.appendChild(
            el('span', 'sai-o1uear1c__result-loading-text', { text: 'Generating your try-on' }),
          )
          frame.appendChild(overlay)
        }
        return frame
      }

      // The makeup before/after pair: the shopper's own photo beside the
      // generated result, each labelled, filling the result frame. A static
      // side-by-side (no slider, no toggle) is the robust default — there is no
      // interaction state to break, both halves read at the makeup family's face
      // crop, and the result is judgeable at a glance. The frame's AI badge +
      // watermark overlay this grid.
      _buildBeforeAfter() {
        const wrap = el('div', 'sai-o1uear1c__ba')

        const before = el('figure', 'sai-o1uear1c__ba-pane')
        before.appendChild(
          el('img', 'sai-o1uear1c__ba-img', {
            src: this._flow.photoUrl,
            alt: 'Your photo before try-on',
          }),
        )
        before.appendChild(el('figcaption', 'sai-o1uear1c__ba-label', { text: 'Before' }))

        const after = el('figure', 'sai-o1uear1c__ba-pane')
        after.appendChild(
          el('img', 'sai-o1uear1c__ba-img', {
            src: this._flow.resultImageUrl,
            alt: 'AI-generated try-on result',
          }),
        )
        after.appendChild(el('figcaption', 'sai-o1uear1c__ba-label', { text: 'After' }))

        wrap.appendChild(before)
        wrap.appendChild(after)
        return wrap
      }

      // Re-run generation from the result step (a filmstrip look change or a
      // scene change) without leaving the result layout: the newly-selected
      // look's products repaint immediately and a loading overlay sits on the
      // try-on image only. On failure the caller's `revert` restores the prior
      // selection so the image and the panel stay in agreement.
      _regenerate(revert) {
        if (this._flow.generating) return

        const { serial, signal } = this._beginGeneration()
        this._flow.generating = true
        // Repaint the result now: the panel/filmstrip reflect the new selection
        // and _buildResultFrame adds the in-image loading overlay.
        this._renderResult()

        const extraGarments =
          this._namedLooks().length > 0
            ? this._activeLookGarments()
            : selectCompleteLookGarments(this._completeLookItems(), this._flow.fbtSelectedIds)

        this._genTimeout = window.setTimeout(
          () => this._genController?.abort(),
          GENERATE_TIMEOUT_MS,
        )
        this._emit('generation_started', { scene_id: this._flow.activeSceneId })

        this._callGenerate(signal, { additionalGarments: extraGarments })
          .then((outcome) => {
            if (this._genSerial !== serial) return
            this._flow.generating = false
            if (outcome.ok) {
              this._flow.resultImageUrl = outcome.resultImageUrl
              this._flow.validationWarnings = outcome.validationWarnings || []
              this._emit('generation_completed', { scene_id: this._flow.activeSceneId })
              this._emitEngagement('engagement_generated', 'success')
            } else {
              this._emit('generation_failed', { reason: outcome.reason })
              if (typeof revert === 'function') revert()
              this._flow.transientNotice =
                outcome.message || "We couldn't update your try-on. Please try again."
            }
            this._renderResult()
          })
          .finally(() => {
            if (this._genSerial !== serial) return
            window.clearTimeout(this._genTimeout)
            this._genTimeout = null
            this._genController = null
          })
      }

      // The "New photo" restart button — drops the photo + result and returns to
      // the photo step. Shared by both result layouts.
      _buildNewPhotoButton() {
        const restart = el('button', 'sai-o1uear1c__action sai-o1uear1c__action--ghost', {
          type: 'button',
        })
        restart.appendChild(icon(['M20 11A8 8 0 1 0 18 16', 'M20 5v6h-6'], 16, 24))
        restart.appendChild(el('span', null, { text: 'New photo' }))
        restart.addEventListener('click', () => {
          this._flow.photoUrl = null
          this._flow.photoSource = null
          this._flow.resultImageUrl = null
          this._renderPhoto()
        })
        return restart
      }

      _activeScene() {
        const scenes = this._flow.scenes || []
        return scenes.find((s) => s.id === this._flow.activeSceneId) || null
      }

      // Fetch the scene list once, then render the thumbnail strip into the
      // given container. Selecting a non-active scene re-runs generation.
      _renderScenes(container) {
        // The scene changer is a garment-only surface; the single-product
        // families (jewellery, makeup) keep the shopper's own photo context and
        // never fetch or render a scene strip.
        if (this._family !== 'garment') {
          container.replaceChildren()
          return
        }
        const paint = () => {
          const scenes = this._flow.scenes || []
          if (scenes.length <= 1) {
            // Only the keep-background baseline resolved (the scene fetch
            // failed) — there is nothing to switch between, so no changer is
            // shown. On a successful fetch the list always also has Studio, so
            // the strip shows for every product.
            container.replaceChildren()
            return
          }
          container.replaceChildren()
          container.appendChild(
            el('div', 'sai-o1uear1c__section-title', { text: 'Change the scene' }),
          )
          const strip = el('ul', 'sai-o1uear1c__scene-strip')
          for (const scene of scenes) {
            const li = el('li')
            const btn = el('button', 'sai-o1uear1c__scene', {
              type: 'button',
              disabled: this._flow.generating,
            })
            btn.setAttribute(
              'aria-pressed',
              scene.id === this._flow.activeSceneId ? 'true' : 'false',
            )
            btn.appendChild(
              el('img', 'sai-o1uear1c__scene-thumb', {
                src: scene.thumbnailUrl || scene.imageUrl || '',
                alt: '',
                loading: 'lazy',
              }),
            )
            btn.appendChild(el('span', 'sai-o1uear1c__scene-name', { text: scene.name }))
            btn.addEventListener('click', () => {
              if (this._flow.generating || scene.id === this._flow.activeSceneId) return
              const prev = this._flow.activeSceneId
              this._flow.activeSceneId = scene.id
              this._emit('scene_changed', { scene_id: scene.id })
              this._regenerate(() => {
                this._flow.activeSceneId = prev
              })
            })
            li.appendChild(btn)
            strip.appendChild(li)
          }
          container.appendChild(strip)
        }

        if (this._flow.scenes) {
          paint()
          return
        }
        // Pin the current session: a late scenes resolution must not write
        // _flow.scenes / paint into a _flow replaced by a modal close+reopen,
        // nor into a result container superseded by a later generation.
        const serial = this._genSerial
        fetch(`${this._proxyBase}/vto/scenes`, { credentials: 'same-origin' })
          .then((res) => res.json())
          .then((json) => {
            if (this._genSerial !== serial) return
            const serverScenes =
              json?.success && json.data && Array.isArray(json.data.scenes) ? json.data.scenes : []
            // Prepend the synthetic keep-background baseline so "your photo" is
            // always the first, default option ahead of Studio and brand scenes.
            this._flow.scenes = [buildKeepBackgroundScene(this._flow.photoUrl), ...serverScenes]
            paint()
          })
          .catch(() => {
            // Scene fetch failure is non-fatal — the result still stands on the
            // shopper's own background; only the keep-background option remains.
            if (this._genSerial !== serial) return
            this._flow.scenes = [buildKeepBackgroundScene(this._flow.photoUrl)]
            paint()
          })
      }

      // Build the FBT recommendations grid. Each card carries Add-to-Cart and
      // a "Try On" toggle that adds the item to the Complete Look set.
      _buildFbtSection(items) {
        const section = el('div')
        section.appendChild(el('div', 'sai-o1uear1c__section-title', { text: 'Complete the look' }))
        const grid = el('ul', 'sai-o1uear1c__fbt-grid')
        for (const item of items) {
          const li = el('li', 'sai-o1uear1c__fbt-card')
          if (item.imageUrl) {
            li.appendChild(
              el('img', 'sai-o1uear1c__fbt-thumb', {
                src: item.imageUrl,
                alt: '',
                loading: 'lazy',
              }),
            )
          }
          li.appendChild(el('div', 'sai-o1uear1c__fbt-name', { text: item.title }))
          if (item.price != null) {
            li.appendChild(el('div', 'sai-o1uear1c__fbt-price', { text: String(item.price) }))
          }

          const actions = el('div', 'sai-o1uear1c__fbt-actions')
          const add = el('button', 'sai-o1uear1c__fbt-btn', {
            type: 'button',
            text: 'Add',
            disabled: !item.variantId,
          })
          add.addEventListener('click', () => this._addFbtToCart(item, add))
          actions.appendChild(add)

          // "Try on" is gated on a usable garment image — without one the
          // item contributes nothing to a Complete Look composite, so it
          // cannot be toggled into the selection set.
          const tryOn = el('button', 'sai-o1uear1c__fbt-btn', {
            type: 'button',
            text: 'Try on',
            disabled: !item.imageUrl,
          })
          const itemKey = fbtItemKey(item)
          tryOn.setAttribute(
            'aria-pressed',
            this._flow.fbtSelectedIds.has(itemKey) ? 'true' : 'false',
          )
          tryOn.addEventListener('click', () => {
            const selected = this._flow.fbtSelectedIds
            if (selected.has(itemKey)) {
              selected.delete(itemKey)
              tryOn.setAttribute('aria-pressed', 'false')
            } else {
              if (selected.size >= MAX_COMPLETE_LOOK_ITEMS) return
              selected.add(itemKey)
              tryOn.setAttribute('aria-pressed', 'true')
              this._emit('fbt_item_selected', { fbt_product_id: item.id })
            }
            this._syncCompleteLook()
          })
          actions.appendChild(tryOn)

          li.appendChild(actions)
          grid.appendChild(li)
        }
        section.appendChild(grid)
        return section
      }

      // Build the "Tap to wear" filmstrip: the solo tile plus one tile per
      // named editorial look. Tapping a non-active tile wears that look —
      // it re-runs generation compositing the look's garments and repaints the
      // result with the look's product list. Disabled while a generation runs.
      _buildLooksFilmstrip() {
        const section = el('div')
        section.appendChild(el('div', 'sai-o1uear1c__section-title', { text: 'Tap to wear' }))
        const strip = el('ul', 'sai-o1uear1c__looks-strip')
        for (const look of this._filmstripLooks()) {
          const li = el('li')
          const btn = el('button', 'sai-o1uear1c__look', {
            type: 'button',
            disabled: this._flow.generating,
          })
          btn.setAttribute('aria-pressed', look.id === this._flow.activeLookId ? 'true' : 'false')

          const thumbWrap = el('div', 'sai-o1uear1c__look-thumb-wrap')
          // A look is a styled outfit. Prefer the look's own styled hero image
          // when the merchant has one; otherwise build a collage of the look's
          // actual product images so the tile always matches the items it
          // contains. Solo (one product) shows that single product.
          const lookImgs = look.products.map((pr) => pr.imageUrl).filter(Boolean)
          if (look.heroImage) {
            thumbWrap.appendChild(
              el('img', 'sai-o1uear1c__look-thumb', { src: look.heroImage, alt: '', loading: 'lazy' }),
            )
          } else if (look.id === SOLO_LOOK_ID || lookImgs.length <= 1) {
            if (lookImgs[0]) {
              thumbWrap.appendChild(
                el('img', 'sai-o1uear1c__look-thumb', { src: lookImgs[0], alt: '', loading: 'lazy' }),
              )
            }
          } else {
            const collage = el('div', 'sai-o1uear1c__look-collage')
            for (const src of lookImgs.slice(0, 4)) {
              collage.appendChild(
                el('img', 'sai-o1uear1c__look-collage-img', { src, alt: '', loading: 'lazy' }),
              )
            }
            thumbWrap.appendChild(collage)
          }
          // Product-count badge on multi-product named looks (matches the
          // merchant's curated outfit size).
          if (look.id !== SOLO_LOOK_ID && look.products.length > 1) {
            thumbWrap.appendChild(
              el('span', 'sai-o1uear1c__look-count', { text: String(look.products.length) }),
            )
          }
          btn.appendChild(thumbWrap)
          btn.appendChild(el('span', 'sai-o1uear1c__look-name', { text: look.title }))

          btn.addEventListener('click', () => {
            if (this._flow.generating || look.id === this._flow.activeLookId) return
            const prev = this._flow.activeLookId
            this._flow.activeLookId = look.id
            this._emit('look_selected', { look_id: look.id })
            this._regenerate(() => {
              this._flow.activeLookId = prev
            })
          })
          li.appendChild(btn)
          strip.appendChild(li)
        }
        section.appendChild(strip)
        return section
      }

      // Build the active look's product list — one row per product (thumb,
      // role, name, price, Add). Shown only for a named look (solo is covered by
      // the footer add-to-bag).
      // The active look's products, one row each (thumb · role/name/price ·
      // size select + Add). The eyebrow + look name live in the panel header, so
      // this returns just the row list.
      // `withAdd` controls the per-row Add button. A named look shows it (add
      // each piece individually alongside the footer "Add look to bag"). The
      // solo single-product row hides it — the footer "Add to bag" is the single
      // primary action, so a per-row Add would be redundant.
      _buildLookProductsList(look, { withAdd = true } = {}) {
        const list = el('ul', 'sai-o1uear1c__lookrow-list')
        for (const item of look.products) {
          const li = el('li', 'sai-o1uear1c__lookrow')
          if (item.imageUrl) {
            li.appendChild(
              el('img', 'sai-o1uear1c__lookrow-thumb', { src: item.imageUrl, alt: '', loading: 'lazy' }),
            )
          }
          const info = el('div', 'sai-o1uear1c__lookrow-info')
          if (item.role) {
            info.appendChild(el('div', 'sai-o1uear1c__lookrow-role', { text: item.role }))
          }
          info.appendChild(el('div', 'sai-o1uear1c__lookrow-name', { text: item.title }))
          if (item.price != null) {
            info.appendChild(el('div', 'sai-o1uear1c__lookrow-price', { text: String(item.price) }))
          }
          li.appendChild(info)

          const controls = el('div', 'sai-o1uear1c__lookrow-controls')
          let add
          // Size picker — only when the product has more than one variant. The
          // chosen variant is remembered per product and used by both the
          // per-item Add and "Add look to bag".
          if (Array.isArray(item.variants) && item.variants.length > 1) {
            const selectedId = this._selectedVariantId(item)
            const wrap = el('div', 'sai-o1uear1c__select-wrap')
            const select = el('select', 'sai-o1uear1c__lookrow-variant', {
              'aria-label': `Choose a size for ${item.title}`,
            })
            for (const v of item.variants) {
              const opt = el('option', null, {
                value: v.id,
                text: v.available ? v.title : `${v.title} — sold out`,
              })
              opt.disabled = !v.available
              if (v.id === selectedId) opt.selected = true
              select.appendChild(opt)
            }
            select.addEventListener('change', () => {
              if (!this._flow.lookVariants) this._flow.lookVariants = {}
              this._flow.lookVariants[String(item.id)] = select.value
              if (add) add.disabled = !select.value
            })
            wrap.appendChild(select)
            const chev = icon(['M6 9l6 6 6-6'], 14, 24)
            chev.setAttribute('class', 'sai-o1uear1c__select-chevron')
            wrap.appendChild(chev)
            controls.appendChild(wrap)
          }

          if (withAdd) {
            add = el('button', 'sai-o1uear1c__lookrow-add', { type: 'button', text: 'Add' })
            add.disabled = !this._selectedVariantId(item) || item.available === false
            add.addEventListener('click', () => this._addLookProductToCart(item, add))
            controls.appendChild(add)
          }

          li.appendChild(controls)
          list.appendChild(li)
        }
        return list
      }

      // Resolve the variant a look product will add to cart: the shopper's
      // explicit per-product pick, else the current product's PDP-selected
      // variant, else the product's default, else the first available variant.
      _selectedVariantId(item) {
        const key = String(item.id)
        const chosen = this._flow.lookVariants && this._flow.lookVariants[key]
        if (chosen) return chosen
        if (item.isCurrent && this._flow.variant) return String(this._flow.variant.id)
        if (item.variantId) return item.variantId
        const variants = Array.isArray(item.variants) ? item.variants : []
        const fallback = variants.find((v) => v.available) || variants[0]
        return fallback ? fallback.id : null
      }

      // Add a single look product's variant to the cart, then open the theme
      // cart UI and close the modal (see _addToCart for why both).
      _addLookProductToCart(item, button) {
        const variantId = this._selectedVariantId(item)
        const cart = window.Spectrum?.cart
        if (!variantId || !cart || typeof cart.addAndOpen !== 'function') return
        button.disabled = true
        cart
          .addAndOpen({ id: variantId, quantity: 1 })
          .then(() => {
            this._emit('look_product_add_to_cart', {
              product_id: item.id,
              variant_id: variantId,
              quantity: 1,
            })
            this._close()
          })
          .catch(() => {
            button.disabled = false
            button.textContent = 'Add'
          })
      }

      // Add every available product in the active look to the cart in one call
      // (cart.addAndOpen accepts an array), then open the cart UI and close the
      // modal.
      _addLookToCart(look, button) {
        const cart = window.Spectrum?.cart
        if (!cart || typeof cart.addAndOpen !== 'function') return
        const items = look.products
          .map((p) => ({ p, variantId: this._selectedVariantId(p) }))
          .filter(({ p, variantId }) => variantId && p.available !== false)
          .map(({ variantId }) => ({ id: variantId, quantity: 1 }))
        if (items.length === 0) return
        button.disabled = true
        cart
          .addAndOpen(items)
          .then(() => {
            this._emit('look_add_to_cart', { look_id: look.id, item_count: items.length })
            this._close()
          })
          .catch(() => {
            button.disabled = false
          })
      }

      // Show the "Try Complete Look" button only when ≥1 FBT item is selected.
      _syncCompleteLook() {
        if (!this._completeLookBtn) return
        this._completeLookBtn.hidden = this._flow.fbtSelectedIds.size === 0
      }

      // Add the tried-on garment's variant to the cart, then surface the
      // theme's cart UI (section refresh + drawer/notification open + cart
      // events). This snippet ships its own ATC button outside the theme's
      // product form, so it uses `addAndOpen` rather than the bare `add` —
      // otherwise the item lands in the cart silently with no visible
      // confirmation. Both live on the same SDK; the guard tracks the method
      // actually called.
      //
      // On success the try-on modal is closed. It is a native <dialog> opened
      // with showModal(), so it sits in the browser top layer above the theme
      // cart drawer that addAndOpen just opened — left open, it would hide the
      // drawer behind it.
      _addToCart(button) {
        // Honour the size chosen in the product row's selector (falls back to the
        // PDP-selected / default variant via _selectedVariantId).
        const variantId = this._selectedVariantId(this._currentProductItem())
        const cart = window.Spectrum?.cart
        if (!variantId || !cart || typeof cart.addAndOpen !== 'function') return
        button.disabled = true
        cart
          .addAndOpen({ id: variantId, quantity: 1 })
          .then(() => {
            this._emit('add_to_cart', { variant_id: variantId, quantity: 1 })
            this._emitEngagement('engagement_add_to_cart', 'added')
            this._close()
          })
          .catch(() => {
            button.disabled = false
            button.textContent = 'Add to bag'
          })
      }

      // Add an FBT recommendation's variant to the cart, then open the theme
      // cart UI and close the try-on modal (see `_addToCart` for why both).
      _addFbtToCart(item, button) {
        const cart = window.Spectrum?.cart
        if (!item.variantId || !cart || typeof cart.addAndOpen !== 'function') return
        button.disabled = true
        cart
          .addAndOpen({ id: item.variantId, quantity: 1 })
          .then(() => {
            this._emit('fbt_add_to_cart', {
              fbt_product_id: item.id,
              fbt_variant_id: item.variantId,
              quantity: 1,
            })
            this._close()
          })
          .catch(() => {
            button.disabled = false
            button.textContent = 'Add'
          })
      }

      // ── "Try Complete Look" — composite the main garment plus the selected
      // FBT garments onto the shopper in one generation.
      //
      // The selected FBT items live in `this._flow.fbtSelectedIds`; their
      // garment images are resolved here and sent as `additionalGarments` (id
      // tuples) plus the index-aligned `additionalGarmentImageUrls` fallback.
      // The "Try on" toggle is gated on a usable image so only items that can
      // contribute to the composite reach the selection set; if a selection
      // nonetheless resolves to zero usable garments, the shopper sees a
      // visible notice rather than a dead click. On failure the shopper keeps
      // their existing single-garment result rather than hitting a dead end:
      // the result step is re-rendered with a one-shot notice. The single
      // Complete Look generation consumes one rate-limit slot like any other
      // generation.
      _tryCompleteLook() {
        if (this._flow.generating) return

        const fbtItems = this._completeLookItems()
        const extraGarments = selectCompleteLookGarments(fbtItems, this._flow.fbtSelectedIds)
        if (extraGarments.length === 0) {
          // A non-empty selection that resolves to no usable garment images
          // (e.g. the FBT payload lost the images since render) — tell the
          // shopper instead of consuming a generation on nothing. An empty
          // selection can't reach here (the button is hidden), so silence is
          // only correct when nothing was selected at all.
          if (this._flow.fbtSelectedIds.size > 0) {
            this._flow.transientNotice =
              "Those items can't be added to your try-on right now. Please pick different ones."
            this._renderResult()
          }
          return
        }

        this._setTitle('Creating your complete look')

        const refs = this._processingStudio('Creating your look')

        // Take ownership of the cancellable-work slot. `serial` pins this
        // request; a modal close (or another generation) moves the serial and
        // every callback below short-circuits.
        const { serial, signal } = this._beginGeneration()
        // Set `generating` after _beginGeneration (it runs _cancelGeneration,
        // which resets the flag) so it stays true for the whole request.
        this._flow.generating = true

        this._startProcStepper(refs)
        this._genTimeout = window.setTimeout(
          () => this._genController?.abort(),
          GENERATE_TIMEOUT_MS,
        )

        // garment_count is the total composited — main garment plus extras.
        const garmentCount = 1 + extraGarments.length
        this._emit('complete_look_started', { garment_count: garmentCount })

        this._callGenerate(signal, { additionalGarments: extraGarments })
          .then((outcome) => {
            // Modal closed or superseded mid-flight — drop the result.
            if (this._genSerial !== serial) return
            // Clear `generating` before _renderResult repaints the scene strip
            // — see _renderProcessing. Both branches below render the result
            // step, so clearing it once up front covers them.
            this._flow.generating = false
            if (outcome.ok) {
              this._flow.resultImageUrl = outcome.resultImageUrl
              this._flow.validationWarnings = outcome.validationWarnings || []
              this._emit('complete_look_generated', { garment_count: garmentCount })
              this._renderResult()
            } else {
              // Partial failure — keep the shopper's existing result. Re-render
              // the result step with a one-shot notice instead of the hard
              // error screen, which would discard their place.
              this._emit('complete_look_failed', { reason: outcome.reason })
              this._flow.transientNotice =
                "We couldn't create the complete look — showing your previous try-on instead."
              this._renderResult()
            }
          })
          .finally(() => {
            if (this._genSerial !== serial) return
            window.clearInterval(this._genCycle)
            window.clearTimeout(this._genTimeout)
            this._genCycle = null
            this._genTimeout = null
            this._genController = null
          })
      }

      // ── Uploading / generation states share the processing chrome; nothing
      // else to expose.
    }
    customElements.define(TAG, SaiVirtualTryOn)
  }

  function bindAllContainers() {
    const api = window.__spectrumAi?.snippet
    const containers = document.querySelectorAll(
      `[data-spectrum-instance-id][data-spectrum-snippet-id="${SNIPPET_ID}"]`,
    )

    if (!api?.bind) {
      // No-bind fallback: the SSR'd CTA is wired by connectedCallback with a
      // noop track handle, so clicks still open the modal and analytics are
      // silently skipped. Nothing more to do here.
      return
    }

    for (const node of containers) {
      const handles = api.bind(node, () => {
        // Variant resolution has no SSR-visible effect for this snippet — the
        // CTA presentation is baked per-instance by the wrapper. The callback
        // is intentionally a no-op; binding still runs for the `track` handle.
      })
      const root = node.querySelector(TAG)
      if (root && handles?.track && typeof root.setAnalytics === 'function') {
        root.setAnalytics(handles.track)
      }
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindAllContainers, { once: true })
  } else {
    bindAllContainers()
  }
})()
