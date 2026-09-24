(function () {
  "use strict";

  const api = (path, opts = {}) =>
    fetch("/.netlify/functions/" + path, {
      credentials: "include",
      headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
      ...opts,
    }).then(async (r) => {
      const data = await r.json().catch(() => ({}));
      return { status: r.status, data };
    });

  const $ = (id) => document.getElementById(id);
  let orders = [];
  let subs = [];
  let selectedId = null;
  let orderFilter = "open";
  let currentUser = null;

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

  function showLogin() {
    $("login-panel").classList.remove("hidden");
    $("dash-panel").classList.add("hidden");
    $("logout-btn").classList.add("hidden");
    setSignedInLabel(null);
  }

  function showDash(user) {
    $("login-panel").classList.add("hidden");
    $("dash-panel").classList.remove("hidden");
    $("logout-btn").classList.remove("hidden");
    setSignedInLabel(user || currentUser || "admin");
    refresh();
  }

  async function checkAuth() {
    const { data } = await api("admin-login", { method: "GET" });
    if (data.authenticated) showDash(data.user);
    else showLogin();
  }

  async function login() {
    const err = $("login-error");
    err.classList.add("hidden");
    const username = ($("username") && $("username").value) || "";
    const password = ($("password") && $("password").value) || "";
    const { data } = await api("admin-login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    });
    if (!data.ok) {
      err.textContent =
        data.reason === "admin_not_configured"
          ? "Admin passwords are not set on this site yet."
          : "Invalid username or password.";
      err.classList.remove("hidden");
      return;
    }
    if ($("password")) $("password").value = "";
    showDash(data.user);
  }

  async function logout() {
    await api("admin-logout", { method: "POST", body: "{}" });
    if ($("username")) $("username").value = "";
    if ($("password")) $("password").value = "";
    showLogin();
  }

  async function refresh() {
    const [o, s] = await Promise.all([
      api("admin-orders"),
      api("admin-subscriptions"),
    ]);
    if (o.status === 401 || s.status === 401) {
      showLogin();
      return;
    }
    orders = (o.data && o.data.orders) || [];
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
    }
  }

  function renderOrders() {
    const list = $("orders-list");
    const filtered =
      orderFilter === "all"
        ? orders
        : orders.filter((o) => (o.status || "open") === orderFilter);
    if (!filtered.length) {
      list.innerHTML =
        '<div class="empty">No orders yet. When Stripe goes live, checkout.session.completed will land here.</div>';
      return;
    }
    list.innerHTML = filtered
      .map((o) => {
        const meta = o.metadata || {};
        return `<button type="button" class="row ${
          selectedId === o.id ? "active" : ""
        }" data-kind="order" data-id="${escapeHtml(o.id)}">
          <div class="row-top">
            <strong>${escapeHtml(o.email || "Order")}</strong>
            <span class="badge ${escapeHtml(o.status || "open")}">${escapeHtml(
              o.status || "open"
            )}</span>
          </div>
          <div class="meta">${escapeHtml(
            meta.leadTypeLabel || meta.leadType || "—"
          )} · qty ${escapeHtml(
            String(o.qty || meta.quantity || "—")
          )} · ${money(o.amountTotal, o.currency)} · ${escapeHtml(
            (o.paidAt || "").slice(0, 19).replace("T", " ")
          )}</div>
        </button>`;
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
    const meta = record.metadata || {};
    const contact = record.contact || {};
    const rows = [
      ["Type", kind === "order" ? "One-time order" : "Subscription"],
      ["Status", record.status || "—"],
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
        kind === "order" ? "Payment intent" : "Subscription id",
        kind === "order"
          ? record.stripePaymentIntentId || "—"
          : record.stripeSubscriptionId || record.id,
      ],
    ];
    if (kind === "order" && record.amountTotal != null) {
      rows.splice(5, 0, ["Amount", money(record.amountTotal, record.currency)]);
    }
    panel.classList.remove("hidden");
    panel.innerHTML =
      "<h2>Detail</h2><dl>" +
      rows
        .map(
          ([k, v]) =>
            `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(String(v))}</dd>`
        )
        .join("") +
      "</dl>" +
      (kind === "order"
        ? `<button type="button" class="btn primary" id="fulfill-btn" data-id="${escapeHtml(
            record.id
          )}" data-next="${
            (record.status || "open") === "fulfilled" ? "open" : "fulfilled"
          }">${
            (record.status || "open") === "fulfilled"
              ? "Reopen order"
              : "Mark fulfilled"
          }</button>`
        : "");
    renderOrders();
    renderSubs();
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

  document.querySelectorAll('input[name="orderFilter"]').forEach((r) => {
    r.addEventListener("change", () => {
      orderFilter = r.value;
      renderOrders();
    });
  });

  $("orders-list").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-id]");
    if (!btn) return;
    showDetail(btn.dataset.kind, btn.dataset.id);
  });
  $("subs-list").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-id]");
    if (!btn) return;
    showDetail(btn.dataset.kind, btn.dataset.id);
  });

  $("detail").addEventListener("click", async (e) => {
    const btn = e.target.closest("#fulfill-btn");
    if (!btn) return;
    btn.disabled = true;
    const { data } = await api("admin-fulfill", {
      method: "POST",
      body: JSON.stringify({
        orderId: btn.dataset.id,
        status: btn.dataset.next,
      }),
    });
    btn.disabled = false;
    if (data.ok) {
      await refresh();
      showDetail("order", btn.dataset.id);
    }
  });

  $("login-btn").addEventListener("click", login);
  ["username", "password"].forEach((id) => {
    const el = $(id);
    if (!el) return;
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter") login();
    });
  });
  $("logout-btn").addEventListener("click", logout);
  $("refresh-btn").addEventListener("click", refresh);

  checkAuth();
})();
