/**
 * Lead Reload HQ — lead order wizard + Stripe Checkout
 * Customer prices = wholesale × 1.30, rounded to nearest cent (see README).
 */

(function () {
  "use strict";

  const LEAD_TYPES = {
    "general-life": {
      id: "general-life",
      label: "General Life",
      pricingKey: "lifeMp",
    },
    "mortgage-protection": {
      id: "mortgage-protection",
      label: "Mortgage Protection",
      pricingKey: "lifeMp",
    },
    "private-health": {
      id: "private-health",
      label: "Private Health",
      pricingKey: "privateHealth",
    },
  };

  /**
   * Customer-facing unit prices (already wholesale × 1.30, rounded).
   * DISPLAY ONLY — Stripe charges the server-side table in
   * netlify/functions/lib/pricing.js (the unitPrice sent at checkout is
   * ignored). Keep both in sync; `npm run test:pricing` fails if they differ.
   */
  const PRICING = {
    privateHealth: [
      { id: "ph-u30", label: "Under 30 days", price: 0.52 },
      { id: "ph-30-60", label: "30–60 days", price: 0.33 },
      { id: "ph-60-90", label: "60–90 days", price: 0.26 },
      { id: "ph-90-180", label: "90–180 days", price: 0.13 },
      { id: "ph-180-360", label: "180–360 days", price: 0.07 },
      { id: "ph-365", label: "365+ days", price: 0.03 },
    ],
    lifeMp: [
      { id: "lm-u30", label: "Under 30 days", price: 0.52 },
      { id: "lm-30-60", label: "30–60 days", price: 0.39 },
      { id: "lm-60-90", label: "60–90 days", price: 0.2 },
      { id: "lm-90", label: "90+ days", price: 0.1 },
      { id: "lm-365", label: "365+ days", price: 0.03 },
    ],
  };

  const US_STATES = [
    ["AL", "Alabama"], ["AK", "Alaska"], ["AZ", "Arizona"], ["AR", "Arkansas"],
    ["CA", "California"], ["CO", "Colorado"], ["CT", "Connecticut"], ["DE", "Delaware"],
    ["DC", "District of Columbia"], ["FL", "Florida"], ["GA", "Georgia"], ["HI", "Hawaii"],
    ["ID", "Idaho"], ["IL", "Illinois"], ["IN", "Indiana"], ["IA", "Iowa"],
    ["KS", "Kansas"], ["KY", "Kentucky"], ["LA", "Louisiana"], ["ME", "Maine"],
    ["MD", "Maryland"], ["MA", "Massachusetts"], ["MI", "Michigan"], ["MN", "Minnesota"],
    ["MS", "Mississippi"], ["MO", "Missouri"], ["MT", "Montana"], ["NE", "Nebraska"],
    ["NV", "Nevada"], ["NH", "New Hampshire"], ["NJ", "New Jersey"], ["NM", "New Mexico"],
    ["NY", "New York"], ["NC", "North Carolina"], ["ND", "North Dakota"], ["OH", "Ohio"],
    ["OK", "Oklahoma"], ["OR", "Oregon"], ["PA", "Pennsylvania"], ["RI", "Rhode Island"],
    ["SC", "South Carolina"], ["SD", "South Dakota"], ["TN", "Tennessee"], ["TX", "Texas"],
    ["UT", "Utah"], ["VT", "Vermont"], ["VA", "Virginia"], ["WA", "Washington"],
    ["WV", "West Virginia"], ["WI", "Wisconsin"], ["WY", "Wyoming"],
  ];

  const STORAGE_KEY = "lead-reload-draft";
  const TOTAL_STEPS = 6;
  const MAX_QTY = 100000;
  /** Stripe's USD minimum; create-checkout rejects smaller totals. */
  const MIN_ORDER_CENTS = 50;
  const MIN_ORDER_MSG = "Minimum order is $0.50. Add more leads.";
  const CHECKOUT_API = "/.netlify/functions/create-checkout";

  const BILLING_OPTIONS = {
    "one-time": { id: "one-time", label: "One-time", short: "one-time", suffix: "" },
    weekly: { id: "weekly", label: "Weekly", short: "week", suffix: " / week" },
    monthly: { id: "monthly", label: "Monthly", short: "month", suffix: " / month" },
  };

  const CONTACT_OPTIONS = [
    "Dialer",
    "CRM / follow-up system",
    "Text",
    "Email",
    "SETR",
    "Other",
  ];

  const state = {
    step: 1,
    leadType: null,
    ageBandId: null,
    quantity: 100,
    states: [],
    billingCadence: "one-time",
    contactMethods: [],
    contactOther: "",
    paid: false,
    orderId: null,
  };

  // ——— Utils ———
  function money(n) {
    return "$" + Number(n).toFixed(2);
  }

  function formatQty(n) {
    return Number(n).toLocaleString("en-US");
  }

  function getBands() {
    if (!state.leadType) return [];
    const key = LEAD_TYPES[state.leadType].pricingKey;
    return PRICING[key];
  }

  function getSelectedBand() {
    return getBands().find((b) => b.id === state.ageBandId) || null;
  }

  function unitPrice() {
    const band = getSelectedBand();
    return band ? band.price : 0;
  }

  function orderTotal() {
    return unitPrice() * (Number(state.quantity) || 0);
  }

  function getBilling() {
    return BILLING_OPTIONS[state.billingCadence] || BILLING_OPTIONS["one-time"];
  }

  function formatCadenceTotal(n) {
    const b = getBilling();
    if (b.id === "one-time") return money(n) + " one-time";
    if (b.id === "weekly") return money(n) + " / week";
    return money(n) + " / month";
  }

  function billingLabel() {
    return getBilling().label;
  }


  function saveDraft() {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          step: state.step,
          leadType: state.leadType,
          ageBandId: state.ageBandId,
          quantity: state.quantity,
          states: state.states,
          billingCadence: state.billingCadence,
          contactMethods: state.contactMethods,
          contactOther: state.contactOther,
        })
      );
    } catch (_) {}
  }

  function loadDraft() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const d = JSON.parse(raw);
      if (d.leadType && LEAD_TYPES[d.leadType]) state.leadType = d.leadType;
      if (d.ageBandId) state.ageBandId = d.ageBandId;
      if (d.quantity >= 1) state.quantity = Math.min(MAX_QTY, Number(d.quantity) || 1);
      if (Array.isArray(d.states)) state.states = d.states;
      if (d.billingCadence && BILLING_OPTIONS[d.billingCadence]) {
        state.billingCadence = d.billingCadence;
      }
      if (Array.isArray(d.contactMethods)) {
        state.contactMethods = d.contactMethods.filter((m) =>
          CONTACT_OPTIONS.includes(m)
        );
      }
      if (typeof d.contactOther === "string") {
        state.contactOther = d.contactOther.slice(0, 120);
      }
      if (d.step >= 1 && d.step <= 5) state.step = d.step;
    } catch (_) {}
  }

  function clearDraft() {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch (_) {}
  }

  // ——— Render helpers ———
  function renderAgeBands() {
    const list = document.getElementById("age-band-list");
    const bands = getBands();
    list.innerHTML = bands
      .map(
        (b) => `
      <label class="age-option">
        <input type="radio" name="ageBand" value="${b.id}" ${
          state.ageBandId === b.id ? "checked" : ""
        } />
        <div class="age-option-body">
          <span class="age-label">${b.label}</span>
          <span class="age-price">${money(b.price)}<small>/ lead</small></span>
        </div>
      </label>`
      )
      .join("");

    list.querySelectorAll('input[name="ageBand"]').forEach((input) => {
      input.addEventListener("change", () => {
        state.ageBandId = input.value;
        saveDraft();
        updatePreview();
        updateNav();
      });
    });
  }

  function renderStates() {
    const grid = document.getElementById("states-grid");
    grid.innerHTML = US_STATES.map(
      ([code, name]) => `
      <label class="state-check" data-code="${code}" data-name="${name.toLowerCase()}">
        <input type="checkbox" value="${code}" ${
        state.states.includes(code) ? "checked" : ""
      } />
        <span>${code} — ${name}</span>
      </label>`
    ).join("");

    grid.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
      cb.addEventListener("change", () => {
        if (cb.checked) {
          if (!state.states.includes(cb.value)) state.states.push(cb.value);
        } else {
          state.states = state.states.filter((s) => s !== cb.value);
        }
        state.states.sort();
        updateStatesCount();
        saveDraft();
        updatePreview();
        updateNav();
      });
    });
    updateStatesCount();
  }

  function updateStatesCount() {
    document.getElementById("states-selected-count").textContent =
      state.states.length;
  }

  function buildSummaryRows() {
    const type = state.leadType ? LEAD_TYPES[state.leadType].label : "—";
    const band = getSelectedBand();
    const statesLabel =
      state.states.length === 0
        ? "—"
        : state.states.length === US_STATES.length
        ? "All states"
        : state.states.length <= 8
        ? state.states.join(", ")
        : state.states.slice(0, 6).join(", ") +
          ` +${state.states.length - 6} more`;

    const rows = [
      ["Lead type", type],
      ["Age band", band ? band.label : "—"],
      ["Quantity", formatQty(state.quantity)],
      ["States", statesLabel],
      ["Unit price", money(unitPrice())],
      ["Billing", billingLabel()],
      ["Total", formatCadenceTotal(orderTotal())],
    ];

    if (state.contactMethods.length) {
      const plan = state.contactMethods
        .map((m) =>
          m === "Other" && state.contactOther.trim()
            ? "Other (" + state.contactOther.trim() + ")"
            : m
        )
        .join(", ");
      rows.push(["Work plan", plan]);
    }

    return rows;
  }

  function renderReview() {
    const rows = buildSummaryRows();
    document.getElementById("review-summary").innerHTML = rows
      .map(
        ([k, v]) => `
      <div>
        <dt>${k}</dt>
        <dd>${v}</dd>
      </div>`
      )
      .join("");
  }

  function renderSuccessSummary() {
    const rows = buildSummaryRows();
    document.getElementById("success-summary").innerHTML = rows
      .map(
        ([k, v]) => `
      <div>
        <dt>${k}</dt>
        <dd>${v}</dd>
      </div>`
      )
      .join("");
  }

  function updatePreview() {
    const type = state.leadType ? LEAD_TYPES[state.leadType].label : "—";
    const band = getSelectedBand();
    document.getElementById("prev-type").textContent = type;
    document.getElementById("prev-age").textContent = band ? band.label : "—";
    document.getElementById("prev-qty").textContent = state.quantity
      ? formatQty(state.quantity)
      : "—";
    document.getElementById("prev-states").textContent =
      state.states.length === 0
        ? "—"
        : state.states.length === US_STATES.length
        ? "All 51"
        : formatQty(state.states.length) + " selected";
    document.getElementById("prev-unit").textContent = band
      ? money(band.price)
      : "—";
    const prevBilling = document.getElementById("prev-billing");
    if (prevBilling) prevBilling.textContent = billingLabel();
    const totalLabel = document.getElementById("prev-total-label");
    if (totalLabel) {
      const b = getBilling();
      totalLabel.textContent =
        b.id === "one-time" ? "Total" : b.id === "weekly" ? "Per week" : "Per month";
    }
    document.getElementById("prev-total").textContent = money(orderTotal());

    const qtyUnit = document.getElementById("qty-unit-price");
    const qtyEst = document.getElementById("qty-est-total");
    if (qtyUnit) qtyUnit.textContent = band ? money(band.price) : "—";
    if (qtyEst) qtyEst.textContent = band ? money(orderTotal()) : "—";

    const payAmt = document.getElementById("pay-amount");
    if (payAmt) payAmt.textContent = money(orderTotal());
    const payNote = document.getElementById("pay-cadence-note");
    if (payNote) {
      const b = getBilling();
      if (b.id === "one-time") payNote.textContent = "One-time charge · " + money(orderTotal());
      else if (b.id === "weekly") payNote.textContent = "Weekly subscription · " + money(orderTotal()) + " / week";
      else payNote.textContent = "Monthly subscription · " + money(orderTotal()) + " / month";
    }
    const tagOnce = document.getElementById("billing-tag-one-time");
    const tagWeek = document.getElementById("billing-tag-weekly");
    const tagMonth = document.getElementById("billing-tag-monthly");
    const tot = money(orderTotal());
    if (tagOnce) tagOnce.textContent = tot + " one-time";
    if (tagWeek) tagWeek.textContent = tot + " / week";
    if (tagMonth) tagMonth.textContent = tot + " / month";
    syncCompactBar();
  }
  function showStep(n) {
    state.step = n;
    document.querySelectorAll(".step").forEach((el) => {
      el.classList.toggle("hidden", Number(el.dataset.step) !== n);
    });

    document.querySelectorAll("#progress-steps li").forEach((li) => {
      const s = Number(li.dataset.step);
      li.classList.toggle("active", s === n);
      li.classList.toggle("done", s < n || state.paid);
    });

    const nav = document.getElementById("wizard-nav");
    const success = state.paid && n === 6;
    nav.classList.toggle("hidden", success);

    if (n === 2) renderAgeBands();
    if (n === 4) {
      renderStates();
      const search = document.getElementById("state-search");
      if (search) {
        // re-apply filter if any
        search.dispatchEvent(new Event("input"));
      }
    }
    if (n === 5) {
      renderReview();
      updatePreview();
      document.querySelectorAll('input[name="billingCadence"]').forEach((input) => {
        input.checked = input.value === state.billingCadence;
      });
    }
    if (n === 6) {
      document.getElementById("stripe-form").classList.toggle("hidden", state.paid);
      document.getElementById("success-panel").classList.toggle("hidden", !state.paid);
      if (state.paid) {
        renderSuccessSummary();
      } else {
        syncContactUIFromState();
        renderSetrPartnerCard();
      }
      updatePreview();
    }

    document.getElementById("btn-back").disabled = n === 1 || state.paid;
    const nextBtn = document.getElementById("btn-next");
    if (n === 5) {
      nextBtn.textContent = "Checkout";
    } else if (n === 6) {
      nextBtn.classList.add("hidden");
    } else {
      nextBtn.textContent = "Continue";
      nextBtn.classList.remove("hidden");
    }

    updateNav();
    saveDraft();
    syncCompactBar();

    // Reset sticky chrome immediately when leaving States / after Back
    if (condenseTimer) {
      clearTimeout(condenseTimer);
      condenseTimer = null;
    }
    if (state.step !== 4 || state.paid) {
      resetChromeClasses();
    }
    updateCondenseMode();

    // Instant scroll avoids sticky-bar races with smooth scroll + Back
    window.scrollTo(0, 0);
    // One frame later re-apply (layout settled)
    requestAnimationFrame(() => {
      updateCondenseMode();
      syncCompactBar();
    });
  }

  function canProceed() {
    switch (state.step) {
      case 1:
        return !!state.leadType;
      case 2:
        return !!state.ageBandId && getSelectedBand();
      case 3:
        return Number(state.quantity) >= 1 && Number(state.quantity) <= MAX_QTY;
      case 4:
        return state.states.length > 0;
      case 5:
        return !!BILLING_OPTIONS[state.billingCadence];
      default:
        return false;
    }
  }


  function syncCompactBar() {
    const total = document.getElementById("prev-total")?.textContent || "$0.00";
    const compactTotal = document.getElementById("compact-total");
    const compactQty = document.getElementById("compact-qty");
    const compactStates = document.getElementById("compact-states-n");
    if (compactTotal) compactTotal.textContent = total;
    if (compactQty) {
      const q = Number(state.quantity) || 0;
      compactQty.textContent = q ? formatQty(q) + " leads" : "—";
    }
    if (compactStates) {
      const n = state.states.length;
      compactStates.textContent = n === 1 ? "1 state" : n + " states";
    }
  }

  let condenseTimer = null;

  function resetChromeClasses() {
    document.body.classList.remove("condense-chrome", "preview-expanded", "states-focus");
    const bar = document.getElementById("compact-order-bar");
    if (bar) bar.hidden = true;
    const btn = document.getElementById("compact-expand");
    if (btn) {
      btn.setAttribute("aria-expanded", "false");
      btn.textContent = "Details";
    }
  }

  function setCondenseChrome(on) {
    document.body.classList.toggle("condense-chrome", !!on);
    const bar = document.getElementById("compact-order-bar");
    if (bar) bar.hidden = !on;
    if (!on) {
      document.body.classList.remove("preview-expanded");
      const btn = document.getElementById("compact-expand");
      if (btn) {
        btn.setAttribute("aria-expanded", "false");
        btn.textContent = "Details";
      }
    }
    syncCompactBar();
  }

  function updateCondenseMode() {
    const mobile = window.matchMedia("(max-width: 860px)").matches;
    // Mobile: always use thin bar (fat Order Preview was order:-1 above every step)
    const on = mobile && !state.paid;
    setCondenseChrome(on);
    document.body.classList.toggle("states-focus", on && state.step === 4);
  }

  function updateNav() {
    const nextBtn = document.getElementById("btn-next");
    if (state.step < 6) {
      nextBtn.disabled = !canProceed();
    }
  }

  function validateStep() {
    if (canProceed()) return true;
    const panel = document.querySelector(`.step[data-step="${state.step}"]`);
    if (panel) {
      panel.classList.remove("shake");
      void panel.offsetWidth;
      panel.classList.add("shake");
    }
    return false;
  }

  // ——— Card formatting (UI only) ———
  function formatCardNumber(value) {
    const digits = value.replace(/\D/g, "").slice(0, 16);
    return digits.replace(/(\d{4})(?=\d)/g, "$1 ").trim();
  }

  function formatExp(value) {
    const digits = value.replace(/\D/g, "").slice(0, 4);
    if (digits.length >= 3) return digits.slice(0, 2) + " / " + digits.slice(2);
    return digits;
  }


  // ——— Contact methods + SETR partner card ———
  function syncContactUIFromState() {
    document.querySelectorAll('input[name="contactMethod"]').forEach((cb) => {
      cb.checked = state.contactMethods.includes(cb.value);
    });
    const otherWrap = document.getElementById("contact-other-wrap");
    const otherText = document.getElementById("contact-other-text");
    const showOther = state.contactMethods.includes("Other");
    if (otherWrap) otherWrap.classList.toggle("hidden", !showOther);
    if (otherText) otherText.value = state.contactOther || "";
  }

  function readContactMethodsFromDOM() {
    const selected = [];
    document.querySelectorAll('input[name="contactMethod"]:checked').forEach((cb) => {
      selected.push(cb.value);
    });
    state.contactMethods = selected;
    const otherText = document.getElementById("contact-other-text");
    state.contactOther = otherText ? otherText.value.trim().slice(0, 120) : "";
    const otherWrap = document.getElementById("contact-other-wrap");
    if (otherWrap) {
      otherWrap.classList.toggle("hidden", !selected.includes("Other"));
    }
    saveDraft();
  }

  function clearContactError() {
    const err = document.getElementById("contact-methods-error");
    const fieldset = document.getElementById("contact-methods");
    if (err) err.classList.add("hidden");
    if (fieldset) fieldset.classList.remove("contact-methods-invalid");
  }

  function showContactError(msg) {
    const err = document.getElementById("contact-methods-error");
    const fieldset = document.getElementById("contact-methods");
    if (err) {
      err.textContent = msg;
      err.classList.remove("hidden");
    }
    if (fieldset) {
      fieldset.classList.add("contact-methods-invalid");
      fieldset.classList.remove("shake");
      void fieldset.offsetWidth;
      fieldset.classList.add("shake");
    }
  }

  function validateContactMethods() {
    readContactMethodsFromDOM();
    if (!state.contactMethods.length) {
      showContactError("Select at least one option to continue.");
      return false;
    }
    if (state.contactMethods.includes("Other") && !state.contactOther.trim()) {
      showContactError("Please specify your Other contact method.");
      const otherText = document.getElementById("contact-other-text");
      if (otherText) otherText.classList.add("field-error");
      return false;
    }
    const otherText = document.getElementById("contact-other-text");
    if (otherText) otherText.classList.remove("field-error");
    clearContactError();
    return true;
  }

  function selectedSETR() {
    return state.contactMethods.includes("SETR");
  }

  function renderSetrPartnerCard() {
    const wrap = document.getElementById("setr-partner-content");
    if (!wrap) return;

    if (selectedSETR()) {
      wrap.innerHTML = `
        <div class="partner-chip">Recommended partner</div>
        <h4 class="partner-title">You’re already pointing at SETR</h4>
        <p class="partner-body">Open your recommended partner here to keep working these leads after delivery.</p>
        <a class="btn btn-partner" href="https://setrpro.io" target="_blank" rel="noopener noreferrer">Open SETR (recommended partner)</a>
        <p class="partner-disclaimer">SETR is a separate recommended partner brand, not Lead Reload HQ.</p>
      `;
      return;
    }

    wrap.innerHTML = `
      <div class="partner-chip">Recommended partner</div>
      <h4 class="partner-title">Buying leads is step one. Working them is where most get lost.</h4>
      <p class="partner-body">Most buyers dial a batch 1–2×. Industry data puts most closes well after the first attempt — often touches 5–12 — while nearly half of agents stop after one or two dials. SETR works the batch so you call the warm ones.</p>
      <ul class="partner-stats">
        <li>Only ~2% of sales close on the first contact</li>
        <li>~80% of sales require 5+ follow-up touches</li>
      </ul>
      <a class="btn btn-partner" href="https://setrpro.io" target="_blank" rel="noopener noreferrer">Explore SETR (recommended partner)</a>
      <p class="partner-disclaimer">SETR is a separate recommended partner brand, not Lead Reload HQ. Soft recommendation only.</p>
    `;
  }

  let stripeReady = null; // null=unknown, true/false after probe

  function setPayUiConfigured(configured) {
    stripeReady = !!configured;
    const chip = document.getElementById("pay-status-chip");
    const banner = document.getElementById("pay-offline-banner");
    const btn = document.getElementById("pay-btn");
    const fine = document.getElementById("stripe-fineprint");
    const badge = document.getElementById("secure-badge");
    const desc = document.getElementById("checkout-desc");
    if (chip) {
      chip.textContent = configured
        ? "Secure Stripe checkout"
        : "Payments coming online tonight";
      chip.title = configured
        ? "Stripe Checkout is live"
        : "Stripe keys not connected yet";
    }
    if (banner) banner.hidden = configured;
    if (btn) {
      btn.disabled = !configured;
      if (!configured) {
        btn.innerHTML = "Payments coming online tonight";
      } else {
        btn.innerHTML =
          'Continue to Stripe · <span id="pay-amount">' +
          money(orderTotal()) +
          "</span>";
      }
    }
    if (fine) {
      fine.innerHTML = configured
        ? "You’ll complete payment on Stripe’s hosted checkout. Lead Reload HQ never stores card numbers."
        : "<strong>Payments coming online tonight.</strong> Your cart stays saved — checkout unlocks once Stripe keys are live.";
    }
    if (badge) badge.textContent = configured ? "🔒 Stripe Checkout" : "⏳ Checkout paused";
    if (desc) {
      desc.textContent = configured
        ? "Enter your work email and how you’ll work these leads. You’ll finish on Stripe’s secure checkout."
        : "Stripe is being connected tonight. You can still build your cart — payment unlocks shortly.";
    }
  }

  async function probeStripeConfigured() {
    try {
      const res = await fetch(CHECKOUT_API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ probe: true }),
      });
      const data = await res.json().catch(() => ({}));
      // Missing key → stripe_not_configured; any other response means function is up
      // and key may or may not be present. Treat only explicit not_configured as offline.
      if (data && data.reason === "stripe_not_configured") {
        setPayUiConfigured(false);
        return false;
      }
      // invalid_cart / other validation means Stripe key is present
      if (data && data.reason && data.reason !== "stripe_not_configured") {
        setPayUiConfigured(true);
        return true;
      }
      // Probe reply when keys are live: { ok:true, configured:true } (no url)
      if (data && data.ok && (data.configured === true || data.url)) {
        setPayUiConfigured(true);
        return true;
      }
      setPayUiConfigured(false);
      return false;
    } catch (_) {
      setPayUiConfigured(false);
      return false;
    }
  }

  function showPayError(msg) {
    const el = document.getElementById("pay-error");
    if (!el) return;
    el.textContent = msg || "";
    el.classList.toggle("hidden", !msg);
  }

  async function startCheckout() {
    const email = document.getElementById("pay-email");
    const btn = document.getElementById("pay-btn");
    showPayError("");
    email.classList.remove("field-error");

    if (!email.value.includes("@")) {
      email.classList.add("field-error");
      document.getElementById("stripe-form").classList.remove("shake");
      void document.getElementById("stripe-form").offsetWidth;
      document.getElementById("stripe-form").classList.add("shake");
      return;
    }
    if (!validateContactMethods()) return;

    if (stripeReady === false) {
      showPayError("Payments coming online tonight. Checkout is temporarily paused.");
      return;
    }

    if (Math.round(orderTotal() * 100) < MIN_ORDER_CENTS) {
      showPayError(MIN_ORDER_MSG);
      return;
    }

    readContactMethodsFromDOM();
    const band = getSelectedBand();
    const payload = {
      leadType: state.leadType,
      leadTypeLabel: LEAD_TYPES[state.leadType]
        ? LEAD_TYPES[state.leadType].label
        : state.leadType,
      ageBandId: state.ageBandId,
      ageBandLabel: band ? band.label : "",
      quantity: state.quantity,
      states: state.states.slice(),
      unitPrice: unitPrice(),
      billingCadence: state.billingCadence,
      email: email.value.trim(),
      contactMethods: state.contactMethods.slice(),
      contactOther: state.contactMethods.includes("Other")
        ? state.contactOther
        : "",
    };

    btn.disabled = true;
    const prevHtml = btn.innerHTML;
    btn.textContent = "Connecting to Stripe…";

    try {
      const res = await fetch(CHECKOUT_API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (data && data.reason === "stripe_not_configured") {
        setPayUiConfigured(false);
        showPayError("Payments coming online tonight.");
        btn.disabled = true;
        btn.innerHTML = "Payments coming online tonight";
        return;
      }
      if (!data.ok || !data.url) {
        showPayError(
          data && data.reason === "amount_too_small"
            ? MIN_ORDER_MSG
            : (data && (data.message || data.reason)) ||
                "Could not start checkout. Please try again."
        );
        btn.disabled = false;
        btn.innerHTML = prevHtml;
        return;
      }

      try {
        localStorage.setItem(
          "lead-reload-last-order",
          JSON.stringify(
            Object.assign({}, payload, {
              total: orderTotal(),
              totalLabel: formatCadenceTotal(orderTotal()),
              sessionId: data.sessionId || null,
            })
          )
        );
      } catch (_) {}
      clearDraft();
      window.location.href = data.url;
    } catch (err) {
      showPayError("Network error starting checkout. Please try again.");
      btn.disabled = false;
      btn.innerHTML = prevHtml;
    }
  }

  function handleReturnFromStripe() {
    const params = new URLSearchParams(window.location.search);
    const checkout = params.get("checkout");
    if (!checkout) return;
    if (checkout === "success") {
      state.paid = true;
      state.orderId = params.get("session_id") || "stripe-session";
      const oid = document.getElementById("order-id");
      if (oid) oid.textContent = state.orderId;
      const copy = document.getElementById("success-copy");
      if (copy) {
        copy.textContent =
          "Thank you — Stripe confirmed your checkout. Fulfillment follows your state and age-band selection. Subscriptions renew until canceled in the customer portal.";
      }
      clearDraft();
      showStep(6);
    } else if (checkout === "cancel") {
      showPayError("Checkout canceled — your cart is still here when you’re ready.");
      showStep(6);
    }
    if (window.history && window.history.replaceState) {
      window.history.replaceState({}, "", window.location.pathname);
    }
  }

  function startOver() {
    if (condenseTimer) {
      clearTimeout(condenseTimer);
      condenseTimer = null;
    }

    state.step = 1;
    state.leadType = null;
    state.ageBandId = null;
    state.quantity = 100;
    state.states = [];
    state.billingCadence = "one-time";
    state.contactMethods = [];
    state.contactOther = "";
    state.paid = false;
    state.orderId = null;
    clearDraft();
    resetChromeClasses();

    document.querySelectorAll('input[name="leadType"]').forEach((r) => {
      r.checked = false;
    });
    document.querySelectorAll('input[name="billingCadence"]').forEach((r) => {
      r.checked = r.value === "one-time";
    });
    const qtyInput = document.getElementById("quantity");
    qtyInput.value = 100;
    document.querySelectorAll(".chip-btn[data-qty]").forEach((b) => {
      b.classList.toggle("active", Number(b.dataset.qty) === 100);
    });
    const ageList = document.getElementById("age-band-list");
    if (ageList) ageList.innerHTML = "";
    const search = document.getElementById("state-search");
    if (search) search.value = "";
    document.querySelectorAll(".state-check").forEach((el) => {
      el.classList.remove("filtered-out");
    });

    ["pay-email"].forEach((id) => {
      const el = document.getElementById(id);
      if (el) {
        el.value = "";
        el.classList.remove("field-error");
      }
    });
    showPayError("");
    document.querySelectorAll('input[name="contactMethod"]').forEach((cb) => {
      cb.checked = false;
    });
    const otherText = document.getElementById("contact-other-text");
    if (otherText) {
      otherText.value = "";
      otherText.classList.remove("field-error");
    }
    const otherWrap = document.getElementById("contact-other-wrap");
    if (otherWrap) otherWrap.classList.add("hidden");
    clearContactError();
    const partner = document.getElementById("setr-partner-content");
    if (partner) partner.innerHTML = "";
    document.getElementById("btn-next").classList.remove("hidden");
    document.getElementById("stripe-form").classList.remove("hidden", "shake");
    document.getElementById("success-panel").classList.add("hidden");

    renderStates();
    updatePreview();
    showStep(1);
    window.scrollTo(0, 0);
    resetChromeClasses();
    updateCondenseMode();
  }

  // ——— Init ———
  function init() {
    loadDraft();

    // Billing cadence radios (Review)
    document.querySelectorAll('input[name="billingCadence"]').forEach((input) => {
      if (state.billingCadence === input.value) input.checked = true;
      input.addEventListener("change", () => {
        if (!BILLING_OPTIONS[input.value]) return;
        state.billingCadence = input.value;
        saveDraft();
        updatePreview();
        renderReview();
        updateNav();
      });
    });

    // Lead type radios
    document.querySelectorAll('input[name="leadType"]').forEach((input) => {
      if (state.leadType === input.value) input.checked = true;
      input.addEventListener("change", () => {
        const prevKey = state.leadType
          ? LEAD_TYPES[state.leadType].pricingKey
          : null;
        state.leadType = input.value;
        const newKey = LEAD_TYPES[state.leadType].pricingKey;
        if (prevKey !== newKey) state.ageBandId = null;
        // If same table (life/mp), keep age if still valid
        if (prevKey === newKey && state.ageBandId) {
          const still = getBands().some((b) => b.id === state.ageBandId);
          if (!still) state.ageBandId = null;
        }
        saveDraft();
        updatePreview();
        updateNav();
      });
    });

    // Quantity
    const qtyInput = document.getElementById("quantity");
    qtyInput.value = state.quantity;
    qtyInput.addEventListener("input", () => {
      let v = parseInt(qtyInput.value, 10);
      if (isNaN(v) || v < 1) v = 1;
      if (v > MAX_QTY) v = MAX_QTY;
      state.quantity = v;
      saveDraft();
      updatePreview();
      updateNav();
      document.querySelectorAll(".chip-btn[data-qty]").forEach((b) => {
        b.classList.toggle("active", Number(b.dataset.qty) === v);
      });
    });
    qtyInput.addEventListener("blur", () => {
      qtyInput.value = state.quantity;
    });

    document.getElementById("qty-minus").addEventListener("click", () => {
      state.quantity = Math.max(1, state.quantity - 1);
      qtyInput.value = state.quantity;
      qtyInput.dispatchEvent(new Event("input"));
    });
    document.getElementById("qty-plus").addEventListener("click", () => {
      state.quantity = Math.min(MAX_QTY, state.quantity + 1);
      qtyInput.value = state.quantity;
      qtyInput.dispatchEvent(new Event("input"));
    });

    document.querySelectorAll(".chip-btn[data-qty]").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.quantity = Number(btn.dataset.qty);
        qtyInput.value = state.quantity;
        qtyInput.dispatchEvent(new Event("input"));
      });
      btn.classList.toggle("active", Number(btn.dataset.qty) === state.quantity);
    });

    // States
    renderStates();
    document.getElementById("state-search").addEventListener("input", (e) => {
      const q = e.target.value.trim().toLowerCase();
      document.querySelectorAll(".state-check").forEach((el) => {
        const match =
          !q ||
          el.dataset.code.toLowerCase().includes(q) ||
          el.dataset.name.includes(q);
        el.classList.toggle("filtered-out", !match);
      });
    });
    const expandBtn = document.getElementById("compact-expand");
    if (expandBtn) {
      expandBtn.addEventListener("click", () => {
        const open = document.body.classList.toggle("preview-expanded");
        expandBtn.setAttribute("aria-expanded", open ? "true" : "false");
        expandBtn.textContent = open ? "Hide" : "Details";
      });
    }
    // Scroll no longer toggles condense (that caused Back/start-over glitches).
    // Resize still re-evaluates for mobile/desktop switches on States.
    window.addEventListener("resize", updateCondenseMode);

    document.getElementById("select-all-states").addEventListener("click", () => {
      state.states = US_STATES.map(([c]) => c);
      renderStates();
      saveDraft();
      updatePreview();
      updateNav();
    });
    document.getElementById("clear-states").addEventListener("click", () => {
      state.states = [];
      renderStates();
      saveDraft();
      updatePreview();
      updateNav();
    });

    // Nav
    document.getElementById("btn-next").addEventListener("click", () => {
      if (!validateStep()) return;
      if (state.step < TOTAL_STEPS) showStep(state.step + 1);
    });
    document.getElementById("btn-back").addEventListener("click", () => {
      if (state.step <= 1 || state.paid) return;
      // Leaving States — clear sticky collapse before paint
      if (state.step === 4) resetChromeClasses();
      showStep(state.step - 1);
    });

    // Contact methods (checkout)
    document.querySelectorAll('input[name="contactMethod"]').forEach((cb) => {
      cb.addEventListener("change", () => {
        readContactMethodsFromDOM();
        clearContactError();
        const otherText = document.getElementById("contact-other-text");
        if (otherText) otherText.classList.remove("field-error");
        renderSetrPartnerCard();
        saveDraft();
      });
    });
    const otherInput = document.getElementById("contact-other-text");
    if (otherInput) {
      otherInput.addEventListener("input", () => {
        state.contactOther = otherInput.value.slice(0, 120);
        otherInput.classList.remove("field-error");
        clearContactError();
        saveDraft();
      });
    }
    syncContactUIFromState();

    // Pay (Stripe Checkout)
    document.getElementById("pay-btn").addEventListener("click", startCheckout);
    document.getElementById("start-over").addEventListener("click", startOver);
    setPayUiConfigured(false);
    probeStripeConfigured();
    handleReturnFromStripe();

    // If draft had invalid age for type, clear it
    if (state.leadType && state.ageBandId) {
      if (!getBands().some((b) => b.id === state.ageBandId)) {
        state.ageBandId = null;
      }
    }

    updatePreview();
    showStep(state.step);
    updateCondenseMode();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
