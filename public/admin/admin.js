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

  async function refresh() {
    const [o, s] = await Promise.all([
      api("admin-orders"),
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
