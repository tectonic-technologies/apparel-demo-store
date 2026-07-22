/**
 * Product Gallery V3 — spotlight + horizontal thumbnail strip runtime.
 *
 * Desktop: spotlight on top + horizontal thumb strip below with chevron nav.
 * Mobile: scroll-snap swipe + chevron nav + dot/stepper indicators.
 * Lightbox: spotlight + thumbnail strip + prev/next nav + zoom controls.
 * Variant change: URL ?variant= observation.
 *
 * Analytics events:
 *   product_gallery:image_view       — navigate to new index
 *   product_gallery:lightbox_open    — lightbox opened
 *   product_gallery:lightbox_close   — lightbox closed (with dwell_ms)
 *   product_gallery:video_play       — video play
 *   product_gallery:video_pause      — video pause
 *   product_gallery:filter_apply     — filter applied
 */
;(() => {
  if (window.__sai_ty137c1l_initialized__) return
  window.__sai_ty137c1l_initialized__ = true

  const SNIPPET_ID = 'ty137c1l'
  const TAG = 'sai-ty137c1l'
  const FEATURE_SLUG = 'product_gallery'
  const SLOT_SLUG = 'gallery'
  // Intentionally global (not product-scoped): filter selections persist across
  // PDP navigations so the user's preference carries to the next product.
  // _loadFilters validates stored values against each product's filterTags.
  // Single-instance-per-page assumption: only one PDP gallery renders per page.
  const FILTER_STORAGE_KEY = `spectrum:${FEATURE_SLUG}:filters`

  function readSnippetPool(node) {
    for (let i = 0; i < node.children.length; i++) {
      const child = node.children[i]
      if (child.tagName === 'SCRIPT' && child.hasAttribute('data-spectrum-snippet-pool')) {
        const text = child.textContent
        if (!text) return {}
        try {
          return JSON.parse(text)
        } catch (_) {
          return {}
        }
      }
    }
    return {}
  }

  function noopTrack() {}

  function safeTrack(fn) {
    return (...args) => {
      try {
        fn(...args)
      } catch (_) {
        /* analytics must never break the gallery */
      }
    }
  }

  function resolveSlot(pool, variantId) {
    const vs = pool.variantSlots || {}
    const ps = pool.productSlots || {}
    const vid = variantId != null ? String(variantId) : null
    const vSlots = vid ? vs[vid] : null
    if (vSlots?.[SLOT_SLUG]) return vSlots[SLOT_SLUG]
    if (ps[SLOT_SLUG]) return ps[SLOT_SLUG]
    return null
  }

  function resolveSlotVariant(slot) {
    if (!slot?.variants || !slot.variants.length) return null
    // Personalisation: return the first targeted variant whose targeting tree
    // matches the live shopper (author priority order), else the untargeted
    // default. Targeting is evaluated with the storefront SDK engine
    // (window.__spectrumAi.targeting) — the same one that resolves experience
    // and snippet-instance targeting. session.utm_source / cart.* are only
    // knowable client-side, so this runs here, never in Liquid; the default is
    // SSR-rendered and swapped once the engine has resolved.
    const engine = window.__spectrumAi && window.__spectrumAi.targeting
    let fallback = null
    for (const v of slot.variants) {
      if (!v.targeting) {
        if (!fallback) fallback = v
        continue
      }
      if (engine && typeof engine.evaluate === 'function') {
        try {
          const result = engine.evaluate(v.targeting)
          const matched = Array.isArray(result) ? result[0] : result
          if (matched) return v
        } catch (_err) {
          // A malformed tree or engine fault must never blank the gallery —
          // skip this variant and fall through to the default.
        }
      }
    }
    return fallback || slot.variants[0] || null
  }

  function resolveAssets(pool, handles) {
    const assets = pool.assets || {}
    const resolved = []
    for (const handle of handles) {
      const asset = assets[handle]
      if (asset?.url) {
        resolved.push(Object.assign({}, asset, { handle }))
      }
    }
    return resolved
  }

  /**
   * Build a map of dimension -> entries from the filterTags declaration on a slot.
   * Handles both old format (string[]) and new format ({value, displayConfig}[]).
   * Returns { dim: [{ value, displayConfig }, ...] } with only dims that have 1+ values.
   */
  function buildFilterTags(filterTags) {
    if (!filterTags || typeof filterTags !== 'object') return {}
    const result = {}
    for (const [dim, values] of Object.entries(filterTags)) {
      if (Array.isArray(values) && values.length >= 1) {
        result[dim] = values.map((v) =>
          typeof v === 'string' ? { value: v, displayConfig: null } : v,
        )
      }
    }
    return result
  }

  /**
   * Filter a list of resolved assets by a set of active filters.
   * Returns a new array containing only assets whose tags match all active filter dimensions.
   */
  function filterAssets(assets, activeFilters) {
    if (!activeFilters || Object.keys(activeFilters).length === 0) return assets.slice()
    return assets.filter((asset) => {
      const tags = asset.tags || {}
      return Object.entries(activeFilters).every(([dim, val]) => tags[dim] === val)
    })
  }

  // ── DOM helpers ──

  // SVG icon strings for video controls
  const ICON_PLAY =
    '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>'
  const ICON_PAUSE =
    '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>'
  const ICON_MUTED =
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>'
  const ICON_UNMUTED =
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 010 14.14M15.54 8.46a5 5 0 010 7.08"/></svg>'

  function createSpotlightMedia(asset, eager, props) {
    if (asset.type === 'video') {
      const video = document.createElement('video')
      video.className = 'sai-ty137c1l__spotlight-media'
      video.src = asset.url
      video.autoplay = props ? props.autoplayVideo !== false : true
      video.muted = true
      video.loop = true
      video.playsInline = true
      video.controls = false
      if (asset.thumb) video.poster = asset.thumb
      return video
    }
    const img = document.createElement('img')
    img.className = 'sai-ty137c1l__spotlight-media'
    img.src = asset.url
    img.alt = asset.alt || ''
    img.loading = eager ? 'eager' : 'lazy'
    if (asset.width) img.width = asset.width
    if (asset.height) img.height = asset.height
    return img
  }

  /**
   * Create custom play/pause overlay button for a video container.
   * Returns { playBtn, muteBtn } elements to be appended to the container.
   */
  function createVideoControls(video) {
    const playBtn = document.createElement('button')
    playBtn.className = 'sai-ty137c1l__video-play'
    playBtn.type = 'button'
    playBtn.setAttribute('aria-label', 'Play/Pause')
    playBtn.innerHTML = ICON_PAUSE
    /* Show play button initially only if video is paused */
    if (video.paused) {
      playBtn.innerHTML = ICON_PLAY
      playBtn.setAttribute('data-visible', '')
    }

    const muteBtn = document.createElement('button')
    muteBtn.className = 'sai-ty137c1l__video-mute'
    muteBtn.type = 'button'
    muteBtn.setAttribute('aria-label', 'Mute/Unmute')
    muteBtn.innerHTML = video.muted ? ICON_MUTED : ICON_UNMUTED
    muteBtn.setAttribute('data-visible', '')

    playBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      if (video.paused) {
        video.play()
      } else {
        video.pause()
      }
    })

    muteBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      video.muted = !video.muted
      muteBtn.innerHTML = video.muted ? ICON_MUTED : ICON_UNMUTED
    })

    video.addEventListener('play', () => {
      playBtn.innerHTML = ICON_PAUSE
      playBtn.removeAttribute('data-visible')
    })
    video.addEventListener('pause', () => {
      playBtn.innerHTML = ICON_PLAY
      playBtn.setAttribute('data-visible', '')
    })

    return { playBtn, muteBtn }
  }

  function createThumbEl(asset, index, isActive) {
    const btn = document.createElement('button')
    btn.className = `sai-ty137c1l__thumb${isActive ? ' sai-ty137c1l__thumb--active' : ''}`
    btn.type = 'button'
    btn.dataset.index = index
    btn.dataset.handle = asset.handle
    btn.setAttribute('aria-label', `View image ${index + 1}`)

    const thumbSrc = asset.thumb || asset.url
    const img = document.createElement('img')
    img.className = 'sai-ty137c1l__thumb-media'
    img.src = thumbSrc
    img.alt = asset.alt || ''
    img.loading = 'lazy'
    btn.appendChild(img)

    if (asset.type === 'video') {
      const play = document.createElement('span')
      play.className = 'sai-ty137c1l__thumb-play'
      play.setAttribute('aria-hidden', 'true')
      play.innerHTML =
        '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>'
      btn.appendChild(play)
    }
    return btn
  }

  if (!customElements.get(TAG)) {
    class SaiProductGalleryV3 extends HTMLElement {
      connectedCallback() {
        if (this._initialized) return
        this._initialized = true
        this._track = noopTrack
        this._activeIndex = 0
        this._assets = []
        this._allAssets = []
        this._pool = null
        this._currentVariantId = this.dataset.variantId || null
        this._activeFilters = {}
        this._pendingFilters = {}
        this._filterTags = {}

        this._props = {
          autoplay: this.dataset.autoplay === 'true',
          autoplayInterval: Number.parseInt(this.dataset.autoplayInterval, 10) || 5,
          swipeEnabled: this.dataset.swipeEnabled !== 'false',
          autoplayVideo: this.dataset.autoplayVideo !== 'false',
          showPlayPause: this.dataset.showPlayPause !== 'false',
          showLightboxThumbs: this.dataset.showLightboxThumbs !== 'false',
          showZoomControls: this.dataset.showZoomControls !== 'false',
          pinchToZoom: this.dataset.pinchToZoom !== 'false',
          spotlightObjectFit: this.dataset.spotlightObjectFit || 'contain',
          thumbnailObjectFit: this.dataset.thumbnailObjectFit || 'cover',
          lightboxObjectFit: this.dataset.lightboxObjectFit || 'contain',
          filterCtaLabel: this.dataset.filterCtaLabel || 'Select model',
        }

        this._selfBootstrap()
        this._initNav()
        this._initMobileSwipe()
        this._initThumbs()
        this._initLightbox()
        this._initFilters()
        this._initVariantObserver()
        this._applyProps()
      }

      disconnectedCallback() {
        this._teardownVariantObserver()
        if (this._autoplayTimer) clearInterval(this._autoplayTimer)
        this._removeFilterFromBody()
      }

      _applyProps() {
        if (!this._props.swipeEnabled) {
          const track = this.querySelector('.sai-ty137c1l__mobile-track')
          if (track) {
            track.style.overflowX = 'hidden'
            track.style.touchAction = 'pan-y'
          }
        }
        if (!this._props.pinchToZoom) {
          const mobileWrap = this.querySelector('.sai-ty137c1l__mobile-spotlight-wrap')
          if (mobileWrap) mobileWrap.style.touchAction = 'pan-y'
        }
        if (!this._props.showZoomControls) {
          const zoomBtns = this.querySelectorAll('.sai-ty137c1l__zoom-trigger')
          for (const btn of zoomBtns) btn.style.display = 'none'
        }
        if (this._props.spotlightObjectFit) {
          this.style.setProperty('--sai-ty137c1l-spotlight-fit', this._props.spotlightObjectFit)
        }
        if (this._props.thumbnailObjectFit) {
          this.style.setProperty('--sai-ty137c1l-thumb-fit', this._props.thumbnailObjectFit)
        }
        if (this._props.lightboxObjectFit) {
          this.style.setProperty('--sai-ty137c1l-lightbox-fit', this._props.lightboxObjectFit)
        }
      }

      setAnalytics(track) {
        this._track = typeof track === 'function' ? safeTrack(track) : noopTrack
      }

      _selfBootstrap() {
        const container = this.parentElement
        if (!container) return
        const pool = readSnippetPool(container)
        if (pool?.assets) this._applyPool(pool)
      }

      _applyPool(pool) {
        this._pool = pool
        const slot = resolveSlot(pool, this._currentVariantId)
        const slotVariant = resolveSlotVariant(slot)
        if (slotVariant?.assets) {
          this._allAssets = resolveAssets(pool, slotVariant.assets)
        }
        this._filterTags = buildFilterTags(slot?.filterTags)
        this._activeFilters = this._loadFilters()
        this._pendingFilters = {}
        this._applyFilters()
        this._renderFilterControls()
      }

      // ── Filters ──

      _initFilters() {
        this._filterDialog = this.querySelector('.sai-ty137c1l__filter-dialog')
        this._filterPanel = this._filterDialog?.querySelector('.sai-ty137c1l__filter-panel')

        if (this._filterDialog) {
          this._filterDialog.addEventListener('click', (e) => {
            if (e.target === this._filterDialog) this._closeFilterPanel()
          })
        }

        this.addEventListener('click', (e) => {
          if (e.target.closest('[data-action="toggle-filters"]')) {
            this._openFilterPanel()
            this._track(`${FEATURE_SLUG}:filter_open`, {})
          }
        })

        document.addEventListener('click', (e) => {
          if (e.target.closest('[data-action="close-filters"]')) {
            this._closeFilterPanel()
          }
          if (e.target.closest('[data-action="apply-filters"]')) {
            this._applyPendingFilters()
          }
          if (e.target.closest('[data-action="clear-filters"]')) {
            this._pendingFilters = {}
            this._activeFilters = {}
            this._applyFilters()
            this._saveFilters()
            this._closeFilterPanel()
            this._renderFilterControls()
            this._updateClearButton()
            this._track(`${FEATURE_SLUG}:filter_clear`, {})
          }

          const item = e.target.closest('.sai-ty137c1l__filter-card, .sai-ty137c1l__filter-pill')
          if (item) {
            const dim = item.dataset.filterDim
            const val = item.dataset.filterVal
            if (!dim) return
            if (this._pendingFilters[dim] === val) {
              delete this._pendingFilters[dim]
            } else {
              this._pendingFilters[dim] = val
            }
            this._updateFilterItems()
            this._updateClearButton()
          }
        })
      }

      _renderFilterControls() {
        const filtersContainer = this.querySelector('.sai-ty137c1l__filters')
        const tabsContainer = this.querySelector('.sai-ty137c1l__filter-tabs')
        if (!filtersContainer) return

        const dims = Object.entries(this._filterTags)
        const filterBtns = this.querySelectorAll('.sai-ty137c1l__select-model')

        if (dims.length === 0 || this._allAssets.length <= 1) {
          for (const btn of filterBtns) btn.removeAttribute('data-has-filters')
          return
        }

        for (const btn of filterBtns) btn.setAttribute('data-has-filters', '')

        const dcImages = this._pool?.displayConfigImages || {}

        /* Build tabs */
        if (tabsContainer) {
          tabsContainer.innerHTML = ''
          for (let i = 0; i < dims.length; i++) {
            const [dim] = dims[i]
            const tab = document.createElement('button')
            tab.className = 'sai-ty137c1l__filter-tab'
            if (i === 0) tab.classList.add('sai-ty137c1l__filter-tab--active')
            tab.type = 'button'
            tab.dataset.filterTabDim = dim
            tab.textContent = dim
            /* Checkmark for dimensions with a pending selection */
            const check = document.createElement('span')
            check.className = 'sai-ty137c1l__filter-tab-check'
            check.textContent = ''
            tab.appendChild(check)
            tabsContainer.appendChild(tab)
          }

          tabsContainer.addEventListener('click', (e) => {
            const tabBtn = e.target.closest('.sai-ty137c1l__filter-tab')
            if (!tabBtn) return
            const dim = tabBtn.dataset.filterTabDim
            if (!dim) return
            /* Switch active tab */
            for (const t of tabsContainer.querySelectorAll('.sai-ty137c1l__filter-tab')) {
              t.classList.toggle('sai-ty137c1l__filter-tab--active', t.dataset.filterTabDim === dim)
            }
            /* Switch active content */
            const panel = this.querySelector('.sai-ty137c1l__filter-panel-body')
            if (panel) {
              for (const c of panel.querySelectorAll('.sai-ty137c1l__filter-content')) {
                c.classList.toggle(
                  'sai-ty137c1l__filter-content--active',
                  c.dataset.filterContentDim === dim,
                )
              }
            }
          })
        }

        /* Build content panels per dimension */
        filtersContainer.innerHTML = ''
        for (let i = 0; i < dims.length; i++) {
          const [dim, values] = dims[i]
          if (!Array.isArray(values) || values.length < 1) continue

          const content = document.createElement('div')
          content.className = 'sai-ty137c1l__filter-content'
          if (i === 0) content.classList.add('sai-ty137c1l__filter-content--active')
          content.dataset.filterContentDim = dim

          /* Determine rendering mode: grid (image/swatch) vs pills (text/null) */
          const hasVisual = values.some(
            (e) => e.displayConfig?.kind === 'image' || e.displayConfig?.kind === 'swatch',
          )

          if (hasVisual) {
            const grid = document.createElement('div')
            grid.className = 'sai-ty137c1l__filter-grid'

            for (const entry of values) {
              const val = entry.value
              const dc = entry.displayConfig
              const card = document.createElement('button')
              card.className = 'sai-ty137c1l__filter-card'
              card.type = 'button'
              card.dataset.filterDim = dim
              card.dataset.filterVal = val

              if (dc?.kind === 'image' && dc.value?.imageGid) {
                const img = document.createElement('img')
                img.className = 'sai-ty137c1l__filter-card-image'
                img.alt = val
                const imageUrl = dcImages[dc.value.imageGid]
                if (imageUrl) img.src = imageUrl
                card.appendChild(img)
              } else if (dc?.kind === 'swatch' && dc.value?.color) {
                const swatch = document.createElement('span')
                swatch.className = 'sai-ty137c1l__filter-card-swatch'
                swatch.style.backgroundColor = dc.value.color
                card.appendChild(swatch)
              }

              const label = document.createElement('span')
              label.className = 'sai-ty137c1l__filter-card-label'
              label.textContent = dc?.kind === 'text' && dc.value?.text ? dc.value.text : val
              card.appendChild(label)

              grid.appendChild(card)
            }

            content.appendChild(grid)
          } else {
            const pills = document.createElement('div')
            pills.className = 'sai-ty137c1l__filter-pills'

            for (const entry of values) {
              const val = entry.value
              const dc = entry.displayConfig
              const pill = document.createElement('button')
              pill.className = 'sai-ty137c1l__filter-pill'
              pill.type = 'button'
              pill.dataset.filterDim = dim
              pill.dataset.filterVal = val
              pill.textContent = dc?.kind === 'text' && dc.value?.text ? dc.value.text : val
              pills.appendChild(pill)
            }

            content.appendChild(pills)
          }

          filtersContainer.appendChild(content)
        }
      }

      _openFilterPanel() {
        const dialog = this._filterDialog || this.querySelector('.sai-ty137c1l__filter-dialog')
        if (!dialog) return
        this._filterDialog = dialog
        this._pendingFilters = { ...this._activeFilters }
        this._renderFilterControls()
        document.documentElement.style.overflow = 'hidden'
        dialog.showModal()
        this._updateFilterItems()
        this._updateClearButton()
      }

      _closeFilterPanel() {
        const dialog = this._filterDialog || this.querySelector('.sai-ty137c1l__filter-dialog')
        if (!dialog) return
        dialog.close()
        document.documentElement.style.overflow = ''
      }

      _removeFilterFromBody() {
        document.documentElement.style.overflow = ''
      }

      _applyPendingFilters() {
        this._activeFilters = { ...this._pendingFilters }
        this._applyFilters()
        this._saveFilters()
        this._closeFilterPanel()
        this._track(`${FEATURE_SLUG}:filter_apply`, { active_filters: { ...this._activeFilters } })
      }

      _updateFilterItems() {
        const root = this._filterPanel || this
        const items = root.querySelectorAll(
          '.sai-ty137c1l__filter-card, .sai-ty137c1l__filter-pill',
        )
        for (const item of items) {
          const dim = item.dataset.filterDim
          const val = item.dataset.filterVal
          const isActive = this._pendingFilters[dim] === val
          if (item.classList.contains('sai-ty137c1l__filter-card')) {
            item.classList.toggle('sai-ty137c1l__filter-card--active', isActive)
          } else {
            item.classList.toggle('sai-ty137c1l__filter-pill--active', isActive)
          }
        }
        this._updateTabChecks()
      }

      _updateTabChecks() {
        const tabsContainer = this.querySelector('.sai-ty137c1l__filter-tabs')
        if (!tabsContainer) return
        for (const tab of tabsContainer.querySelectorAll('.sai-ty137c1l__filter-tab')) {
          const dim = tab.dataset.filterTabDim
          const check = tab.querySelector('.sai-ty137c1l__filter-tab-check')
          if (check) check.textContent = this._pendingFilters[dim] ? '✓' : ''
        }
      }

      _updateClearButton() {
        const root = this._filterPanel || this
        const clearBtn = root.querySelector('.sai-ty137c1l__filter-panel-clear')
        if (!clearBtn) return
        clearBtn.style.display = Object.keys(this._pendingFilters).length > 0 ? '' : 'none'
      }

      _applyFilters() {
        this._assets = filterAssets(this._allAssets, this._activeFilters)
        this._activeIndex = 0

        if (this._assets.length === 0) {
          this._assets = this._allAssets
          this._activeFilters = {}
        }
        this._showGallery()
        this._rebuildGallery()
      }

      _saveFilters() {
        try {
          if (Object.keys(this._activeFilters).length === 0) {
            localStorage.removeItem(FILTER_STORAGE_KEY)
          } else {
            localStorage.setItem(FILTER_STORAGE_KEY, JSON.stringify(this._activeFilters))
          }
        } catch (_) {
          /* storage full or unavailable */
        }
      }

      _loadFilters() {
        try {
          const stored = localStorage.getItem(FILTER_STORAGE_KEY)
          if (!stored) return {}
          const filters = JSON.parse(stored)
          if (!filters || typeof filters !== 'object') return {}
          const valid = {}
          for (const [key, val] of Object.entries(filters)) {
            const entries = this._filterTags[key]
            if (!entries) continue
            const match = entries.some((e) => (typeof e === 'string' ? e === val : e.value === val))
            if (match) valid[key] = val
          }
          return valid
        } catch (_) {
          return {}
        }
      }

      _showGallery() {
        const desktop = this.querySelector('.sai-ty137c1l__desktop')
        const mobile = this.querySelector('.sai-ty137c1l__mobile')
        if (desktop) desktop.style.removeProperty('display')
        if (mobile) mobile.style.removeProperty('display')
      }

      // ── Navigation ──

      _initNav() {
        this.addEventListener('click', (e) => {
          const action = e.target.closest('[data-action]')?.dataset.action
          if (action === 'prev') this._goTo(this._activeIndex - 1)
          if (action === 'next') this._goTo(this._activeIndex + 1)
        })
      }

      _goTo(index) {
        if (this._assets.length === 0) return
        const count = this._assets.length
        const next = ((index % count) + count) % count
        if (next === this._activeIndex) return
        for (const v of this.querySelectorAll('video')) v.pause()
        this._activeIndex = next
        this._updateSpotlight()
        this._updateThumbs()
        this._updateDots()
        this._updateStepper()
        this._syncMobileTrack()
        this._updateMobileVideoControls()
        if (this._props.autoplayVideo && this._assets[next]?.type === 'video') {
          const track = this.querySelector('.sai-ty137c1l__mobile-track')
          const slide = track?.children[next]
          const video = slide?.querySelector('video')
          if (video) video.play().catch(() => {})
        }
        this._track(`${FEATURE_SLUG}:image_view`, { index: next, source: 'nav' })
      }

      _updateSpotlight() {
        const asset = this._assets[this._activeIndex]
        if (!asset) return

        const desktopWrap = this.querySelector(
          '.sai-ty137c1l__desktop .sai-ty137c1l__spotlight-wrap',
        )
        const desktopSpot = this.querySelector('.sai-ty137c1l__desktop .sai-ty137c1l__spotlight')
        if (desktopSpot) {
          desktopSpot.innerHTML = ''
          desktopSpot.dataset.index = this._activeIndex
          const media = createSpotlightMedia(asset, true, this._props)
          desktopSpot.appendChild(media)
          if (media.tagName === 'VIDEO') this._bindVideoTracking(media, this._activeIndex)
        }
        /* Refresh video controls on the spotlight wrapper */
        if (desktopWrap) {
          for (const old of desktopWrap.querySelectorAll(
            '.sai-ty137c1l__video-play, .sai-ty137c1l__video-mute',
          ))
            old.remove()
          if (asset.type === 'video') {
            const video = desktopSpot?.querySelector('video')
            if (video) this._attachVideoControls(desktopWrap, video)
          }
        }
      }

      _isActiveSlideVideoPlaying() {
        const track = this.querySelector('.sai-ty137c1l__mobile-track')
        const slide = track?.children[this._activeIndex]
        if (slide) {
          for (const video of slide.querySelectorAll('video')) {
            if (!video.paused && !video.ended) return true
          }
        }
        const desktopSpot = this.querySelector('.sai-ty137c1l__desktop .sai-ty137c1l__spotlight')
        if (desktopSpot) {
          for (const video of desktopSpot.querySelectorAll('video')) {
            if (!video.paused && !video.ended) return true
          }
        }
        return false
      }

      _bindVideoTracking(video, index) {
        video.addEventListener('play', () => {
          this._track(`${FEATURE_SLUG}:video_play`, { index })
          if (this._autoplayTimer) {
            clearInterval(this._autoplayTimer)
            this._autoplayTimer = null
          }
        })
        video.addEventListener('pause', () => {
          this._track(`${FEATURE_SLUG}:video_pause`, { index })
          this._restartAutoplay()
        })
        video.addEventListener('ended', () => {
          this._restartAutoplay()
        })
      }

      /**
       * Attach custom play/pause + mute buttons to a positioned container
       * that holds (or is an ancestor of) the given video element.
       */
      _attachVideoControls(container, video) {
        const { playBtn, muteBtn } = createVideoControls(video)
        if (this._props.showPlayPause) container.appendChild(playBtn)
        container.appendChild(muteBtn)
      }

      /**
       * Refresh video controls on the mobile spotlight wrapper for the
       * currently active slide. Controls are positioned on the wrapper
       * (not the slide) so they stay in-viewport as the track scrolls.
       */
      _updateMobileVideoControls() {
        const mobileWrap = this.querySelector('.sai-ty137c1l__mobile-spotlight-wrap')
        if (!mobileWrap) return
        for (const old of mobileWrap.querySelectorAll(
          '.sai-ty137c1l__video-play, .sai-ty137c1l__video-mute',
        ))
          old.remove()
        const track = this.querySelector('.sai-ty137c1l__mobile-track')
        const slide = track?.children[this._activeIndex]
        if (!slide) return
        const video = slide.querySelector('video')
        if (video) this._attachVideoControls(mobileWrap, video)
      }

      // ── Thumbnails ──

      _initThumbs() {
        // Desktop bottom strip and the optional mobile thumbnail strip
        // (mobile_nav = thumbnails) both use .__thumb buttons; bind
        // click→goTo on whichever containers are present.
        const containers = this.querySelectorAll(
          '.sai-ty137c1l__thumbs, .sai-ty137c1l__mobile-thumbs',
        )
        for (const container of containers) {
          container.addEventListener('click', (e) => {
            const thumb = e.target.closest('.sai-ty137c1l__thumb')
            if (!thumb) return
            const idx = Number.parseInt(thumb.dataset.index, 10)
            if (!Number.isNaN(idx)) this._goTo(idx)
          })
        }
      }

      _updateThumbs() {
        const thumbs = this.querySelectorAll(
          '.sai-ty137c1l__thumbs .sai-ty137c1l__thumb, .sai-ty137c1l__mobile-thumbs .sai-ty137c1l__thumb',
        )
        for (const t of thumbs) {
          const idx = Number.parseInt(t.dataset.index, 10)
          t.classList.toggle('sai-ty137c1l__thumb--active', idx === this._activeIndex)
        }
        this._scrollThumbIntoView()
      }

      _scrollThumbIntoView() {
        // Both strips scroll horizontally; inline:center centres the active
        // thumb while block:nearest avoids yanking the page vertically.
        const desktopActive = this.querySelector(
          '.sai-ty137c1l__thumbs .sai-ty137c1l__thumb--active',
        )
        if (desktopActive) {
          desktopActive.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' })
        }
        const mobileActive = this.querySelector(
          '.sai-ty137c1l__mobile-thumbs .sai-ty137c1l__thumb--active',
        )
        if (mobileActive) {
          mobileActive.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' })
        }
      }

      // ── Dots / Stepper ──

      _updateDots() {
        const container = this.querySelector('.sai-ty137c1l__dots')
        if (!container) return
        let activeDot = null
        for (const d of container.querySelectorAll('.sai-ty137c1l__dot')) {
          const idx = Number.parseInt(d.dataset.index, 10)
          const isActive = idx === this._activeIndex
          d.classList.toggle('sai-ty137c1l__dot--active', isActive)
          if (isActive) activeDot = d
        }
        // The dots band is width-capped and scrolls when the images outnumber
        // what fits, so keep the active dot centred in view — otherwise the
        // highlighted dot can sit clipped in the hidden overflow.
        if (activeDot && container.scrollWidth > container.clientWidth) {
          const cRect = container.getBoundingClientRect()
          const dRect = activeDot.getBoundingClientRect()
          const delta = dRect.left - cRect.left - (container.clientWidth - dRect.width) / 2
          container.scrollTo({ left: container.scrollLeft + delta, behavior: 'smooth' })
        }
      }

      _updateStepper() {
        const stepper = this.querySelector('.sai-ty137c1l__stepper')
        if (stepper) {
          stepper.textContent = `${this._activeIndex + 1} / ${this._assets.length}`
        }
      }

      // ── Mobile swipe ──

      _initMobileSwipe() {
        const track = this.querySelector('.sai-ty137c1l__mobile-track')
        if (!track) return
        let scrollTimeout
        track.addEventListener(
          'scroll',
          () => {
            clearTimeout(scrollTimeout)
            scrollTimeout = setTimeout(() => {
              const slideWidth = track.firstElementChild ? track.firstElementChild.offsetWidth : 1
              const newIndex = Math.round(track.scrollLeft / slideWidth)
              if (
                newIndex !== this._activeIndex &&
                newIndex >= 0 &&
                newIndex < this._assets.length
              ) {
                for (const v of track.querySelectorAll('video')) v.pause()
                this._activeIndex = newIndex
                this._updateDots()
                this._updateThumbs()
                this._updateStepper()
                this._updateMobileVideoControls()
                this._track(`${FEATURE_SLUG}:image_view`, { index: newIndex, source: 'swipe' })
              }
            }, 50)
          },
          { passive: true },
        )

        const dotsContainer = this.querySelector('.sai-ty137c1l__dots')
        if (dotsContainer) {
          dotsContainer.addEventListener('click', (e) => {
            const dot = e.target.closest('.sai-ty137c1l__dot')
            if (!dot) return
            const idx = Number.parseInt(dot.dataset.index, 10)
            if (!Number.isNaN(idx)) {
              this._activeIndex = idx
              this._syncMobileTrack()
              this._updateDots()
              this._updateStepper()
              this._updateMobileVideoControls()
              this._track(`${FEATURE_SLUG}:image_view`, { index: idx, source: 'dot' })
            }
          })
        }

        this._restartAutoplay()
      }

      _syncMobileTrack() {
        const track = this.querySelector('.sai-ty137c1l__mobile-track')
        if (!track?.firstElementChild) return
        const slideWidth = track.firstElementChild.offsetWidth
        track.scrollTo({ left: slideWidth * this._activeIndex, behavior: 'smooth' })
      }

      _restartAutoplay() {
        if (this._autoplayTimer) {
          clearInterval(this._autoplayTimer)
          this._autoplayTimer = null
        }
        if (!this._props.autoplay || this._assets.length <= 1 || this._isActiveSlideVideoPlaying())
          return
        this._autoplayTimer = setInterval(() => {
          if (this._assets.length <= 1 || this._isActiveSlideVideoPlaying()) return
          this._goTo(this._activeIndex + 1)
        }, this._props.autoplayInterval * 1000)
      }

      // ── Lightbox ──

      _initLightbox() {
        this._lightboxIndex = 0

        this.addEventListener('click', (e) => {
          const action = e.target.closest('[data-action]')?.dataset.action
          if (action === 'open-lightbox') this._openLightbox()
          if (action === 'close-lightbox') this._closeLightbox()
          if (action === 'lightbox-prev') this._lightboxGoTo(this._lightboxIndex - 1)
          if (action === 'lightbox-next') this._lightboxGoTo(this._lightboxIndex + 1)

          // The whole spotlight image is a zoom affordance, not just the zoom
          // button — a bare click on the media (anything that isn't an overlay
          // control) opens the lightbox. Buttons/links are excluded so nav
          // chevrons, the filter button, and video play/mute keep their own
          // behaviour. Mobile swipe is native scroll, which never fires click.
          if (
            !action &&
            e.target.closest(
              '.sai-ty137c1l__spotlight-wrap, .sai-ty137c1l__mobile-spotlight-wrap',
            ) &&
            !e.target.closest('button, a')
          ) {
            this._openLightbox()
          }
        })

        const dialog = this.querySelector('.sai-ty137c1l__lightbox')
        if (dialog) {
          dialog.addEventListener('click', (e) => {
            if (e.target === dialog) this._closeLightbox()
          })
          dialog.addEventListener('close', () => {
            document.documentElement.style.overflow = ''
          })
        }

        const thumbsContainer = this.querySelector('.sai-ty137c1l__lightbox-thumbs')
        if (thumbsContainer) {
          thumbsContainer.addEventListener('click', (e) => {
            const thumb = e.target.closest('.sai-ty137c1l__lightbox-thumb')
            if (!thumb) return
            const idx = Number.parseInt(thumb.dataset.index, 10)
            if (!Number.isNaN(idx)) this._lightboxGoTo(idx)
          })
        }
      }

      _openLightbox() {
        const dialog = this.querySelector('.sai-ty137c1l__lightbox')
        if (!dialog) return

        this._lightboxIndex = this._activeIndex
        const thumbsContainer = this.querySelector('.sai-ty137c1l__lightbox-thumbs')
        if (this._props.showLightboxThumbs) {
          this._buildLightboxThumbs()
          if (thumbsContainer) thumbsContainer.style.display = ''
        } else {
          if (thumbsContainer) thumbsContainer.style.display = 'none'
        }
        this._updateLightboxSpotlight()

        const navBtns = dialog.querySelectorAll('.sai-ty137c1l__lightbox-nav')
        for (const btn of navBtns) {
          btn.style.display = this._assets.length <= 1 ? 'none' : ''
        }

        document.documentElement.style.overflow = 'hidden'
        dialog.showModal()

        if (this._props.pinchToZoom) {
          const spotlight = this.querySelector('.sai-ty137c1l__lightbox-spotlight')
          if (spotlight && !spotlight._zoomInitialized) {
            this._initLightboxZoom(spotlight)
            spotlight._zoomInitialized = true
          }
        }

        this._lightboxOpenTime = Date.now()
        this._track(`${FEATURE_SLUG}:lightbox_open`, { asset_count: this._assets.length })
      }

      _closeLightbox() {
        const dialog = this.querySelector('.sai-ty137c1l__lightbox')
        if (!dialog) return
        for (const v of dialog.querySelectorAll('video')) v.pause()
        dialog.close()
        document.documentElement.style.overflow = ''
        const dwell = this._lightboxOpenTime ? Date.now() - this._lightboxOpenTime : 0
        this._track(`${FEATURE_SLUG}:lightbox_close`, { dwell_ms: dwell })
      }

      _lightboxGoTo(index) {
        if (this._assets.length === 0) return
        const count = this._assets.length
        const next = ((index % count) + count) % count
        this._lightboxIndex = next
        this._updateLightboxSpotlight()
        this._updateLightboxThumbs()
      }

      _buildLightboxThumbs() {
        const container = this.querySelector('.sai-ty137c1l__lightbox-thumbs')
        if (!container) return
        container.innerHTML = ''
        for (let i = 0; i < this._assets.length; i++) {
          const asset = this._assets[i]
          const btn = document.createElement('button')
          btn.className = `sai-ty137c1l__lightbox-thumb${i === this._lightboxIndex ? ' sai-ty137c1l__lightbox-thumb--active' : ''}`
          btn.type = 'button'
          btn.dataset.index = i
          btn.setAttribute('aria-label', `View image ${i + 1}`)
          const img = document.createElement('img')
          img.src = asset.thumb || asset.url
          img.alt = asset.alt || ''
          img.loading = 'lazy'
          btn.appendChild(img)
          container.appendChild(btn)
        }
      }

      _updateLightboxSpotlight() {
        const container = this.querySelector('.sai-ty137c1l__lightbox-spotlight')
        if (!container) return
        const asset = this._assets[this._lightboxIndex]
        if (!asset) return
        container.innerHTML = ''
        if (this._resetLightboxZoom) this._resetLightboxZoom()
        if (asset.type === 'video') {
          const wrap = document.createElement('div')
          wrap.className = 'sai-ty137c1l__lightbox-video-wrap'
          const video = document.createElement('video')
          video.src = asset.url
          video.autoplay = this._props.autoplayVideo !== false
          video.muted = true
          video.loop = true
          video.playsInline = true
          video.controls = false
          if (asset.thumb) video.poster = asset.thumb
          wrap.appendChild(video)
          container.appendChild(wrap)
          this._bindVideoTracking(video, this._lightboxIndex)
          this._attachVideoControls(wrap, video)
        } else {
          const img = document.createElement('img')
          img.src = asset.url
          img.alt = asset.alt || ''
          img.draggable = false
          container.appendChild(img)
        }
      }

      _initLightboxZoom(container) {
        let scale = 1
        let translateX = 0
        let translateY = 0
        let startDist = 0
        let startScale = 1
        let isPinching = false
        const pointers = new Map()
        const media = () =>
          container.querySelector('img, video, .sai-ty137c1l__lightbox-video-wrap')

        this._resetLightboxZoom = () => {
          scale = 1
          translateX = 0
          translateY = 0
          const el = media()
          if (el) {
            el.style.transform = ''
            el.style.cursor = ''
          }
        }

        const clampTranslate = () => {
          if (scale <= 1) {
            translateX = 0
            translateY = 0
            return
          }
          const maxX = (container.offsetWidth * (scale - 1)) / 2
          const maxY = (container.offsetHeight * (scale - 1)) / 2
          translateX = Math.max(-maxX, Math.min(maxX, translateX))
          translateY = Math.max(-maxY, Math.min(maxY, translateY))
        }

        const apply = () => {
          const el = media()
          if (!el) return
          if (scale <= 1) {
            el.style.transform = ''
            el.style.cursor = ''
            translateX = 0
            translateY = 0
            scale = 1
          } else {
            el.style.transform = `translate(${translateX}px, ${translateY}px) scale(${scale})`
            el.style.cursor = 'grab'
          }
        }

        const dist = () => {
          const pts = Array.from(pointers.values())
          if (pts.length < 2) return 0
          return Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y)
        }

        container.addEventListener('pointerdown', (e) => {
          pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
          if (pointers.size === 2) {
            isPinching = true
            startDist = dist()
            startScale = scale
          }
        })

        container.addEventListener('pointermove', (e) => {
          if (!pointers.has(e.pointerId)) return
          pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
          if (isPinching && pointers.size === 2) {
            const d = dist()
            if (startDist > 0) {
              scale = Math.max(1, Math.min(4, startScale * (d / startDist)))
              clampTranslate()
              apply()
            }
          } else if (pointers.size === 1 && scale > 1) {
            translateX += e.movementX
            translateY += e.movementY
            clampTranslate()
            apply()
          }
        })

        const pointerUp = (e) => {
          pointers.delete(e.pointerId)
          if (pointers.size < 2) isPinching = false
        }
        container.addEventListener('pointerup', pointerUp)
        container.addEventListener('pointercancel', pointerUp)

        container.addEventListener(
          'wheel',
          (e) => {
            e.preventDefault()
            const delta = e.deltaY > 0 ? 0.9 : 1.1
            scale = Math.max(1, Math.min(4, scale * delta))
            clampTranslate()
            apply()
          },
          { passive: false },
        )

        container.addEventListener('dblclick', (e) => {
          if (scale > 1) {
            scale = 1
            translateX = 0
            translateY = 0
          } else {
            scale = 2
          }
          apply()
        })

        container.style.touchAction = 'none'
        container.style.userSelect = 'none'
        container.style.webkitUserSelect = 'none'
        container.addEventListener('dragstart', (e) => e.preventDefault())
      }

      _updateLightboxThumbs() {
        const thumbs = this.querySelectorAll('.sai-ty137c1l__lightbox-thumb')
        for (const t of thumbs) {
          const idx = Number.parseInt(t.dataset.index, 10)
          t.classList.toggle('sai-ty137c1l__lightbox-thumb--active', idx === this._lightboxIndex)
        }
        const active = this.querySelector('.sai-ty137c1l__lightbox-thumb--active')
        if (active)
          active.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' })
      }

      // ── Variant change ──

      _initVariantObserver() {
        const checkVariant = () => {
          const params = new URLSearchParams(window.location.search)
          const variantId = params.get('variant')
          if (variantId && variantId !== this._currentVariantId) {
            this._currentVariantId = variantId
            this._onVariantChange(variantId)
          }
        }

        if (!window.__sai_ty137c1l_history_patched__) {
          window.__sai_ty137c1l_history_patched__ = true
          const origPush = history.pushState.bind(history)
          const origReplace = history.replaceState.bind(history)
          window.__sai_ty137c1l_variant_handlers__ = []
          history.pushState = (...args) => {
            origPush(...args)
            for (const h of window.__sai_ty137c1l_variant_handlers__) h()
          }
          history.replaceState = (...args) => {
            origReplace(...args)
            for (const h of window.__sai_ty137c1l_variant_handlers__) h()
          }
          window.addEventListener('popstate', () => {
            for (const h of window.__sai_ty137c1l_variant_handlers__) h()
          })
        }
        window.__sai_ty137c1l_variant_handlers__.push(checkVariant)
        this._checkVariant = checkVariant
      }

      _teardownVariantObserver() {
        if (this._checkVariant && window.__sai_ty137c1l_variant_handlers__) {
          const idx = window.__sai_ty137c1l_variant_handlers__.indexOf(this._checkVariant)
          if (idx !== -1) window.__sai_ty137c1l_variant_handlers__.splice(idx, 1)
        }
      }

      _onVariantChange(variantId) {
        if (!this._pool) return
        const slot = resolveSlot(this._pool, variantId)
        const slotVariant = resolveSlotVariant(slot)
        if (!slotVariant?.assets) return
        const assets = resolveAssets(this._pool, slotVariant.assets)
        if (assets.length === 0) return
        this._allAssets = assets
        this._filterTags = buildFilterTags(slot?.filterTags)
        this._activeFilters = this._loadFilters()
        this._pendingFilters = {}
        this._applyFilters()
        this._renderFilterControls()
      }

      // ── Rebuild ──

      _rebuildGallery() {
        this._rebuildDesktopThumbs()
        this._updateSpotlight()
        this._rebuildMobileSlides()
        this._rebuildIndicators()
      }

      _rebuildDesktopThumbs() {
        const container = this.querySelector('.sai-ty137c1l__thumbs')
        if (!container) return
        container.innerHTML = ''
        for (let i = 0; i < this._assets.length; i++) {
          container.appendChild(createThumbEl(this._assets[i], i, i === this._activeIndex))
        }
      }

      _rebuildMobileSlides() {
        const track = this.querySelector('.sai-ty137c1l__mobile-track')
        if (!track) return
        track.innerHTML = ''
        /* Remove stale video controls from the mobile spotlight wrapper */
        const mobileWrap = this.querySelector('.sai-ty137c1l__mobile-spotlight-wrap')
        if (mobileWrap) {
          for (const old of mobileWrap.querySelectorAll(
            '.sai-ty137c1l__video-play, .sai-ty137c1l__video-mute',
          ))
            old.remove()
        }
        for (let i = 0; i < this._assets.length; i++) {
          const slide = document.createElement('div')
          slide.className = 'sai-ty137c1l__mobile-slide'
          slide.dataset.index = i
          slide.dataset.handle = this._assets[i].handle
          const media = createSpotlightMedia(this._assets[i], i === 0, this._props)
          slide.appendChild(media)
          track.appendChild(slide)
        }
        track.scrollLeft = 0
        for (let i = 0; i < this._assets.length; i++) {
          const slide = track.children[i]
          if (!slide) continue
          for (const video of slide.querySelectorAll('video')) {
            this._bindVideoTracking(video, i)
          }
        }
        /* Attach video controls for the initially visible mobile slide */
        this._updateMobileVideoControls()
      }

      _rebuildIndicators() {
        const dotsContainer = this.querySelector('.sai-ty137c1l__dots')
        if (dotsContainer) {
          dotsContainer.innerHTML = ''
          for (let i = 0; i < this._assets.length; i++) {
            const dot = document.createElement('button')
            dot.className = `sai-ty137c1l__dot${i === this._activeIndex ? ' sai-ty137c1l__dot--active' : ''}`
            dot.type = 'button'
            dot.dataset.index = i
            dot.setAttribute('aria-label', `Go to image ${i + 1}`)
            dotsContainer.appendChild(dot)
          }
        }
        /* Mobile thumbnail strip (mobile_nav = thumbnails) — rebuild from the
           filtered asset set, reusing the same thumb factory as the desktop strip. */
        const mobileThumbs = this.querySelector('.sai-ty137c1l__mobile-thumbs')
        if (mobileThumbs) {
          mobileThumbs.innerHTML = ''
          for (let i = 0; i < this._assets.length; i++) {
            mobileThumbs.appendChild(createThumbEl(this._assets[i], i, i === this._activeIndex))
          }
        }
      }
    }
    customElements.define(TAG, SaiProductGalleryV3)
  }

  // ── Bind ──

  function bindAllContainers() {
    const snippetApi = window.__spectrumAi?.snippet
    const containers = document.querySelectorAll(
      `[data-spectrum-instance-id][data-spectrum-snippet-id="${SNIPPET_ID}"]`,
    )

    for (const node of containers) {
      const pool = readSnippetPool(node)
      const root = node.querySelector(TAG)
      if (!root) continue
      root._applyPool(pool)
      if (snippetApi) {
        const handles = snippetApi.bind(
          node,
          ({ variant, entry, pools, variants, currentVariantId }) => {
            const resolvedVariant =
              variant ?? variants?.find((v) => v.variantId === currentVariantId)
            if (!resolvedVariant?.content) return
            const snippetPool = readSnippetPool(node)
            root._applyPool(snippetPool)
          },
        )
        if (handles) root.setAnalytics(handles.track)
      }
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindAllContainers, { once: true })
  } else {
    bindAllContainers()
  }

  if (typeof globalThis !== 'undefined' && globalThis.__SAI_TEST_HARNESS__ === true) {
    globalThis.__saiTy137c1l = {
      readSnippetPool,
      safeTrack,
      resolveSlot,
      resolveSlotVariant,
      resolveAssets,
      createSpotlightMedia,
      createThumbEl,
      filterAssets,
      buildFilterTags,
    }
  }
})()
