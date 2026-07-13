/* =============================================================================
 * PDP FAQs (f4qpdp01) — slot-derived
 *
 * Rewrite for the snippet content slots model (foundation §3-§5). FAQ items
 * arrive inline via `entry.content.items` from a data-ingestion-owned simple
 * slot (`product.metafields.spectrum.faqs_<state>`). The snippet renders
 * server-side; this runtime adds:
 *
 *   1. <sai-f4qpdp01> custom element with applyVariant(presentation, content)
 *      so cross-experience and content-experiment swaps rebuild the accordion.
 *   2. __spectrumAi.snippet.bind(node, callback) for variant resolution AND
 *      to capture the analytics `track` handle.
 *   3. Three analytics events through track (faqs:open, faqs:close, faqs:ask).
 *      Catalog: packages/snippet-library/docs/faqs.analytics.md.
 *   4. Existing Ask AI block (POST {proxyBase}/faq/ask) — behaviour unchanged
 *      apart from a single `track('faqs:ask', { question_text })` call before
 *      the network request.
 *
 * No-bind fallback: if window.__spectrumAi is absent (e.g. local dev without
 * the bootstrap SDK loaded, or a theme that hasn't installed the embed), the
 * SSR'd accordion remains usable with native <details> behaviour, the Ask AI
 * block hides itself, and analytics are silently skipped (track = noop).
 *
 * Trust boundary:
 *   answerHtml is centrally sanitized before persistence and is the only FAQ
 *   item field emitted as HTML. Question, category, and the derived id are
 *   assigned through DOM text/attribute APIs during variant rebuilds.
 *
 * data-faq-id derivation:
 *   The backend FaqSlotItem shape does not carry an `id`. The SSR template
 *   derives data-faq-id from `item.question | handleize`; this runtime
 *   mirrors that with handleize() so applyVariant rebuilds produce the
 *   same id. Stable across reorders and draft→live promotes; changes when
 *   the question text changes (intentional — different question = different
 *   FAQ for analytics purposes).
 * ============================================================================= */

;(() => {
  if (window.__sai_f4qpdp01_initialized__) return
  window.__sai_f4qpdp01_initialized__ = true

  const SNIPPET_ID = 'f4qpdp01'
  const TAG = 'sai-f4qpdp01'
  const FAQ_CAPABILITY_TIMEOUT_MS = 5000
  const FEATURE_SLUG = 'faqs'

  // Mirrors Shopify Liquid's `| handleize` — used to derive data-faq-id from
  // the question text. The SSR template uses `{{ item.question | handleize }}`;
  // applyVariant rebuilds must produce the same id so analytics dedup keys
  // match across page-load and post-rebuild.
  function handleize(s) {
    if (s == null) return ''
    return String(s)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
  }

  function noopTrack() {}

  function recordFaqCapabilityFailure(spectrumAi, error) {
    const diagnostic = {
      status: 'unavailable',
      detail: error instanceof Error ? error.message : String(error),
    }
    spectrumAi.faqCapabilityDiagnostic = diagnostic
    window.dispatchEvent(
      new CustomEvent('spectrum:faq-capability-unavailable', { detail: diagnostic }),
    )
    return false
  }

  // One capability read per storefront page, shared by every FAQ/Ask widget.
  // The public endpoint exposes only effective availability. Any transport or
  // shape failure resolves false so no dead ask control is shown.
  function getFaqCapabilityPromise(spectrumAi, proxyBase) {
    if (!spectrumAi) return Promise.resolve(false)
    if (!spectrumAi.faqCapabilityPromise) {
      const controller = new AbortController()
      const timeoutId = setTimeout(
        () => controller.abort(new Error('FAQ capability request timed out')),
        FAQ_CAPABILITY_TIMEOUT_MS,
      )
      spectrumAi.faqCapabilityPromise = fetch(`${proxyBase}/faq/capability`, {
        method: 'GET',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      })
        .then((response) => {
          if (!response.ok) throw new Error(`FAQ capability request failed: ${response.status}`)
          return response.json()
        })
        .then((payload) => {
          if (
            !payload ||
            payload.success !== true ||
            !payload.data ||
            typeof payload.data.enabled !== 'boolean'
          ) {
            throw new Error('Malformed FAQ capability payload')
          }
          return payload.data.enabled
        })
        .catch((error) => recordFaqCapabilityFailure(spectrumAi, error))
        .finally(() => clearTimeout(timeoutId))
    }
    return spectrumAi.faqCapabilityPromise
  }

  // safeTrack wraps every track call so a malformed payload or downstream
  // analytics bug never breaks the accordion or the Ask AI form.
  function safeTrack(track) {
    return (name, payload) => {
      try {
        track(name, payload)
      } catch (_) {
        /* swallow — analytics is best-effort */
      }
    }
  }

  function buildItem(item, index) {
    if (!item) return null
    const details = document.createElement('details')
    details.className = 'sai-f4qpdp01__item'
    details.dataset.faqId = handleize(item.question)
    details.dataset.faqCategory = String(item.category == null ? '' : item.category)
    details.dataset.index = String(index)
    details.setAttribute('role', 'listitem')

    const summary = document.createElement('summary')
    summary.className = 'sai-f4qpdp01__summary'
    const question = document.createElement('span')
    question.className = 'sai-f4qpdp01__question'
    question.textContent = String(item.question == null ? '' : item.question)
    const chevron = document.createElement('span')
    chevron.className = 'sai-f4qpdp01__chevron'
    chevron.setAttribute('aria-hidden', 'true')
    chevron.innerHTML =
      '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" focusable="false"><path d="M3 5L7 9L11 5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>'
    summary.append(question, chevron)

    const answer = document.createElement('div')
    answer.className = 'sai-f4qpdp01__answer'
    answer.innerHTML = item.answerHtml || ''
    details.append(summary, answer)
    return details
  }

  if (!customElements.get(TAG)) {
    class SaiFaqs extends HTMLElement {
      connectedCallback() {
        if (this._initialized) return
        this._initialized = true

        // Defaults; replaced via setAnalytics() once bindAllContainers runs.
        this._track = noopTrack
        this._faqCapabilityEnabled = false
        this._localShowQa = this.dataset.showQa !== 'false'
        this._localShowBranding = this.dataset.showBranding !== 'false'

        // Per-FAQ open timestamps so :close can report dwell_ms.
        this._openedAt = new Map()

        this._syncAskVisibility()
        this._initAccordion()
        this._initAsk()
      }

      // Called once per page-load by bindAllContainers, before the bind
      // callback fires. Until then, all tracking is a noop.
      setAnalytics(track) {
        this._track = typeof track === 'function' ? safeTrack(track) : noopTrack
      }

      _syncAskVisibility() {
        const ask = this.querySelector('.sai-f4qpdp01__ask')
        if (ask) ask.hidden = !(this._faqCapabilityEnabled && this._localShowQa)

        const footer = this.querySelector('[data-branding]')
        if (footer) {
          footer.hidden = !(this._faqCapabilityEnabled && this._localShowBranding)
        }
      }

      // Event-delegated toggle listener on the accordion container. The native
      // `toggle` event does NOT bubble, so we must listen in the capture
      // phase. Delegation lets us attach the listener once at init time;
      // applyVariant's innerHTML rebuild does not need to rebind because the
      // accordion container itself is preserved.
      _initAccordion() {
        const accordion = this.querySelector('.sai-f4qpdp01__accordion')
        if (!accordion || this._toggleBound) return
        this._toggleBound = true
        accordion.addEventListener(
          'toggle',
          (e) => {
            const target = e.target
            if (!target || typeof target.closest !== 'function') return
            const details = target.closest('.sai-f4qpdp01__item')
            if (details && this.contains(details)) {
              this._onItemToggle(details)
            }
          },
          true,
        )
      }

      _onItemToggle(details) {
        // Single-open: when one answer opens, close the others. Setting
        // `.open = false` dispatches a `toggle` on each closed item, so their
        // :close analytics still flow through this same delegated handler.
        if (details.open && this.dataset.singleOpen === 'true') {
          const acc = this.querySelector('.sai-f4qpdp01__accordion')
          if (acc) {
            for (const other of acc.querySelectorAll('.sai-f4qpdp01__item[open]')) {
              if (other !== details) other.open = false
            }
          }
        }

        const faqId = details.getAttribute('data-faq-id') || ''
        const questionEl = details.querySelector('.sai-f4qpdp01__question')
        const faqQuestion = questionEl ? (questionEl.textContent || '').trim() : ''
        const faqCategory = details.getAttribute('data-faq-category') || ''
        const positionAttr = details.getAttribute('data-index')
        const position = positionAttr == null ? 0 : Number.parseInt(positionAttr, 10) || 0

        const basePayload = {
          faq_id: faqId,
          faq_question: faqQuestion,
          position,
        }
        if (faqCategory) basePayload.faq_category = faqCategory

        if (details.open) {
          this._openedAt.set(faqId, Date.now())
          this._track(`${FEATURE_SLUG}:open`, basePayload)
        } else {
          const openedAt = this._openedAt.get(faqId)
          this._openedAt.delete(faqId)
          // dwell_ms is null when :close fires without a paired :open in this
          // page-view (defensive — should not happen in practice; would
          // indicate a missed setAnalytics race or a stale toggle replay).
          const dwell_ms = openedAt != null ? Date.now() - openedAt : null
          this._track(`${FEATURE_SLUG}:close`, { ...basePayload, dwell_ms })
        }
      }

      _initAsk() {
        this._ask = null
        const spectrumAi = window.__spectrumAi || null

        if (!spectrumAi) {
          // No Spectrum AI — accordion still works; hide Ask block.
          this._syncAskVisibility()
          return
        }

        const form = this.querySelector('[data-action="ask"]')
        const input = form ? form.querySelector('.sai-f4qpdp01__input') : null
        const sendBtn = form ? form.querySelector('.sai-f4qpdp01__send') : null
        const exchangeSlot = this.querySelector('[data-slot="exchange"]')

        if (!form || !input || !exchangeSlot) return

        // Resolve the brand-specific app-proxy base. The Spectrum AI app embed
        // publishes window.__spectrumAi.baseProxyUrl (e.g. /apps/spectrum_ai_<org>),
        // which is authoritative. Fall back to the data attribute, then the literal.
        const proxyBase =
          spectrumAi?.baseProxyUrl || this.getAttribute('data-proxy-base') || '/apps/spectrum'
        const productId = Number(this.getAttribute('data-product-id'))
        const productHandle = this.getAttribute('data-product-handle') || ''

        const ask = {
          form,
          input,
          sendBtn,
          exchangeSlot,
          proxyBase,
          productId,
          productHandle,
          rateLimitedUntil: 0,
          inflight: false,
        }
        this._ask = ask

        getFaqCapabilityPromise(spectrumAi, proxyBase).then((enabled) => {
          this._faqCapabilityEnabled = enabled === true
          this._syncAskVisibility()
        })

        form.addEventListener('submit', (e) => {
          e.preventDefault()
          if (ask.inflight) return
          this._ask_submit(input.value)
        })
      }

      _ask_buildTargetingContext() {
        const spectrumAi = window.__spectrumAi || null
        const builder =
          spectrumAi?.targeting && typeof spectrumAi.targeting.buildContext === 'function'
            ? spectrumAi.targeting.buildContext
            : null
        if (builder) {
          try {
            return builder()
          } catch (_) {
            /* fall through */
          }
        }
        let device = 'desktop'
        const w = window.innerWidth || 0
        if (w > 0 && w < 768) device = 'mobile'
        else if (w >= 768 && w < 1024) device = 'tablet'
        const customer = spectrumAi?.customer || null
        return {
          page: {
            type: 'product',
            url: window.location.href,
            path: window.location.pathname,
          },
          device: { type: device },
          currentUser: customer
            ? { isAnonymous: false, id: String(customer.id), email: customer.email }
            : { isAnonymous: true },
        }
      }

      _ask_setBusy(busy) {
        const ask = this._ask
        if (!ask) return
        ask.inflight = busy
        if (ask.sendBtn) ask.sendBtn.disabled = busy
        ask.input.disabled = busy
      }

      // "Was this helpful?" thumbs on an answer. One vote per exchange (the slot
      // is replaced on the next question); a failed POST is swallowed — feedback
      // is best-effort and must never disrupt the shopper.
      _faq_feedback(questionId) {
        const ask = this._ask
        const wrap = document.createElement('div')
        wrap.className = 'sai-f4qpdp01__feedback'
        const label = document.createElement('span')
        label.className = 'sai-f4qpdp01__feedback-label'
        label.textContent = 'Was this helpful?'
        wrap.appendChild(label)

        const vote = (rating, btn) => {
          if (wrap.getAttribute('data-voted')) return
          wrap.setAttribute('data-voted', rating)
          btn.classList.add('sai-f4qpdp01__feedback-btn--active')
          label.textContent = 'Thanks for the feedback'
          this._track(`${FEATURE_SLUG}:feedback`, { question_id: questionId, rating })
          fetch(`${ask.proxyBase}/faq/feedback`, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ questionId, rating }),
          }).catch(() => {})
        }

        const mk = (rating, text, aria) => {
          const b = document.createElement('button')
          b.type = 'button'
          b.className = 'sai-f4qpdp01__feedback-btn'
          b.setAttribute('aria-label', aria)
          b.textContent = text
          b.addEventListener('click', () => vote(rating, b))
          return b
        }
        wrap.appendChild(mk('helpful', 'Yes', 'Yes, this was helpful'))
        wrap.appendChild(mk('unhelpful', 'No', 'No, this was not helpful'))
        return wrap
      }

      _ask_renderExchange(state) {
        const ask = this._ask
        if (!ask) return
        const slot = ask.exchangeSlot
        slot.replaceChildren()

        const q = document.createElement('div')
        q.className = 'sai-f4qpdp01__exchange-question'
        q.textContent = state.question
        slot.appendChild(q)

        if (state.status === 'loading') {
          const shimmer = document.createElement('div')
          shimmer.className = 'sai-f4qpdp01__shimmer'
          const line1 = document.createElement('div')
          line1.className = 'sai-f4qpdp01__shimmer-line'
          const line2 = document.createElement('div')
          line2.className = 'sai-f4qpdp01__shimmer-line'
          shimmer.appendChild(line1)
          shimmer.appendChild(line2)
          slot.appendChild(shimmer)
        } else if (state.status === 'success') {
          const answer = document.createElement('div')
          answer.className = 'sai-f4qpdp01__exchange-answer'
          answer.innerHTML = state.answerHtml || ''
          // Feedback control inside the answer, when the server returned a
          // questionId (== the faq_question_log row id) to rate against.
          if (state.questionId) answer.appendChild(this._faq_feedback(state.questionId))
          slot.appendChild(answer)

          const chips = (state.followUps || [])
            .filter((t) => typeof t === 'string' && t)
            .slice(0, 3)
          if (chips.length) {
            const wrap = document.createElement('div')
            wrap.className = 'sai-f4qpdp01__followups'
            for (const text of chips) {
              const btn = document.createElement('button')
              btn.type = 'button'
              btn.className = 'sai-f4qpdp01__followup'
              btn.textContent = text
              btn.addEventListener('click', () => {
                if (this._ask?.inflight) return
                this._ask_submit(text)
              })
              wrap.appendChild(btn)
            }
            slot.appendChild(wrap)
          }
        } else if (state.status === 'error') {
          const err = document.createElement('div')
          err.className = 'sai-f4qpdp01__exchange-error'

          const msg = document.createElement('span')
          msg.textContent = state.message
          err.appendChild(msg)

          if (state.retryable) {
            const retry = document.createElement('button')
            retry.type = 'button'
            retry.className = 'sai-f4qpdp01__retry'
            retry.textContent = 'Retry'
            retry.addEventListener('click', () => {
              if (this._ask?.inflight) return
              this._ask_submit(state.question)
            })
            err.appendChild(retry)
          }

          slot.appendChild(err)
        }

        slot.hidden = false
      }

      _ask_submit(question) {
        const ask = this._ask
        if (!ask) return
        const trimmed = (question || '').trim()
        if (!trimmed) return

        const now = Date.now()
        if (now < ask.rateLimitedUntil) {
          const waitS = Math.ceil((ask.rateLimitedUntil - now) / 1000)
          this._ask_renderExchange({
            question: trimmed,
            status: 'error',
            message: `Please wait ${waitS}s before asking another question.`,
            retryable: false,
          })
          return
        }

        // Intent signal — fires BEFORE the fetch (mirrors svmk8tqx
        // add_to_cart pattern). Pair with :ask_response when product asks.
        this._track(`${FEATURE_SLUG}:ask`, { question_text: trimmed })

        // Loading state up first; clear input so the user can start typing again.
        this._ask_renderExchange({ question: trimmed, status: 'loading' })
        ask.input.value = ''
        this._ask_setBusy(true)

        const body = {
          question: trimmed,
          product: { id: ask.productId, handle: ask.productHandle },
          targetingContext: this._ask_buildTargetingContext(),
        }

        fetch(`${ask.proxyBase}/faq/ask`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
          .then((res) => {
            if (res.status === 429) {
              const retryAfter = Number.parseInt(res.headers.get('Retry-After') || '0', 10)
              if (retryAfter > 0) ask.rateLimitedUntil = Date.now() + retryAfter * 1000
            }
            return res.json().then((json) => ({ res, json }))
          })
          .then((out) => {
            const json = out.json || {}
            if (out.res.ok && json.success === true && json.data) {
              this._ask_renderExchange({
                question: trimmed,
                status: 'success',
                answerHtml: json.data.answer?.html,
                followUps: json.data.followUps || [],
                questionId: json.data.questionId,
              })
            } else {
              const msg =
                (json && (json.error || json.message)) ||
                "We couldn't get an answer right now. Please try again."
              const status = out.res.status
              const retryable = status === 429 || status >= 500
              this._ask_renderExchange({
                question: trimmed,
                status: 'error',
                message: msg,
                retryable,
              })
            }
          })
          .catch(() => {
            this._ask_renderExchange({
              question: trimmed,
              status: 'error',
              message: "We couldn't reach the server. Please check your connection and try again.",
              retryable: true,
            })
          })
          .then(() => {
            this._ask_setBusy(false)
          })
      }

      // Variant resolution entry point. Re-renders the inner DOM from the
      // resolved presentation + content. Called by the bind callback on every
      // $spectrum:variant_resolved event.
      applyVariant(presentation, content) {
        const heading =
          presentation && typeof presentation.heading === 'string' ? presentation.heading : null
        const subheading =
          presentation && typeof presentation.subheading === 'string'
            ? presentation.subheading
            : null
        const qaHeading =
          presentation && typeof presentation.qa_heading === 'string'
            ? presentation.qa_heading
            : null
        const placeholder =
          presentation && typeof presentation.input_placeholder === 'string'
            ? presentation.input_placeholder
            : null
        const allItems = content && Array.isArray(content.items) ? content.items : []
        // Cap to data-max-faqs (0/absent = show all) so JS rebuilds match SSR.
        const maxFaqs = Number.parseInt(this.dataset.maxFaqs || '0', 10) || 0
        const items = maxFaqs > 0 ? allItems.slice(0, maxFaqs) : allItems

        if (heading != null) {
          const h = this.querySelector('.sai-f4qpdp01__heading')
          if (h) h.textContent = heading
        }
        if (subheading != null) {
          let sub = this.querySelector('.sai-f4qpdp01__subheading')
          if (!sub) {
            sub = document.createElement('p')
            sub.className = 'sai-f4qpdp01__subheading'
            const header = this.querySelector('.sai-f4qpdp01__header')
            if (header) header.appendChild(sub)
          }
          sub.textContent = subheading
          sub.hidden = !subheading
        }
        if (qaHeading != null) {
          const h = this.querySelector('.sai-f4qpdp01__qa-heading')
          if (h) h.textContent = qaHeading
        }
        if (placeholder != null) {
          const input = this.querySelector('.sai-f4qpdp01__input')
          if (input) input.placeholder = placeholder
        }
        if (presentation && typeof presentation.show_faqs === 'boolean') {
          const faqsSection = this.querySelector('[data-faqs-section]')
          if (faqsSection) faqsSection.hidden = !presentation.show_faqs
        }
        if (presentation && typeof presentation.show_qa === 'boolean') {
          this._localShowQa = presentation.show_qa
          this._syncAskVisibility()
        }
        if (presentation && typeof presentation.show_branding === 'boolean') {
          this._localShowBranding = presentation.show_branding
          let footer = this.querySelector('[data-branding]')
          if (!footer) {
            footer = document.createElement('footer')
            footer.className = 'sai-f4qpdp01__footer'
            footer.setAttribute('data-branding', '')
            footer.innerHTML =
              '<span class="sai-f4qpdp01__brand">Powered by Spectrum AI</span>' +
              '<span class="sai-f4qpdp01__divider" aria-hidden="true">|</span>' +
              '<span class="sai-f4qpdp01__disclaimer">This answer is AI-generated. Please double check important information.</span>'
            const container = this.querySelector('.sai-f4qpdp01__container')
            if (container) container.appendChild(footer)
          }
          this._syncAskVisibility()
        }

        let accordion = this.querySelector('.sai-f4qpdp01__accordion')
        if (!accordion && items.length > 0) {
          accordion = document.createElement('div')
          accordion.className = 'sai-f4qpdp01__accordion'
          accordion.setAttribute('role', 'list')
          const faqsSection = this.querySelector('[data-faqs-section]')
          if (faqsSection) faqsSection.appendChild(accordion)
          this._toggleBound = false
          this._initAccordion()
        }
        if (!accordion) return
        accordion.replaceChildren(...items.map((item, i) => buildItem(item, i)).filter(Boolean))

        // Reset dwell tracker — replaced DOM means previous open timestamps
        // would be misleading on a future :close.
        this._openedAt = new Map()

        // No rebind needed — the toggle listener is delegated in capture
        // phase on the accordion container, which is preserved across
        // applyVariant rebuilds.
      }
    }
    customElements.define(TAG, SaiFaqs)
  }

  // ── Test surface — pure helpers exposed for unit tests when the harness
  // flag is set. Production never sets the flag.
  if (typeof globalThis !== 'undefined' && globalThis.__SAI_TEST_HARNESS__ === true) {
    globalThis.__saiF4qpdp01 = {
      buildItem,
      safeTrack,
    }
  }

  function bindAllContainers() {
    const api = window.__spectrumAi?.snippet
    const containers = document.querySelectorAll(
      `[data-spectrum-instance-id][data-spectrum-snippet-id="${SNIPPET_ID}"]`,
    )

    if (!api?.bind) {
      // No-bind fallback: SSR'd accordion + Ask AI behave as already rendered.
      // The custom element initialises with noopTrack via connectedCallback
      // so toggles silently skip analytics. Nothing more to do here.
      return
    }

    for (const node of containers) {
      const handles = api.bind(node, ({ variant, entry }) => {
        if (!variant?.content || !entry?.content) return
        const root = node.querySelector(TAG)
        if (root && typeof root.applyVariant === 'function') {
          root.applyVariant(variant.content, entry.content)
        }
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
