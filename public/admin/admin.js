(function () {
  "use strict";

  // Netlify Identity widget (loaded in index.html). Admin functions read the
  // signed-in user from the Bearer JWT; see netlify/functions/lib/auth.js.
  const ni = window.netlifyIdentity || null;

  async function authHeader() {
    const user = ni && ni.currentUser && ni.currentUser();
    if (!user) return {};
    try {
      const token = await user.jwt(); // refreshes an expired token
      return token ? { Authorization: "Bearer " + token } : {};
    } catch (_) {
      return {};
    }
  }

  const api = async (path, opts = {}) => {
    const { headers: extra, ...rest } = opts;
    const r = await fetch("/.netlify/functions/" + path, {
      cache: "no-store",
      ...rest,
      headers: {
        "Content-Type": "application/json",
        ...(await authHeader()),
        ...(extra || {}),
      },
    });
    const data = await r.json().catch(() => ({}));
    return { status: r.status, data };
  };

  const $ = (id) => document.getElementById(id);
  const V = window.LRAdminOrders; // public/admin/orders-view.js
  let orders = [];
  let subs = [];
  let counts = null;
  let selectedId = null;
  let statusFilter = "open"; // open | completed | all
  let typeFilter = "all"; // all | one-time | subscription
  let currentUser = null;
  let toastTimer = null;

  function money(cents, currency) {
    if (cents == null) return "—";
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: (currency || "usd").toUpperCase(),
    }).format(Number(cents) / 100);
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function when(iso) {
    if (!iso) return "—";
    const d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    return d.toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  }

  function day(iso) {
    if (!iso) return "—";
    const d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  }

  // cs_test_a1c40fVtMoHH…qSRuDD — full id stays in the title, detail and CSV.
  function shortId(id) {
    const s = String(id || "");
    return s.length > 24 ? s.slice(0, 16) + "…" + s.slice(-6) : s;
  }

  function idChip(label, id) {
    if (!id) return "";
    return `<span class="id-chip" title="${escapeHtml(id)}"><span class="id-label">${escapeHtml(
      label
    )}</span> <code class="id-full">${escapeHtml(id)}</code><code class="id-short">${escapeHtml(
      shortId(id)
    )}</code></span>`;
  }

  const STATUS_CLASS = {
    New: "st-new",
    "In progress": "st-progress",
    Completed: "st-done",
  };

  function toast(message, isError) {
    const el = $("orders-toast");
    if (!el) return;
    el.textContent = message;
    el.classList.toggle("error", !!isError);
    el.classList.remove("hidden");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add("hidden"), 4000);
  }

  function setSignedInLabel(user) {
    currentUser = user || null;
    const el = $("signed-in");
    if (!el) return;
    if (user) {
      el.textContent = user;
      el.classList.remove("hidden");
    } else {
      el.textContent = "";
      el.classList.add("hidden");
    }
  }

  function hidePanels() {
    $("login-panel").classList.add("hidden");
    $("denied-panel").classList.add("hidden");
    $("dash-panel").classList.add("hidden");
  }

  function showLogin(message) {
    hidePanels();
    $("login-panel").classList.remove("hidden");
    $("logout-btn").classList.add("hidden");
    setSignedInLabel(null);
    const err = $("login-error");
    if (message) {
      err.textContent = message;
      err.classList.remove("hidden");
    } else {
      err.textContent = "";
      err.classList.add("hidden");
    }
  }

  function showDenied(email) {
    hidePanels();
    $("denied-panel").classList.remove("hidden");
    $("denied-email").textContent = email || "this account";
    $("logout-btn").classList.remove("hidden");
    setSignedInLabel(email || null);
  }

  function showDash(email) {
    hidePanels();
    $("dash-panel").classList.remove("hidden");
    $("logout-btn").classList.remove("hidden");
    setSignedInLabel(email || currentUser || "admin");
    refresh();
  }

  // Ask the server whether this Identity user is an allowlisted admin.
  async function checkAccess() {
    const user = ni && ni.currentUser && ni.currentUser();
    if (!user) {
      showLogin();
      return;
    }
    const { status, data } = await api("admin-me", { method: "GET" });
    if (status === 200 && data.ok) showDash(data.email);
    else if (status === 403) showDenied(user.email);
    else showLogin("Your session expired. Please sign in again.");
  }

  function login() {
    if (!ni) {
      showLogin(
        "Sign-in is unavailable: the Netlify Identity widget did not load. Reload the page; if it persists, Identity is not enabled on this site."
      );
      return;
    }
    ni.open("login");
  }

  function logout() {
    if (ni && ni.currentUser && ni.currentUser()) ni.logout();
    else showLogin();
  }

  function ordersPath() {
    return (
      "admin-orders?status=" +
      encodeURIComponent(statusFilter) +
      "&type=" +
      encodeURIComponent(typeFilter)
    );
  }

  function authFailed(res) {
    if (res.status === 401) {
      showLogin("Your session expired. Please sign in again.");
      return true;
    }
    if (res.status === 403) {
      showDenied(currentUser);
      return true;
    }
    return false;
  }

  async function refresh() {
    const [o, s] = await Promise.all([
      api(ordersPath()),
      api("admin-subscriptions"),
    ]);
    if (o.status === 401 || s.status === 401) {
      showLogin("Your session expired. Please sign in again.");
      return;
    }
    if (o.status === 403 || s.status === 403) {
      showDenied(currentUser);
      return;
    }
    orders = (o.data && o.data.orders) || [];
    counts = (o.data && o.data.counts) || null;
    subs = (s.data && s.data.subscriptions) || [];
    renderOrders();
    renderSubs();
    if (selectedId) {
      const kind = orders.some((x) => x.id === selectedId)
        ? "order"
        : subs.some((x) => x.id === selectedId)
        ? "sub"
        : null;
      if (kind) showDetail(kind, selectedId);
      else hideDetail();
    }
  }

  async function loadOrders() {
    const o = await api(ordersPath());
    if (authFailed(o)) return;
    if (o.status !== 200 || !o.data.ok) {
      toast("Could not load orders (" + (o.data.reason || o.status) + ").", true);
      return;
    }
    orders = o.data.orders || [];
    counts = o.data.counts || null;
    renderOrders();
    if (selectedId && !orders.some((x) => x.id === selectedId)) {
      const panel = $("detail");
      if (panel.dataset.kind === "order") hideDetail();
    } else if (selectedId && $("detail").dataset.kind === "order") {
      showDetail("order", selectedId);
    }
  }

  function renderCounts() {
    for (const k of ["open", "completed", "all"]) {
      const el = $("count-" + k);
      if (el) el.textContent = counts && counts[k] != null ? String(counts[k]) : "";
    }
  }

  function actionButtons(o) {
    const id = escapeHtml(o.id);
    const st = o.fulfillmentStatus;
    if (st === "Completed") {
      return `<button type="button" class="btn ghost sm" data-act="reopen" data-id="${id}">Reopen</button>`;
    }
    return (
      `<button type="button" class="btn primary sm" data-act="complete" data-id="${id}">Mark completed</button>` +
      (st === "New"
        ? `<button type="button" class="btn ghost sm" data-act="start" data-id="${id}">In progress</button>`
        : `<button type="button" class="btn ghost sm" data-act="reopen" data-id="${id}">Back to New</button>`)
    );
  }

  function emptyMessage() {
    if (counts && counts.all > 0) {
      return statusFilter === "open"
        ? "Nothing open. Every order in this view is completed."
        : "No orders match these filters.";
    }
    return "No orders yet. Paid checkouts and subscription renewals land here from Stripe webhooks.";
  }

  function renderOrders() {
    const list = $("orders-list");
    renderCounts();
    if (!orders.length) {
      list.innerHTML = `<div class="empty">${escapeHtml(emptyMessage())}</div>`;
      return;
    }
    list.innerHTML = orders
      .map((o) => {
        const st = o.fulfillmentStatus || "New";
        const bits = [
          V.leadTypeLabel(o),
          V.ageBandLabel(o),
          V.quantity(o) ? Number(V.quantity(o)).toLocaleString("en-US") + " leads" : "",
        ].filter(Boolean);
        const states = V.states(o);
        const period =
          o.kind === "renewal" && o.periodStart
            ? ` · period ${day(o.periodStart)} → ${day(o.periodEnd)}`
            : "";
        const done =
          st === "Completed"
            ? `<div class="done-line">Completed ${escapeHtml(when(o.completedAt))}${
                o.completedBy ? " by " + escapeHtml(o.completedBy) : ""
              }</div>`
            : st === "In progress" && o.statusUpdatedBy
            ? `<div class="done-line progress">Started ${escapeHtml(
                when(o.statusUpdatedAt)
              )} by ${escapeHtml(o.statusUpdatedBy)}</div>`
            : "";
        return `<article class="row order-row ${
          selectedId === o.id ? "active" : ""
        }" data-order-id="${escapeHtml(o.id)}">
          <div class="order-info">
          <div class="row-top">
            <strong class="row-email">${escapeHtml(o.email || "Order")}</strong>
            <span class="badge ${STATUS_CLASS[st] || "st-new"}">${escapeHtml(st)}</span>
          </div>
          <div class="order-line">
            <span class="amount">${money(o.amountTotal, o.currency)}</span>
            <span class="kind-pill kind-${escapeHtml(o.kind || "one-time")}">${escapeHtml(
              V.cadenceLabel(o)
            )}</span>
            <span class="meta">${escapeHtml(when(o.paidAt))}</span>
          </div>
          <div class="meta">${escapeHtml(bits.join(" · ") || "—")}</div>
          <div class="meta states">States: ${escapeHtml(states || "—")}${escapeHtml(period)}</div>
          <div class="ids">${idChip("Session", o.stripeSessionId)}${idChip(
            "PI",
            o.stripePaymentIntentId
          )}${idChip("Invoice", o.stripeInvoiceId)}</div>
          ${done}
          </div>
          <div class="row-actions">
            ${actionButtons(o)}
            <button type="button" class="btn ghost sm" data-kind="order" data-id="${escapeHtml(
              o.id
            )}">Details</button>
          </div>
        </article>`;
      })
      .join("");
  }

  function renderSubs() {
    const list = $("subs-list");
    if (!subs.length) {
      list.innerHTML =
        '<div class="empty">No subscriptions yet. Weekly/monthly checkouts appear after Stripe webhooks fire.</div>';
      return;
    }
    list.innerHTML = subs
      .map((s) => {
        const meta = s.metadata || {};
        return `<button type="button" class="row ${
          selectedId === s.id ? "active" : ""
        }" data-kind="sub" data-id="${escapeHtml(s.id)}">
          <div class="row-top">
            <strong>${escapeHtml(
              s.email || s.stripeCustomerId || s.id
            )}</strong>
            <span class="badge ${escapeHtml(s.status || "active")}">${escapeHtml(
              s.status || "active"
            )}</span>
          </div>
          <div class="meta">${escapeHtml(
            s.billingCadence || meta.billingCadence || "—"
          )} · qty ${escapeHtml(
            String(s.qty || meta.quantity || "—")
          )} · ${escapeHtml(
            meta.leadTypeLabel || meta.leadType || ""
          )}</div>
        </button>`;
      })
      .join("");
  }

  function hideDetail() {
    selectedId = null;
    const panel = $("detail");
    panel.classList.add("hidden");
    panel.dataset.kind = "";
    renderOrders();
    renderSubs();
  }

  function showDetail(kind, id) {
    selectedId = id;
    const panel = $("detail");
    const record =
      kind === "order"
        ? orders.find((o) => o.id === id)
        : subs.find((s) => s.id === id);
    if (!record) {
      panel.classList.add("hidden");
      return;
    }
    panel.dataset.kind = kind;
    const meta = record.metadata || {};
    const contact = record.contact || {};
    const isOrder = kind === "order";
    const rows = [
      ["Type", isOrder ? V.cadenceLabel(record) : "Subscription"],
      ["Status", isOrder ? record.fulfillmentStatus || "New" : record.status || "—"],
      ["Email", record.email || contact.email || "—"],
      ["Qty", record.qty || meta.quantity || "—"],
      ["Cadence", record.billingCadence || meta.billingCadence || "—"],
      ["Lead type", meta.leadTypeLabel || meta.leadType || "—"],
      ["Age band", meta.ageBandLabel || meta.ageBandId || "—"],
      ["States", meta.states || "—"],
      ["Unit price", meta.unitPrice != null ? "$" + meta.unitPrice : "—"],
      ["Paid at", record.paidAt || "—"],
      [
        "Contact methods",
        (contact.methods || []).join(", ") || meta.contactMethods || "—",
      ],
      ["Contact other", contact.other || meta.contactOther || "—"],
      ["Stripe session", record.stripeSessionId || "—"],
      ["Stripe customer", record.stripeCustomerId || "—"],
      [
        isOrder ? "Payment intent" : "Subscription id",
        isOrder
          ? record.stripePaymentIntentId || "—"
          : record.stripeSubscriptionId || record.id,
      ],
    ];
    if (isOrder) {
      rows.push(
        ["Invoice", record.stripeInvoiceId || "—"],
        ["Subscription id", record.stripeSubscriptionId || "—"]
      );
      if (record.kind === "renewal") {
        rows.push(
          ["Billing reason", record.billingReason || "—"],
          ["Period", (record.periodStart || "—") + " → " + (record.periodEnd || "—")]
        );
      }
      rows.push(
        ["Completed at", record.completedAt || "—"],
        ["Completed by", record.completedBy || "—"],
        ["Status updated", record.statusUpdatedAt || "—"],
        ["Status updated by", record.statusUpdatedBy || "—"]
      );
    }
    if (isOrder && record.amountTotal != null) {
      rows.splice(5, 0, ["Amount", money(record.amountTotal, record.currency)]);
    }
    const st = record.fulfillmentStatus || "New";
    panel.classList.remove("hidden");
    panel.innerHTML =
      '<div class="detail-head"><h2>Detail</h2><button type="button" class="btn ghost sm" id="detail-close">Close</button></div><dl>' +
      rows
        .map(
          ([k, v]) =>
            `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(String(v))}</dd>`
        )
        .join("") +
      "</dl>" +
      (isOrder
        ? `<div class="status-set" role="group" aria-label="Set fulfillment status">${[
            ["New", "reopen"],
            ["In progress", "start"],
            ["Completed", "complete"],
          ]
            .map(
              ([label, act]) =>
                `<button type="button" class="btn sm ${
                  st === label ? "primary" : "ghost"
                }" data-act="${act}" data-id="${escapeHtml(record.id)}" ${
                  st === label ? 'aria-pressed="true" disabled' : 'aria-pressed="false"'
                }>${label === "Completed" ? "Mark completed" : label}</button>`
            )
            .join("")}</div>`
        : "");
    renderOrders();
    renderSubs();
  }

  async function setStatus(orderId, act, btn) {
    if (btn) btn.disabled = true;
    const res = await api("admin-fulfill", {
      method: "POST",
      body: JSON.stringify({ orderId, action: act }),
    });
    if (authFailed(res)) return;
    if (res.status !== 200 || !res.data.ok) {
      if (btn) btn.disabled = false;
      toast("Update failed (" + (res.data.reason || res.status) + ").", true);
      return;
    }
    const o = res.data.order || {};
    toast(
      (o.email ? o.email + ": " : "") +
        (o.fulfillmentStatus === "Completed"
          ? "marked completed."
          : "set to " + o.fulfillmentStatus + ".")
    );
    await loadOrders();
  }

  function exportCsv() {
    const csv = V.toCsv(orders);
    const blob = new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const day = new Date().toISOString().slice(0, 10);
    a.href = url;
    a.download = `lead-reload-orders-${statusFilter}-${typeFilter}-${day}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast(`Exported ${orders.length} row${orders.length === 1 ? "" : "s"}.`);
  }

  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document
        .querySelectorAll(".tab")
        .forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      const isOrders = tab.dataset.tab === "orders";
      $("orders-view").classList.toggle("hidden", !isOrders);
      $("subs-view").classList.toggle("hidden", isOrders);
    });
  });

  function segSelect(groupId, attr, value) {
    $(groupId)
      .querySelectorAll(".seg-btn")
      .forEach((b) => {
        const on = b.dataset[attr] === value;
        b.classList.toggle("active", on);
        b.setAttribute("aria-pressed", on ? "true" : "false");
      });
  }

  $("status-filter").addEventListener("click", (e) => {
    const b = e.target.closest(".seg-btn");
    if (!b || b.dataset.status === statusFilter) return;
    statusFilter = b.dataset.status;
    segSelect("status-filter", "status", statusFilter);
    loadOrders();
  });
  $("type-filter").addEventListener("click", (e) => {
    const b = e.target.closest(".seg-btn");
    if (!b || b.dataset.type === typeFilter) return;
    typeFilter = b.dataset.type;
    segSelect("type-filter", "type", typeFilter);
    loadOrders();
  });
  $("export-btn").addEventListener("click", exportCsv);

  $("orders-list").addEventListener("click", (e) => {
    const act = e.target.closest("[data-act]");
    if (act) {
      setStatus(act.dataset.id, act.dataset.act, act);
      return;
    }
    const btn = e.target.closest("[data-kind][data-id]");
    if (!btn) return;
    showDetail(btn.dataset.kind, btn.dataset.id);
    if (window.matchMedia("(max-width: 640px)").matches) {
      $("detail").scrollIntoView({ behavior: "smooth", block: "start" });
    }
  });
  $("subs-list").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-id]");
    if (!btn) return;
    showDetail(btn.dataset.kind, btn.dataset.id);
  });

  $("detail").addEventListener("click", async (e) => {
    if (e.target.closest("#detail-close")) {
      hideDetail();
      return;
    }
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    await setStatus(btn.dataset.id, btn.dataset.act, btn);
  });

  $("login-btn").addEventListener("click", login);
  $("logout-btn").addEventListener("click", logout);
  $("denied-logout-btn").addEventListener("click", logout);
  $("refresh-btn").addEventListener("click", refresh);

  if (!ni) {
    showLogin(
      "Sign-in is unavailable: the Netlify Identity widget did not load. Reload the page; if it persists, Identity is not enabled on this site."
    );
    return;
  }

  // The widget initialises itself on DOMContentLoaded (this script runs
  // before that) and handles #invite_token= / #recovery_token= /
  // #confirmation_token= / #email_change_token= on its own: it opens the
  // set-password / reset-password screen, then fires "login". The site root
  // forwards those links here (public/identity-redirect.js).
  ni.on("init", (user) => {
    if (user) checkAccess();
    else showLogin();
  });
  ni.on("login", () => {
    ni.close();
    checkAccess();
  });
  ni.on("logout", () => showLogin());
  ni.on("error", (err) => console.warn("Netlify Identity error", err));
})();
