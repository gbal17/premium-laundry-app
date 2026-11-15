/* Premium Laundry - PWA client (v0.5.0 TEST: reliable saving, duplicate warnings, corrections, balance checks)
 * - Two separate environments: TEST (practice ledger, /test/) and LIVE (official ledger, root).
 *   The environment shown comes from the SERVER (its LEDGER_MODE); if it does not match this
 *   app's configured environment, the app refuses to work.
 * - Sign in with Google (ID token kept in memory + sessionStorage only for this tab session).
 * - Every API call sends the token; the server verifies it with Google.
 * - Writes carry a one-time requestId so double taps / resends never duplicate.
 * - Every write is kept on this phone BEFORE it is sent and removed only when the server confirms
 *   it. Anything not confirmed (no internet, phone locked, server interrupted) is resent with the
 *   SAME requestId, so the server finishes it and never saves it twice.
 * - Records are never deleted: mistakes are cancelled or corrected (server keeps the original).
 * No financial data is written to the console.
 */
(function () {
  "use strict";
  const CFG = window.PL_CONFIG;
  const $ = s => document.querySelector(s);
  const view = $("#view");
  const ENV = CFG.env === "LIVE" ? "LIVE" : "TEST";
  const ENV_TEXT = { TEST: "TEST – practice only. Fake data, not real business money.", LIVE: "LIVE – official business records" };
  const state = { token: null, tokenExp: 0, me: null, period: "today", custom: null, customers: [], sending: false };

  // ------------------------------------------------------------ utilities
  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const money = n => (n == null || isNaN(n)) ? "—" : "D" + Number(n).toLocaleString("en-GB", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  const ymd = d => new Intl.DateTimeFormat("en-CA", { timeZone: CFG.timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  const today = () => ymd(new Date());
  const addDays = (s, n) => { const d = new Date(s + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const niceDate = s => s ? new Date(s + "T12:00:00Z").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : "No date";
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + "-" + Math.random().toString(16).slice(2));
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage unavailable */ } }
  };
  let toastTimer;
  function toast(msg, bad) {
    const t = $("#toast"); t.textContent = msg; t.className = "toast" + (bad ? " bad" : "");
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.className = "toast hidden", bad ? 6000 : 3500);
  }

  // ------------------------------------------------------------ environment indicator
  function paintEnv() {
    document.body.classList.toggle("env-test", ENV === "TEST");
    document.body.classList.toggle("env-live", ENV === "LIVE");
    $("#envPill").textContent = ENV;
    const b = $("#modeBanner");
    b.textContent = CFG.apiUrl ? ENV_TEXT[ENV] : "LIVE app not switched on yet";
    b.className = "banner " + (ENV === "TEST" ? "test" : CFG.apiUrl ? "live" : "warn");
    document.title = (ENV === "TEST" ? "TEST – " : "") + "Premium Laundry";
  }

  // ------------------------------------------------------------ sign-in
  function decodeExp(token) {
    try { return JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))).exp * 1000; } catch (e) { return 0; }
  }
  function onCredential(resp) {
    state.token = resp.credential; state.tokenExp = decodeExp(resp.credential);
    try { sessionStorage.setItem("pl_t", state.token); } catch (e) { }
    boot();
  }
  function tokenValid() { return state.token && Date.now() < state.tokenExp - 60000; }
  function showSignIn(message) {
    $("#tabbar").classList.add("hidden"); $("#who").textContent = "";
    view.innerHTML = `<section class="card center">
      <h1>Premium Laundry &amp; Garment Care</h1>
      <p class="envline ${ENV === "TEST" ? "test" : "live"}">${esc(ENV_TEXT[ENV])}</p>
      <p>Sign in with Mariama's Google account to see today's money and record transactions.</p>
      <div id="gsiButton"></div>
      ${message ? `<p class="error">${esc(message)}</p>` : ""}
      <p class="muted">Only authorised accounts can open the business records.</p></section>`;
    const render = () => {
      if (!window.google || !google.accounts || !google.accounts.id) return setTimeout(render, 300);
      google.accounts.id.initialize({ client_id: CFG.googleClientId, callback: onCredential, auto_select: true, cancel_on_tap_outside: false });
      google.accounts.id.renderButton($("#gsiButton"), { theme: "filled_blue", size: "large", text: "signin_with", shape: "pill", width: 280 });
      google.accounts.id.prompt();
    };
    render();
  }
  function signOut() {
    state.token = null; state.tokenExp = 0; state.me = null;
    try { sessionStorage.removeItem("pl_t"); } catch (e) { }
    if (window.google && google.accounts && google.accounts.id) google.accounts.id.disableAutoSelect();
    showSignIn("You have signed out.");
  }

  // ------------------------------------------------------------ API
  async function api(action, data, requestId) {
    if (!tokenValid()) { showSignIn("Your session has ended. Please sign in again."); throw new Error("signin"); }
    const body = JSON.stringify({ action, data: data || {}, idToken: state.token, requestId: requestId || "" });
    let json;
    const ctl = window.AbortController ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), 60000) : null;
    try {
      const res = await fetch(CFG.apiUrl, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" }, body, redirect: "follow", cache: "no-store", signal: ctl ? ctl.signal : undefined });
      json = await res.json();
    } catch (err) { const e = new Error("Could not reach the server."); e.retry = true; throw e; }   // no internet, timeout, or not JSON
    finally { if (timer) clearTimeout(timer); }
    if (!json.ok && (json.code === 401)) { showSignIn(json.error); throw new Error("signin"); }
    if (!json.ok && json.code === 403) { showSignIn(json.error); throw new Error("forbidden"); }
    if (!json.ok) {
      const e = new Error(json.error || "Request failed");
      if (json.code === 422 || json.code === 400) e.user = true;      // nothing saved: the person must change something
      else { e.retry = true; e.interrupted = !!json.interrupted; }    // not finished: safe to resend the same request
      throw e;
    }
    return json;
  }

  // Writes are kept on this phone until the server confirms them ("write-ahead").
  const QKEY = "pl_queue_v1_" + ENV;      // waiting to be confirmed (TEST and LIVE never share)
  const AKEY = "pl_attention_v1_" + ENV;  // the server answered "please decide" (possible duplicate, invalid)
  const inflight = new Set();
  function queue() { return store.get(QKEY, []); }
  function attention() { return store.get(AKEY, []); }
  function qAdd(item) { const q = queue(); q.push(item); store.set(QKEY, q); }
  function qRemove(id) { store.set(QKEY, queue().filter(x => x.requestId !== id)); }
  function aAdd(item) { const a = attention().filter(x => x.requestId !== item.requestId); a.push(item); store.set(AKEY, a); }
  function aRemove(id) { store.set(AKEY, attention().filter(x => x.requestId !== id)); }
  const QUEUED_MSG = "Not confirmed yet. It is kept on this phone and will be sent automatically – do not enter it again.";
  function custName(id) { const c = (state.customers || []).find(x => x.id === id); return c ? c.name : ""; }
  function describe(action, d) {
    d = d || {};
    if (action === "charge.create") return "Bill " + money(d.amount) + (Number(d.paidNow) > 0 ? ", paid " + money(d.paidNow) : "") + " – " + custName(d.customerId);
    if (action === "payment.create") return "Payment " + money(d.amount) + " – " + custName(d.customerId);
    if (action === "expense.create") return "Expense " + money(d.amount) + " – " + (d.category || "");
    if (action === "customers.create") return "New customer " + (d.name || "");
    if (action === "record.void") return "Cancel " + (d.label || d.txnId);
    if (action === "record.correct") return "Correction of " + (d.label || d.txnId);
    if (action === "record.assign") return "Link " + d.txnId + " to " + custName(d.customerId);
    if (action === "recovery.finish") return "Finish an interrupted save";
    return action;
  }
  function updateQueueBanner() {
    const n = queue().length, a = attention().length, b = $("#queueBanner");
    if (!n && !a) { b.classList.add("hidden"); return; }
    b.innerHTML = (n ? esc(n + " record(s) not confirmed yet – kept on this phone and sent automatically. ") : "") +
      (a ? "<b>" + esc(a + " record(s) need your decision. ") + "</b>" : "") + "<u>Open</u>";
    b.classList.remove("hidden");
  }
  async function write(action, data) {
    const item = { action, data, requestId: uuid(), at: Date.now(), label: describe(action, data) };
    qAdd(item); inflight.add(item.requestId); updateQueueBanner();
    try {
      const r = await api(action, data, item.requestId);
      qRemove(item.requestId);                 // saved, already saved, or "please confirm" (nothing saved)
      return r;
    } catch (e) {
      if (e.user) { qRemove(item.requestId); throw e; }               // not saved: shown on the screen
      if (e.message === "signin" || e.message === "forbidden") throw e; // kept: sent after signing in
      return { ok: true, queued: true, interrupted: !!e.interrupted };
    } finally { inflight.delete(item.requestId); updateQueueBanner(); }
  }
  async function flushQueue() {
    if (state.sending || !tokenValid() || !state.me) return;
    state.sending = true;
    try {
      for (const item of queue()) {
        if (inflight.has(item.requestId)) continue;
        inflight.add(item.requestId);
        try {
          const r = await api(item.action, item.data, item.requestId);
          qRemove(item.requestId);
          if (r.data && r.data.needsConfirmation) { aAdd(Object.assign({}, item, { reason: r.data.reason, existing: r.data.existing || null, matches: r.data.matches || null })); toast("A record waiting on this phone needs your decision.", true); }
          else toast("Sent and saved: " + item.label);
        } catch (e) {
          if (e.user) { qRemove(item.requestId); aAdd(Object.assign({}, item, { reason: "refused", error: e.message })); toast("A record could not be saved: " + e.message, true); }
          else break;                          // still no connection: try again later
        } finally { inflight.delete(item.requestId); }
      }
    } finally { state.sending = false; updateQueueBanner(); }
  }
  setInterval(() => { if (queue().length && navigator.onLine !== false) flushQueue(); }, 30000);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") flushQueue(); });
  window.addEventListener("online", flushQueue);

  // ------------------------------------------------------------ boot & navigation
  async function boot() {
    if (!tokenValid()) {
      try { const t = sessionStorage.getItem("pl_t"); if (t) { state.token = t; state.tokenExp = decodeExp(t); } } catch (e) { }
      if (!tokenValid()) return showSignIn();
    }
    try {
      view.innerHTML = `<section class="card center"><p>Opening your records…</p></section>`;
      const r = await api("bootstrap");
      if (r.data.mode !== ENV) {   // safety: app and ledger must be the same environment
        state.me = null; $("#tabbar").classList.add("hidden");
        view.innerHTML = `<section class="card"><h2>Stop – wrong ledger</h2><p class="error">This ${esc(ENV)} app is connected to a ${esc(r.data.mode)} ledger. Nothing can be saved. Please contact Giuseppe.</p></section>`;
        return;
      }
      state.me = r.data;
      $("#who").textContent = state.me.email + " · " + state.me.role;
      $("#tabbar").classList.remove("hidden");
      updateQueueBanner(); flushQueue();
      route(location.hash.slice(1) || "home");
    } catch (e) {
      if (e.message !== "signin" && e.message !== "forbidden") view.innerHTML = `<section class="card"><p class="error">Could not connect. Check the internet and try again.</p><button class="btn" id="retry">Try again</button></section>`, $("#retry").onclick = boot;
    }
  }
  function setTab(name) { document.querySelectorAll("#tabbar button").forEach(b => b.classList.toggle("active", b.dataset.nav === name)); }
  function route(name) {
    if (location.hash.slice(1) !== name) history.replaceState(null, "", "#" + name);
    const [page, arg] = name.split(":");
    window.scrollTo(0, 0);
    if (state.correcting && page !== state.correcting.kind) state.correcting = null;   // leaving a correction cancels it
    if (page === "home") { setTab("home"); return renderHome(); }
    if (page === "customers") { setTab("customers"); return renderCustomers(); }
    if (page === "customer") { setTab("customers"); return renderCustomer(arg); }
    if (page === "newcustomer") { setTab("customers"); return renderNewCustomer(); }
    if (page === "charge") { setTab("home"); return renderCharge(arg); }
    if (page === "payment") { setTab("home"); return renderPayment(arg); }
    if (page === "expense") { setTab("home"); return renderExpense(); }
    if (page === "more") { setTab("more"); return renderMore(); }
    if (page === "voice") { setTab("home"); return renderVoice(); }
    if (page === "fix") { setTab("home"); return renderFix(); }
    if (page === "record") { setTab("home"); return renderRecord(arg); }
    if (page === "cancel") { setTab("home"); return renderReason(arg, "cancel"); }
    if (page === "correct") { setTab("home"); return renderReason(arg, "correct"); }
    if (page === "check") { setTab("more"); return renderCheck(); }
    if (page === "pending") { setTab("home"); return renderPending(); }
    renderHome();
  }
  window.addEventListener("hashchange", () => { if (state.me) route(location.hash.slice(1) || "home"); });
  document.addEventListener("click", e => {
    const nav = e.target.closest("[data-nav]");
    if (nav) { e.preventDefault(); route(nav.dataset.nav); }
  });

  // ------------------------------------------------------------ dashboard
  function periodRange(p) {
    const t = today();
    if (p === "today") return [t, t, "Today"];
    if (p === "yesterday") { const y = addDays(t, -1); return [y, y, "Yesterday"]; }
    if (p === "week") { const d = new Date(t + "T12:00:00Z"); const dow = (d.getUTCDay() + 6) % 7; return [addDays(t, -dow), t, "This week"]; }
    if (p === "month") return [t.slice(0, 8) + "01", t, "This month"];
    if (p === "custom" && state.custom) return [state.custom[0], state.custom[1], "Custom"];
    return [t, t, "Today"];
  }
  const ACTIONS_HTML = `<div class="actions">
        <button class="big voice" data-nav="voice">🎤 Speak a transaction<small>Say it, check it, then save</small></button>
        <button class="big" data-nav="charge">Customer brings clothes<small>Record the bill (and any money paid now)</small></button>
        <button class="big alt" data-nav="payment">Customer pays<small>Record money received</small></button>
        <button class="big exp" data-nav="expense">Business expense<small>Record money spent</small></button>
        <button class="btn secondary" data-nav="fix">✏️ Correct a mistake</button>
      </div>`;
  async function renderHome() {
    const [from, to, label] = periodRange(state.period);
    view.innerHTML = `
      <div class="periods">${[["today", "Today"], ["yesterday", "Yesterday"], ["week", "This week"], ["month", "This month"], ["custom", "Choose dates"]]
        .map(([k, l]) => `<button data-period="${k}" class="${state.period === k ? "active" : ""}">${l}</button>`).join("")}</div>
      <div id="customBox" class="card ${state.period === "custom" ? "" : "hidden"}">
        <div class="row"><div><label for="cf">From</label><input type="date" id="cf" value="${esc(state.custom ? state.custom[0] : from)}" max="${today()}"></div>
        <div><label for="ct">To</label><input type="date" id="ct" value="${esc(state.custom ? state.custom[1] : to)}" max="${today()}"></div></div>
        <button class="btn" id="applyCustom" style="margin-top:12px;width:100%">Show</button></div>
      <p class="muted">${esc(label)}: ${esc(from === to ? niceDate(from) : niceDate(from) + " – " + niceDate(to))}</p>
      <div id="dash"><div class="card center"><p>Loading figures…</p></div>${ACTIONS_HTML}</div>
`;
    view.querySelectorAll("[data-period]").forEach(b => b.onclick = () => {
      state.period = b.dataset.period;
      if (state.period !== "custom") renderHome(); else { $("#customBox").classList.remove("hidden"); view.querySelectorAll("[data-period]").forEach(x => x.classList.toggle("active", x === b)); }
    });
    const ac = $("#applyCustom");
    if (ac) ac.onclick = () => { const f = $("#cf").value, t = $("#ct").value; if (!f || !t || f > t) return toast("Please choose a valid date range.", true); state.custom = [f, t]; state.period = "custom"; renderHome(); };
    try {
      const d = (await api("dashboard", { from, to })).data;
      const methods = Object.keys(d.receivedByMethod || {}).map(k => esc(k) + " " + money(d.receivedByMethod[k])).join(" · ");
      const cats = Object.keys(d.expensesByCategory || {}).map(k => esc(k) + " " + money(d.expensesByCategory[k])).join(" · ");
      const w = d.warnings || {};
      const warn = (w.interrupted || w.unmatched) ? `<section class="card warnbox"><h2>⚠ Please check</h2>
          ${w.interrupted ? `<p>${w.interrupted} save(s) were interrupted and need finishing.</p>` : ""}
          ${w.unmatched ? `<p>${w.unmatched} record(s) are not linked to a customer, so some balances may be incomplete.</p>` : ""}
          <button class="btn" data-nav="check" style="width:100%">Check records</button></section>` : "";
      $("#dash").innerHTML = warn + `
        <div class="grid">
          <div class="stat"><div class="label">Money received</div><div class="value good">${money(d.moneyReceived)}</div><div class="note">${methods || "No payments"}</div></div>
          <div class="stat"><div class="label">New laundry bills</div><div class="value">${money(d.newBills)}</div><div class="note">${d.billsCount} bill(s) · not all paid</div></div>
          <div class="stat"><div class="label">Expenses</div><div class="value bad">${money(d.expenses)}</div><div class="note">${cats || "No expenses"}</div></div>
          <div class="stat"><div class="label">Net cash movement</div><div class="value ${d.netCashMovement < 0 ? "bad" : ""}">${money(d.netCashMovement)}</div><div class="note">Cash in − cash out${d.netCashNote ? ". " + esc(d.netCashNote) : ""}</div></div>
          <div class="stat wide"><div class="label">Cash balance</div><div class="value">Not set</div><div class="note">${esc(String(d.cashBalanceNote).replace(/^Not set - /, ""))}</div></div>
        </div>
        ${ACTIONS_HTML}
        <section class="card">
          <h2>Customers who owe money</h2>
          <p class="muted">Confirmed from complete records only.</p>
          <div class="value" style="font-size:24px;font-weight:750">${money(d.confirmedOwingTotal)}</div>
          ${d.owing.length ? `<ul class="list">${d.owing.map(o => `<li><button data-nav="customer:${esc(o.id)}"><span>${esc(o.name)}</span><span class="amount">${money(o.balance)}</span></button></li>`).join("")}</ul>` : `<p class="muted">No confirmed unpaid balances.</p>`}
        </section>
        ${d.needsVerification.length ? `<section class="card">
          <h2>Balances that need checking (${d.needsVerification.length})</h2>
          <p class="muted">Old records are incomplete, so these balances are <b>not confirmed</b>. They are not counted as zero.</p>
          <ul class="list">${d.needsVerification.map(o => `<li><button data-nav="customer:${esc(o.id)}"><span>${esc(o.name)}<br><span class="tag">Needs verification</span></span><span class="amount muted">bills ${money(o.charges)}<br>paid ${money(o.payments)}</span></button></li>`).join("")}</ul></section>` : ""}
        ${d.creditCheck.length ? `<section class="card"><h2>Paid more than recorded bills</h2><ul class="list">${d.creditCheck.map(o => `<li><button data-nav="customer:${esc(o.id)}"><span>${esc(o.name)}</span><span class="amount">${money(-o.balance)}</span></button></li>`).join("")}</ul></section>` : ""}
        ${(d.undated.payments + d.undated.expenses + d.undated.charges) ? `<p class="muted">Not included in any date period: ${d.undated.payments} payment(s), ${d.undated.expenses} expense(s), ${d.undated.charges} bill(s) with no date (old records).</p>` : ""}`;
    } catch (e) { if (e.user) $("#dash").innerHTML = `<p class="error">${esc(e.message)}</p>` + ACTIONS_HTML; else if (e.message !== "signin") $("#dash").innerHTML = `<p class="error">Could not load figures. Check the internet.</p>` + ACTIONS_HTML; }
  }

  // ------------------------------------------------------------ customers
  async function loadCustomers() { state.customers = (await api("customers.list")).data.customers; return state.customers; }
  async function renderCustomers() {
    view.innerHTML = `<h1>Customers</h1>
      <button class="btn" data-nav="newcustomer" style="width:100%">+ Register new customer</button>
      <input class="search" style="margin-top:12px" id="q" placeholder="Search by name or phone" autocomplete="off">
      <section class="card"><ul class="list" id="clist"><li>Loading…</li></ul></section>`;
    try {
      const all = await loadCustomers();
      const draw = () => {
        const q = $("#q").value.trim().toLowerCase();
        const list = all.filter(c => !q || c.name.toLowerCase().includes(q) || (c.phone || "").includes(q));
        $("#clist").innerHTML = list.length ? list.map(c => `<li><button data-nav="customer:${esc(c.id)}"><span>${esc(c.name)}<br>${statusTag(c)}</span><span class="amount">${c.balanceStatus === "Needs verification" ? "?" : money(c.balance)}</span></button></li>`).join("") : `<li>No customers found.</li>`;
      };
      $("#q").oninput = draw; draw();
    } catch (e) { if (e.message !== "signin") $("#clist").innerHTML = `<li class="error">Could not load customers.</li>`; }
  }
  function statusTag(c) {
    if (c.balanceStatus === "Needs verification") return `<span class="tag">Needs verification</span>`;
    if (c.balanceStatus === "Owes") return `<span class="tag bad">Owes</span>`;
    if (c.balanceStatus === "Paid up") return `<span class="tag ok">Paid up</span>`;
    return `<span class="tag">${esc(c.balanceStatus)}</span>`;
  }
  async function renderCustomer(id) {
    view.innerHTML = `<p class="muted"><a href="#customers" data-nav="customers">← Customers</a></p><section class="card"><p>Loading…</p></section>`;
    try {
      const d = (await api("customer.detail", { id })).data, c = d.customer;
      const rows = [].concat(d.charges.map(x => ({ id: x.txnId, active: x.active, date: x.date, text: "Bill: " + (x.description || "Laundry"), amt: x.amount, sign: "+" })),
        d.payments.map(x => ({ id: x.txnId, active: x.active, date: x.date, text: "Paid" + (x.method && x.method !== "Unknown" ? " (" + x.method + ")" : "") + (x.notes ? " – " + x.notes : ""), amt: x.amount, sign: "−" })))
        .sort((a, b) => (b.date || "").localeCompare(a.date || ""));
      view.innerHTML = `<p class="muted"><a href="#customers" data-nav="customers">← Customers</a></p>
        <section class="card"><h1>${esc(c.name)}</h1>${c.phone ? `<p class="muted">${esc(c.phone)}</p>` : ""}${statusTag(c)}
          <div class="grid" style="margin-top:12px">
            <div class="stat"><div class="label">Total bills</div><div class="value">${money(c.charges)}</div></div>
            <div class="stat"><div class="label">Total paid</div><div class="value good">${money(c.payments)}</div></div>
            <div class="stat wide"><div class="label">Balance (bills − paid)</div><div class="value ${c.balance > 0 ? "bad" : ""}">${c.balanceStatus === "Needs verification" ? "Not confirmed" : money(c.balance)}</div>
              <div class="note">${c.balanceStatus === "Needs verification" ? "Old records are incomplete. Recorded difference: " + money(c.balance) + ". Please check receipts before asking for payment." : ""}</div></div>
          </div>
          <div class="row" style="margin-top:12px"><button class="btn" data-nav="charge:${esc(c.id)}">New bill</button><button class="btn secondary" data-nav="payment:${esc(c.id)}">Record payment</button></div>
        </section>
        <section class="card"><h2>History</h2><p class="hint">Tap a record to see it or correct it.</p>${rows.length ? `<ul class="list">${rows.map(r => `<li><button ${r.id ? `data-nav="record:${esc(r.id)}"` : "disabled"} class="${r.active ? "" : "voided"}"><span>${esc(r.text)}<br><span class="muted">${esc(niceDate(r.date))}</span>${r.active ? "" : ` <span class="tag bad">Cancelled</span>`}</span><span class="amount">${r.amt == null ? "amount unknown" : r.sign + " " + money(r.amt)}</span></button></li>`).join("")}</ul>` : `<p class="muted">No records yet.</p>`}</section>`;
    } catch (e) { if (e.message !== "signin") view.innerHTML = `<section class="card"><p class="error">${esc(e.user ? e.message : "Could not load this customer.")}</p></section>`; }
  }
  function renderNewCustomer() {
    view.innerHTML = `<h1>Register new customer</h1><section class="card">
      <label for="n">Customer name</label><input id="n" autocomplete="off" maxlength="80">
      <label for="p">Phone (optional)</label><input id="p" inputmode="tel" maxlength="30">
      <label for="o">Other spellings (optional)</label><input id="o" maxlength="200"><div class="hint">e.g. Jibril, Jibriil</div>
      <div id="err"></div><button class="btn" id="save" style="width:100%;margin-top:16px">Save customer</button></section>`;
    let confirmed = false;
    applyPrefill("customer", pf => { setVal("#n", pf.spokenName); });
    $("#save").onclick = async () => {
      const name = $("#n").value.trim(); if (name.length < 2) return showErr("Please enter the customer's name.");
      const btn = $("#save"); btn.disabled = true;
      try {
        const r = await write("customers.create", { name, phone: $("#p").value.trim(), otherSpellings: $("#o").value.trim(), confirmed });
        if (r.queued) { toast(QUEUED_MSG, true); return route("customers"); }
        if (r.data.needsConfirmation) {
          confirmed = true; btn.disabled = false; btn.textContent = "Yes, this is a different person – save";
          return showErr((r.data.reason === "exact" ? "A customer with this name already exists: " : "Similar name(s) already registered: ") + r.data.matches.map(m => m.name).join(", ") + ". Is this a different person?");
        }
        toast((r.duplicate ? "Already saved: " : "Customer saved: ") + r.data.customer.name);
        route("customer:" + r.data.customer.id);
      } catch (e) { btn.disabled = false; if (e.user) showErr(e.message); }
    };
  }
  function showErr(m) { const el = $("#err"); if (el) el.innerHTML = `<p class="error">${esc(m)}</p>`; }

  // ------------------------------------------------------------ transaction forms
  async function customerSelect(selectedId) {
    const list = await loadCustomers();   // always fresh, so balances shown are current
    return `<label for="cust">Customer</label><select id="cust"><option value="">Choose customer…</option>${list.map(c => `<option value="${esc(c.id)}" ${c.id === selectedId ? "selected" : ""}>${esc(c.name)}</option>`).join("")}</select>
      <div class="hint">Not in the list? <a href="#newcustomer" data-nav="newcustomer">Register new customer</a></div>`;
  }
  const methodSelect = (id, label) => `<label for="${id}">${label}</label><select id="${id}"><option value="">Choose…</option>${state.me.paymentMethods.map(m => `<option>${esc(m)}</option>`).join("")}</select>`;
  // One save flow for every record (typed, spoken or a correction): check screen -> Save -> server.
  // after(r) runs when the server saved it (or it is safely kept on the phone).
  function saveFlow(title, items, action, data, after, note) {
    // keep the form itself (its typed values and buttons) aside, so "Change" brings it back exactly
    const kept = document.createDocumentFragment(); while (view.firstChild) kept.appendChild(view.firstChild);
    view.innerHTML = `<h1>Please check</h1><p class="envline ${ENV === "TEST" ? "test" : "live"}">Saving to: ${ENV === "TEST" ? "TEST ledger (practice, not real money)" : "LIVE business ledger"}</p><section class="card"><h2>${esc(title)}</h2>${note ? `<p class="warnbox">${esc(note)}</p>` : ""}<dl class="confirm">${items.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl>
      <div id="err"></div><div class="row" id="btns"><button class="btn secondary" id="back">Change</button><button class="btn" id="ok">Save</button></div></section>`;
    $("#back").onclick = () => { view.innerHTML = ""; view.appendChild(kept); window.scrollTo(0, 0); };
    const go = async (d) => {
      const b = $("#ok"); if (b && b.disabled) return; if (b) { b.disabled = true; b.textContent = "Saving…"; } const bk = $("#back"); if (bk) bk.disabled = true;
      try {
        const r = await write(action, d);
        if (r.queued) { toast(QUEUED_MSG, true); return after(r); }
        if (r.data && r.data.needsConfirmation && r.data.reason === "possibleDuplicate") return askDuplicate(r.data.existing, d);
        after(r);
      } catch (e) {
        if (b) { b.disabled = false; b.textContent = "Save"; } if (bk) bk.disabled = false;
        if (e.user) showErr(e.message); else if (e.message !== "signin") showErr("Not saved. Please try again.");
      }
    };
    const askDuplicate = (x, d) => {
      const kind = { charge: "bill", payment: "payment", expense: "expense" }[x.type] || "record";
      $("#btns").outerHTML = `<div class="warnbox"><b>⚠ This looks already saved:</b><br>${esc(kind[0].toUpperCase() + kind.slice(1))} ${esc(money(x.amount))} · ${esc(x.who)} · ${esc(niceDate(x.date))}${x.recordedAt ? `<br><span class="muted">recorded ${esc(x.recordedAt.slice(11))}${x.recordedBy ? " by " + esc(x.recordedBy) : ""}</span>` : ""}
        <p><b>Is this a different ${esc(kind)}?</b></p></div>
        <div class="row"><button class="btn secondary" id="dupNo">No – don't save</button><button class="btn" id="dupYes">Yes, it is different – save</button></div>`;
      $("#dupNo").onclick = () => { toast("Not saved."); route("home"); };
      $("#dupYes").onclick = () => { $("#dupYes").disabled = true; $("#dupYes").textContent = "Saving…"; go(Object.assign({}, d, { confirmDuplicate: true })); };
    };
    $("#ok").onclick = () => go(data);
  }
  // A correction in progress: the normal form is used, filled with the old values.
  function takeCorrecting(kind) {
    const c = state.correcting; if (!c || c.kind !== kind) return null;
    const card = view.querySelector("section.card");
    card.insertAdjacentHTML("afterbegin", `<div class="warnbox"><b>Correcting:</b> ${esc(c.label)}<br>Reason: ${esc(c.reason)}<br><span class="muted">Change what is wrong, then Continue. When you save, the old record is cancelled and this one replaces it.</span></div>`);
    view.querySelectorAll('[data-nav="voice"]').forEach(x => x.remove());
    return c;
  }
  function submitEntry(kind, title, items, data, after) {
    const c = state.correcting && state.correcting.kind === kind ? state.correcting : null;
    if (!c) return saveFlow(title, items, kind + ".create", data, after);
    saveFlow("Correct this record", [["Replaces", c.label], ["Reason", c.reason]].concat(items), "record.correct",
      { txnId: c.txnId, kind, reason: c.reason, label: c.label, entry: data },
      r => { state.correcting = null; if (r.queued) return route("home"); toast("Corrected. The old record is cancelled and kept for the history."); route("record:" + (r.data.txnIds ? r.data.txnIds[0] : c.txnId)); });
  }
  async function renderCharge(custId) {
    view.innerHTML = `<h1>Customer brings clothes</h1><section class="card"><p>Loading…</p></section>`;
    view.innerHTML = `<h1>Customer brings clothes</h1>${SPEAK_LINK}<section class="card">
      <label for="d">Date</label><input type="date" id="d" value="${today()}" max="${today()}">
      ${await customerSelect(custId)}
      <label for="desc">Clothes / items</label><input id="desc" placeholder="e.g. 5 shirts, 2 trousers" maxlength="300">
      <label for="amt">Amount charged (GMD)</label><input id="amt" type="number" inputmode="decimal" min="0" step="0.01">
      <label for="paid">Amount paid now (GMD)</label><input id="paid" type="number" inputmode="decimal" min="0" step="0.01" value="0">
      <div id="methodBox" class="hidden">${methodSelect("pm", "How did they pay?")}</div>
      <label for="col">Expected collection date (optional)</label><input type="date" id="col">
      <p class="muted" id="remain"></p><div id="err"></div>
      <button class="btn" id="next" style="width:100%;margin-top:12px">Continue</button></section>`;
    const upd = () => { const a = Number($("#amt").value || 0), p = Number($("#paid").value || 0);
      $("#methodBox").classList.toggle("hidden", !(p > 0)); $("#remain").textContent = a ? "Remaining to pay for this order: " + money(Math.max(a - p, 0)) : ""; };
    $("#amt").oninput = upd; $("#paid").oninput = upd;
    applyPrefill("charge", pf => { setVal("#amt", pf.amount); setVal("#paid", pf.paidNow || 0); setVal("#pm", pf.method); setVal("#desc", pf.description); upd(); });
    const fx = takeCorrecting("charge");
    if (fx) { const o = fx.old; setVal("#d", o.date); setVal("#desc", o.description); setVal("#amt", o.amount); setVal("#paid", o.paidNow || 0); setVal("#pm", o.paidMethod); setVal("#col", o.expectedCollection); upd(); }
    $("#next").onclick = () => {
      const c = state.customers.find(x => x.id === $("#cust").value), a = Number($("#amt").value), p = Number($("#paid").value || 0);
      if (!$("#d").value) return showErr("Please choose the date.");
      if (!c) return showErr("Please choose the customer.");
      if (!(a > 0)) return showErr("Please enter the amount charged.");
      if (p < 0 || p > a) return showErr("Amount paid now must be between 0 and the amount charged.");
      if (p > 0 && !$("#pm").value) return showErr("Please choose how they paid.");
      const data = { date: $("#d").value, customerId: c.id, description: $("#desc").value.trim(), amount: a, paidNow: p, paidMethod: p > 0 ? $("#pm").value : "", expectedCollection: $("#col").value };
      submitEntry("charge", "Customer brings clothes", [["Date", niceDate(data.date)], ["Customer", c.name], ["Clothes", data.description || "Clothes brought"], ["Bill", money(a)],
        ["Paid now", p > 0 ? money(p) + " (" + data.paidMethod + ")" : "Nothing"], ["Still to pay for this order", money(a - p)]], data, r => {
        if (!r.queued) toast(r.duplicate ? "Already saved earlier." : "Saved. Bill " + money(a) + (p > 0 ? ", paid " + money(p) : "") + (r.data && r.data.balanceAfter != null ? ". Balance now " + money(r.data.balanceAfter) : ""));
        route("customer:" + c.id);
      });
    };
  }
  async function renderPayment(custId) {
    view.innerHTML = `<h1>Customer pays</h1><section class="card"><p>Loading…</p></section>`;
    view.innerHTML = `<h1>Customer pays</h1>${SPEAK_LINK}<section class="card">
      <label for="d">Date</label><input type="date" id="d" value="${today()}" max="${today()}">
      ${await customerSelect(custId)}
      <p class="muted" id="bal"></p>
      <label for="amt">Amount received (GMD)</label><input id="amt" type="number" inputmode="decimal" min="0" step="0.01">
      ${methodSelect("pm", "Payment method")}
      <label for="notes">Notes (optional)</label><input id="notes" maxlength="300">
      <div id="err"></div><button class="btn" id="next" style="width:100%;margin-top:12px">Continue</button></section>`;
    const showBal = () => { const c = state.customers.find(x => x.id === $("#cust").value);
      $("#bal").textContent = !c ? "" : c.balanceStatus === "Needs verification" ? "Current balance: not confirmed (old records incomplete)" : "Current balance: " + money(c.balance); };
    $("#cust").onchange = showBal; showBal();
    applyPrefill("payment", pf => { setVal("#amt", pf.amount); setVal("#pm", pf.method); showBal(); });
    const fx = takeCorrecting("payment");
    if (fx) { const o = fx.old; setVal("#d", o.date); setVal("#amt", o.amount); setVal("#pm", o.method); setVal("#notes", o.notes); showBal(); }
    $("#next").onclick = () => {
      const c = state.customers.find(x => x.id === $("#cust").value), a = Number($("#amt").value);
      if (!$("#d").value) return showErr("Please choose the date.");
      if (!c) return showErr("Please choose the customer.");
      if (!(a > 0)) return showErr("Please enter the amount received.");
      if (!$("#pm").value) return showErr("Please choose the payment method.");
      const data = { date: $("#d").value, customerId: c.id, amount: a, method: $("#pm").value, notes: $("#notes").value.trim() };
      const after = c.balanceStatus === "Needs verification" ? "Not confirmed" : money(c.balance - a);
      submitEntry("payment", "Customer pays", [["Date", niceDate(data.date)], ["Customer", c.name], ["Amount received", money(a)], ["Method", data.method], ["Notes", data.notes || "—"]].concat(state.correcting ? [] : [["Balance after payment", after]]), data, r => {
        if (!r.queued) toast(r.duplicate ? "Already saved earlier." : "Saved. Received " + money(a) + (r.data && r.data.balanceAfter != null ? ". Balance now " + money(r.data.balanceAfter) : ""));
        route("customer:" + c.id);
      });
    };
  }
  function renderExpense() {
    view.innerHTML = `<h1>Business expense</h1>${SPEAK_LINK}<section class="card">
      <label for="d">Date</label><input type="date" id="d" value="${today()}" max="${today()}">
      <label for="cat">Category</label><select id="cat"><option value="">Choose…</option>${state.me.expenseCategories.map(c => `<option>${esc(c)}</option>`).join("")}</select>
      <label for="amt">Amount spent (GMD)</label><input id="amt" type="number" inputmode="decimal" min="0" step="0.01">
      ${methodSelect("pm", "Paid with")}
      <label for="desc">Description</label><input id="desc" maxlength="300" placeholder="e.g. 2 bags of detergent">
      <div id="err"></div><button class="btn" id="next" style="width:100%;margin-top:12px">Continue</button></section>`;
    applyPrefill("expense", pf => { setVal("#cat", pf.category); setVal("#amt", pf.amount); setVal("#pm", pf.method); setVal("#desc", pf.description); });
    const fx = takeCorrecting("expense");
    if (fx) { const o = fx.old; setVal("#d", o.date); setVal("#cat", o.category); setVal("#amt", o.amount); setVal("#pm", o.method); setVal("#desc", o.description); }
    $("#next").onclick = () => {
      const a = Number($("#amt").value);
      if (!$("#d").value) return showErr("Please choose the date.");
      if (!$("#cat").value) return showErr("Please choose the category.");
      if (!(a > 0)) return showErr("Please enter the amount spent.");
      if (!$("#pm").value) return showErr("Please choose how it was paid.");
      const data = { date: $("#d").value, category: $("#cat").value, amount: a, method: $("#pm").value, description: $("#desc").value.trim() };
      submitEntry("expense", "Business expense", [["Date", niceDate(data.date)], ["Category", data.category], ["Amount", money(a)], ["Paid with", data.method], ["Description", data.description || "—"]], data, r => {
        if (!r.queued) toast(r.duplicate ? "Already saved earlier." : "Saved. Expense " + money(a));
        route("home");
      });
    };
  }

  // ------------------------------------------------------------ voice entry (TEST)
  // Speech -> text (free browser recognition) -> parsed values -> the NORMAL form, filled in.
  // Mariama checks/corrects every field, then the normal "Please check" screen asks her to confirm.
  const SPEAK_LINK = `<p><button class="btn secondary small" data-nav="voice">🎤 Speak instead</button></p>`;
  const VOICE_LANGS = [["en-GB", "English (UK)"], ["en-NG", "English (Nigeria / West Africa)"], ["en-GH", "English (Ghana)"], ["en-US", "English (US)"]];
  function setVal(sel, v) { const el = $(sel); if (el && v !== undefined && v !== null && v !== "") el.value = v; }
  function applyPrefill(kind, fill) {
    const pf = state.prefill; if (!pf || pf.kind !== kind) return;
    state.prefill = null;
    fill(pf);
    const sugg = !pf.customerId && pf.suggestions && pf.suggestions.length && $("#cust")
      ? `<p class="muted">Did you mean:</p><div class="chips">${pf.suggestions.map(x => `<button class="chip" data-pick="${esc(x.id)}">${esc(x.name)}</button>`).join("")}</div>` : "";
    const newCust = kind !== "customer" && kind !== "expense" && !pf.customerId && pf.spokenName
      ? `<p><button class="chip" id="vNew">+ New customer: ${esc(pf.spokenName)}</button></p>` : "";
    const box = `<div class="voicebox"><b>Filled from your voice – please check every field.</b><br><span class="muted">You said: “${esc(pf.transcript)}”</span>
      ${pf.warnings && pf.warnings.length ? `<ul>${pf.warnings.map(w => `<li>${esc(w)}</li>`).join("")}</ul>` : ""}${sugg}${newCust}</div>`;
    const card = view.querySelector("section.card"); card.insertAdjacentHTML("afterbegin", box);
    card.querySelectorAll("[data-pick]").forEach(b => b.onclick = () => {
      $("#cust").value = b.dataset.pick; $("#cust").dispatchEvent(new Event("change"));
      card.querySelectorAll("[data-pick]").forEach(x => x.classList.toggle("on", x === b));
    });
    const nb = $("#vNew");
    if (nb) nb.onclick = () => { state.prefill = { kind: "customer", spokenName: pf.spokenName, transcript: pf.transcript, warnings: ["Check the spelling of the name."] }; route("newcustomer"); };
  }
  async function renderVoice() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    const lang = store.get("pl_voice_lang", "en-GB");
    view.innerHTML = `<h1>Speak a transaction</h1><section class="card">
      <p class="muted">Tap the microphone, then say for example:</p>
      <ul class="examples"><li>“Awa brought clothes, eight hundred and fifty, paid three hundred cash”</li>
        <li>“Jibril paid two hundred by Wave”</li><li>“Expense, detergent, eight hundred, cash”</li><li>“New customer Fatou Jallow”</li></ul>
      <button class="mic" id="mic" aria-label="Start speaking"${SR ? "" : " disabled"}>🎤</button>
      <p class="center" id="micState">${SR ? "Tap the microphone and speak" : "Voice is not available in this browser. Use Chrome on Android – or type the sentence below."}</p>
      <label for="heard">What I heard (you can correct it)</label>
      <textarea id="heard" rows="3" maxlength="300"></textarea>
      <div id="err"></div>
      <p class="hint center" id="custState">Loading customers…</p>
      <div class="row" style="margin-top:12px"><button class="btn secondary" data-nav="home">Cancel</button><button class="btn" id="use">Fill the form</button></div>
      <p class="hint">Nothing is saved yet. Next you will see the form filled in, correct anything, and press Save.</p>
      <p class="hint">Language: ${esc((VOICE_LANGS.find(l => l[0] === lang) || VOICE_LANGS[0])[1])} (change in More). Chrome turns your voice into text with its free built-in speech service; only the text is used.</p></section>`;
    // v0.4.1: the microphone works at once; the customer list loads in the background.
    let alts = [], rec = null, cust = "loading";
    const st = $("#micState"), heard = $("#heard"), mic = $("#mic"), use = $("#use"), cs = $("#custState");
    const here = () => document.body.contains(use);
    const loadList = () => {
      cust = "loading"; cs.className = "hint center"; cs.textContent = "Loading customers…";
      return loadCustomers().then(() => { cust = "ready"; if (here()) cs.textContent = ""; },
        e => { if (e.message === "signin") { cust = "signin"; return; }
          cust = "failed"; if (here()) { cs.className = "error"; cs.textContent = "Could not load the customer list. Check the internet – “Fill the form” will try again."; } });
    };
    let custLoad = loadList();
    if (SR) mic.onclick = () => {
      if (rec) { rec.stop(); return; }
      rec = new SR(); rec.lang = lang; rec.interimResults = true; rec.maxAlternatives = 5; rec.continuous = false;
      mic.classList.add("on"); st.textContent = "Listening… speak now"; heard.value = ""; alts = [];
      rec.onresult = e => {
        const res = e.results[e.results.length - 1];
        heard.value = Array.from(e.results).map(x => x[0].transcript).join(" ");
        if (res.isFinal) alts = Array.from(res).map(a => a.transcript);
      };
      rec.onerror = e => {
        const m = { "not-allowed": "Microphone blocked. Tap the lock icon next to the address, allow the microphone, and try again.",
          "service-not-allowed": "Microphone blocked. Allow the microphone for this site in Chrome settings.",
          "no-speech": "I did not hear anything. Tap the microphone and speak a little louder.",
          "network": "Voice needs internet. Check the connection, or type the sentence.", "audio-capture": "No microphone found." }[e.error];
        st.textContent = m || "Voice stopped. Please try again or type.";
      };
      rec.onend = () => { rec = null; mic.classList.remove("on"); if (heard.value.trim()) st.textContent = "Check the text, then tap “Fill the form”."; };
      try { rec.start(); } catch (e) { rec = null; mic.classList.remove("on"); st.textContent = "Could not start the microphone. Please try again."; }
    };
    use.onclick = async () => {
      const text = heard.value.trim(); if (!text) return showErr("Say or type the transaction first.");
      if (cust !== "ready") {
        if (cust === "failed") custLoad = loadList();
        use.disabled = true; use.textContent = "Loading customers…"; $("#err").innerHTML = "";
        await custLoad;
        if (!here()) return;
        use.disabled = false; use.textContent = "Fill the form";
        if (cust !== "ready") return;
      }
      const r = (alts.length && alts[0].trim() === text) ? PLVoice.parseBest(alts, state.customers) : PLVoice.parse(text, state.customers);
      const go = kind => {
        r.kind = kind; state.prefill = r;
        route(kind === "customer" ? "newcustomer" : kind === "expense" ? "expense" : kind + (r.customerId ? ":" + r.customerId : ""));
      };
      if (r.type) return go(r.type);
      $("#err").innerHTML = `<p class="error">Is this a bill, a payment or an expense?</p><div class="chips">
        <button class="chip" data-k="charge">Bill (clothes brought)</button><button class="chip" data-k="payment">Payment</button><button class="chip" data-k="expense">Expense</button></div>`;
      view.querySelectorAll("[data-k]").forEach(b => b.onclick = () => {
        const again = PLVoice.parse((b.dataset.k === "charge" ? "brought " : b.dataset.k === "payment" ? "paid " : "expense ") + text, state.customers);
        Object.assign(r, again, { transcript: text }); go(b.dataset.k);
      });
    };
  }

  // ------------------------------------------------------------ corrections
  const KIND = { charge: "Bill", payment: "Payment", expense: "Expense" };
  const recLabel = x => (KIND[x.type] || "Record") + " " + money(x.amount) + " · " + (x.who || "") + " · " + niceDate(x.date);
  const recTag = x => x.active ? "" : `<span class="tag bad">${x.status === "Voided" ? "Cancelled" : esc(x.status)}</span>`;
  async function renderFix() {
    view.innerHTML = `<h1>Correct a mistake</h1><section class="card"><p class="muted">Find the record that is wrong. Newest first.</p>
      <input class="search" id="q" placeholder="Search name, amount or category" autocomplete="off"><ul class="list" id="rlist"><li>Loading…</li></ul></section>`;
    let timer;
    const load = async () => {
      try {
        const d = (await api("records.recent", { q: $("#q").value.trim(), limit: 40 })).data;
        $("#rlist").innerHTML = d.records.length ? d.records.map(x => `<li><button data-nav="record:${esc(x.txnId)}" class="${x.active ? "" : "voided"}"><span>${esc(KIND[x.type])}: ${esc(x.who)}<br><span class="muted">${esc(niceDate(x.date))}${x.text ? " · " + esc(x.text) : ""}</span> ${recTag(x)}</span><span class="amount">${money(x.amount)}</span></button></li>`).join("") : `<li>No records found.</li>`;
      } catch (e) { if (e.message !== "signin") $("#rlist").innerHTML = `<li class="error">Could not load records. Check the internet.</li>`; }
    };
    $("#q").oninput = () => { clearTimeout(timer); timer = setTimeout(load, 400); };
    load();
  }
  async function renderRecord(txnId) {
    view.innerHTML = `<p class="muted"><a href="#fix" data-nav="fix">← Correct a mistake</a></p><section class="card"><p>Loading…</p></section>`;
    let d;
    try { d = (await api("record.detail", { txnId })).data; }
    catch (e) { if (e.message !== "signin") view.innerHTML = `<section class="card"><p class="error">${esc(e.user ? e.message : "Could not load this record.")}</p></section>`; return; }
    const x = d.record;
    const rows = [["Type", KIND[x.type]], ["Date", niceDate(x.date)], [x.type === "expense" ? "Category" : "Customer", x.who], ["Amount", money(x.amount)]]
      .concat(x.method && x.method !== "Unknown" ? [["Method", x.method]] : []).concat(x.text ? [[x.type === "payment" ? "Notes" : "Description", x.text]] : [])
      .concat([["Recorded", (x.recordedAt || "—") + (x.recordedBy ? " by " + x.recordedBy : "")], ["Record number", x.txnId]]);
    const linked = d.linked.length ? `<p class="warnbox">Paid when the clothes were brought: ${d.linked.map(p => esc(money(p.amount) + " (" + p.method + ")")).join(", ")}. It is part of this bill and is corrected or cancelled together with it.</p>` : "";
    const others = d.otherOrderPayments.length ? `<p class="muted">Later payments for this order (${d.otherOrderPayments.map(p => esc(money(p.amount))).join(", ")}) are not changed. Correct them separately if they are wrong.</p>` : "";
    const status = x.active ? "" : `<div class="warnbox"><b>Cancelled</b>${x.statusChangedAt ? " on " + esc(x.statusChangedAt) : ""}${x.statusChangedBy ? " by " + esc(x.statusChangedBy) : ""}<br>Reason: ${esc(x.correctionReason || "—")}
      ${d.replacedBy.length ? `<br>Replaced by: ${d.replacedBy.map(r => `<a href="#record:${esc(r.txnId)}" data-nav="record:${esc(r.txnId)}">${esc(recLabel(r))}</a>`).join(", ")}` : ""}<br><span class="muted">It is kept for the history but no longer counted in any total or balance.</span></div>`;
    const repl = d.replaces.length ? `<p class="muted">This record replaced: ${d.replaces.map(r => `<a href="#record:${esc(r.txnId)}" data-nav="record:${esc(r.txnId)}">${esc(recLabel(r))}</a>`).join(", ")}</p>` : "";
    const unlinked = d.unmatched ? `<p class="warnbox">This record is not linked to a registered customer. <a href="#check" data-nav="check">Link it in Check records</a>.</p>` : "";
    const can = x.active && state.me.canCorrect;
    view.innerHTML = `<p class="muted"><a href="#fix" data-nav="fix">← Correct a mistake</a></p>
      <section class="card"><h1>${esc(KIND[x.type])} ${esc(money(x.amount))}</h1>${status}${repl}${unlinked}
        <dl class="confirm">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl>${linked}${others}
        ${can ? `<div class="row"><button class="btn" id="fixIt">Fix it</button><button class="btn danger" id="cancelIt">Cancel it</button></div>
        <p class="hint"><b>Fix it</b>: something is wrong (amount, customer, date, method). <b>Cancel it</b>: it should not exist at all (entered twice, never happened).</p>` : ""}
      </section>`;
    if (!can) return;
    state.recordCache = { x, linked: d.linked };
    $("#fixIt").onclick = () => route("correct:" + x.txnId);
    $("#cancelIt").onclick = () => route("cancel:" + x.txnId);
  }
  const REASONS = { cancel: ["Entered twice", "Never happened", "Wrong customer", "Wrong amount"], correct: ["Wrong amount", "Wrong customer", "Wrong date", "Wrong payment method", "Wrong category"] };
  function renderReason(txnId, mode) {
    const rc = state.recordCache;
    if (!rc || rc.x.txnId !== txnId) return route("record:" + txnId);
    const x = rc.x, label = recLabel(x);
    view.innerHTML = `<p class="muted"><a href="#record:${esc(txnId)}" data-nav="record:${esc(txnId)}">← Back</a></p>
      <section class="card"><h1>${mode === "cancel" ? "Cancel this record" : "Fix this record"}</h1><p><b>${esc(label)}</b></p>
        <label>Why?</label><div class="chips">${REASONS[mode].filter(r => x.type === "expense" ? r !== "Wrong customer" : r !== "Wrong category").map(r => `<button class="chip" data-r="${esc(r)}">${esc(r)}</button>`).join("")}</div>
        <label for="why">Other reason (optional)</label><input id="why" maxlength="150">
        <div id="err"></div><button class="btn" id="next" style="width:100%;margin-top:12px">Continue</button></section>`;
    let picked = "";
    view.querySelectorAll("[data-r]").forEach(b => b.onclick = () => { picked = b.dataset.r; view.querySelectorAll("[data-r]").forEach(c => c.classList.toggle("on", c === b)); });
    $("#next").onclick = () => {
      const reason = [picked, $("#why").value.trim()].filter(Boolean).join(" – ");
      if (reason.replace(/[^A-Za-z]/g, "").length < 3) return showErr("Please choose or write the reason.");
      if (mode === "cancel") {
        const items = [["Record", label]].concat(rc.linked.map(p => ["Also cancelled (paid with this bill)", money(p.amount) + " " + p.method]), [["Reason", reason]]);
        return saveFlow("Cancel this record?", items, "record.void", { txnId, reason, label }, r => {
          if (!r.queued) toast(r.duplicate ? "Already cancelled earlier." : "Cancelled. It is kept for the history and no longer counted.");
          route(r.queued ? "home" : "record:" + txnId);
        }, "The record stays in the ledger marked Cancelled. Totals and balances will no longer count it. Nothing is deleted.");
      }
      const old = { date: x.date, amount: x.amount, method: x.method, notes: x.text, description: x.description, category: x.category,
        expectedCollection: x.expectedCollection, paidNow: rc.linked.length ? rc.linked[0].amount : 0, paidMethod: rc.linked.length ? rc.linked[0].method : "" };
      state.correcting = { txnId, kind: x.type, reason, label, old };
      route(x.type === "expense" ? "expense" : x.type + ":" + x.customerId);
    };
  }

  // ------------------------------------------------------------ check records (integrity)
  async function renderCheck() {
    view.innerHTML = `<h1>Check records</h1><section class="card"><p>Checking every record…</p></section>`;
    let d;
    try { d = (await api("integrity", {})).data; } catch (e) { if (e.message !== "signin") view.innerHTML = `<section class="card"><p class="error">Could not check. Check the internet.</p></section>`; return; }
    try { await loadCustomers(); } catch (e) { /* list only needed for linking */ }
    const allOk = d.checks.every(c => c.pass) && !d.interrupted.length && !d.unmatched.length;
    view.innerHTML = `<h1>Check records</h1>
      <section class="card ${allOk ? "" : "warnbox"}"><h2>${allOk ? "✓ All records add up" : "⚠ Some records need attention"}</h2>
        <ul class="checks">${d.checks.map(c => `<li>${c.pass ? "✓" : "✗"} ${esc(c.name)}</li>`).join("")}</ul>
        <p class="muted">Bills ${money(d.totals.charges)} · Payments ${money(d.totals.payments)} · Expenses ${money(d.totals.expenses)} (all dates, cancelled records excluded)</p></section>
      ${d.interrupted.length ? `<section class="card"><h2>Interrupted saves (${d.interrupted.length})</h2><p class="muted">The save started but did not finish. "Finish saving" completes it; it is never saved twice.</p>
        ${d.interrupted.map(x => `<div class="unm"><p><b>${esc(x.summary || x.action)}</b><br><span class="muted">${esc(x.at)} · ${esc(x.user)}</span></p><button class="btn small" data-finish="${esc(x.requestId)}">Finish saving</button></div>`).join("")}</section>` : ""}
      ${d.unmatched.length ? `<section class="card"><h2>Not linked to a customer (${d.unmatched.length})</h2><p class="muted">These are counted in daily totals but not in any customer's balance. Choose the right customer and tap Link. If the record is wrong, open it to cancel it.</p>
        ${d.unmatched.map(x => `<div class="unm"><p><b>${esc(KIND[x.type])} ${esc(money(x.amount))}</b> · name written: “${esc(x.name)}” · ${esc(niceDate(x.date))}</p>
          ${x.txnId ? `<select data-cust="${esc(x.txnId)}"><option value="">Choose customer…</option>${state.customers.map(c => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join("")}</select>
          <div class="row" style="margin-top:8px"><button class="btn small" data-link="${esc(x.txnId)}">Link</button><button class="btn secondary small" data-nav="record:${esc(x.txnId)}">Open</button></div>` : `<p class="error">This row has no record number. Ask Giuseppe to fix it in the sheet.</p>`}</div>`).join("")}</section>` : ""}
      ${d.possibleDuplicates.length ? `<section class="card"><h2>Possible duplicates (${d.possibleDuplicates.length})</h2><p class="muted">Same customer (or category), date and amount. If one was entered twice, open it and cancel it. If both are real, nothing to do.</p>
        ${d.possibleDuplicates.map(gp => `<ul class="list">${gp.map(x => `<li><button data-nav="record:${esc(x.txnId)}"><span>${esc(recLabel(x))}<br><span class="muted">recorded ${esc(x.recordedAt || "—")}</span></span><span class="amount">›</span></button></li>`).join("")}</ul>`).join("")}</section>` : ""}`;
    view.querySelectorAll("[data-finish]").forEach(b => b.onclick = async () => {
      b.disabled = true; b.textContent = "Finishing…";
      try { const r = await write("recovery.finish", { requestId: b.dataset.finish }); toast(r.queued ? QUEUED_MSG : "Finished. Saved once.", !!r.queued); }
      catch (e) { if (e.user) toast(e.message, true); }
      renderCheck();
    });
    view.querySelectorAll("[data-link]").forEach(b => b.onclick = async () => {
      const id = b.dataset.link, cid = view.querySelector(`[data-cust="${id}"]`).value;
      if (!cid) return toast("Choose the customer first.", true);
      b.disabled = true; b.textContent = "Linking…";
      try { const r = await write("record.assign", { txnId: id, customerId: cid }); toast(r.queued ? QUEUED_MSG : "Linked to " + custName(cid) + ".", !!r.queued); }
      catch (e) { if (e.user) toast(e.message, true); }
      renderCheck();
    });
  }

  // ------------------------------------------------------------ records kept on this phone
  function renderPending() {
    const q = queue(), a = attention();
    view.innerHTML = `<h1>Records on this phone</h1>
      ${a.length ? `<section class="card warnbox"><h2>Need your decision (${a.length})</h2>${a.map(x => `<div class="unm"><p><b>${esc(x.label)}</b><br><span class="muted">${esc(new Date(x.at).toLocaleString("en-GB"))}</span></p>
        ${x.reason === "possibleDuplicate" && x.existing ? `<p>Looks already saved: ${esc(recLabel(x.existing))}. Is this a different one?</p><div class="row"><button class="btn secondary small" data-drop="${esc(x.requestId)}">No – remove it</button><button class="btn small" data-again="${esc(x.requestId)}">Yes – save it</button></div>`
          : x.reason === "exact" || x.reason === "similar" ? `<p>A customer with a similar name already exists${x.matches ? ": " + esc(x.matches.map(m => m.name).join(", ")) : ""}. Is this a different person?</p><div class="row"><button class="btn secondary small" data-drop="${esc(x.requestId)}">No – remove it</button><button class="btn small" data-again="${esc(x.requestId)}">Yes – save it</button></div>`
          : `<p class="error">${esc(x.error || "Not saved.")}</p><p class="muted">It was NOT saved. Enter it again correctly, then remove this.</p><button class="btn secondary small" data-drop="${esc(x.requestId)}">Remove</button>`}</div>`).join("")}</section>` : ""}
      <section class="card"><h2>Waiting to be confirmed (${q.length})</h2>
        ${q.length ? `<ul class="list">${q.map(x => `<li><span>${esc(x.label)}<br><span class="muted">${esc(new Date(x.at).toLocaleString("en-GB"))}</span></span></li>`).join("")}</ul>
        <p class="muted">These are sent automatically when there is internet. Each is saved once, even if it was partly sent before.</p><button class="btn" id="sendNow" style="width:100%">Send now</button>` : `<p class="muted">Nothing waiting. Everything on this phone has been confirmed.</p>`}</section>`;
    const s = $("#sendNow"); if (s) s.onclick = async () => { s.disabled = true; s.textContent = "Sending…"; await flushQueue(); renderPending(); };
    view.querySelectorAll("[data-drop]").forEach(b => b.onclick = () => {
      if (!confirm("Remove this from the phone? It was NOT saved in the ledger.")) return;
      aRemove(b.dataset.drop); updateQueueBanner(); renderPending();
    });
    view.querySelectorAll("[data-again]").forEach(b => b.onclick = async () => {
      const x = attention().find(y => y.requestId === b.dataset.again); if (!x) return;
      b.disabled = true; aRemove(x.requestId);
      const data = Object.assign({}, x.data, x.action === "customers.create" ? { confirmed: true } : { confirmDuplicate: true });
      try { const r = await write(x.action, data); toast(r.queued ? QUEUED_MSG : "Saved: " + x.label, !!r.queued); }
      catch (e) { if (e.user) { aAdd(Object.assign({}, x, { reason: "refused", error: e.message })); } }
      updateQueueBanner(); renderPending();
    });
  }

  // ------------------------------------------------------------ more
  function renderMore() {
    view.innerHTML = `<h1>More</h1>
      <section class="card"><h2>Account</h2><p>${esc(state.me.email)}<br><span class="muted">Role: ${esc(state.me.role)} · ${esc(ENV === "TEST" ? "TEST ledger (practice)" : "LIVE business ledger")}</span></p>
        <button class="btn secondary" id="out" style="width:100%">Sign out</button></section>
      <section class="card"><h2>Install on your phone</h2><p>In Chrome, tap the ⋮ menu, then <b>Add to Home screen</b> (or <b>Install app</b>).</p></section>
      <section class="card"><h2>Voice entry</h2><label for="vlang">Voice language</label><select id="vlang">${VOICE_LANGS.map(([k, l]) => `<option value="${k}" ${store.get("pl_voice_lang", "en-GB") === k ? "selected" : ""}>${esc(l)}</option>`).join("")}</select>
        <p class="hint">If names or amounts are often misunderstood, try another English option.</p></section>
      <section class="card"><h2>Records</h2>
        <button class="btn secondary" data-nav="fix" style="width:100%">✏️ Correct a mistake</button>
        <button class="btn secondary" data-nav="check" style="width:100%;margin-top:8px">Check records</button>
        <button class="btn secondary" data-nav="pending" style="width:100%;margin-top:8px">Records on this phone (${queue().length + attention().length})</button></section>
      <section class="card"><h2>Coming next</h2><p class="muted">Reports, cash count.</p><p class="muted">App version ${esc(CFG.appVersion)}</p></section>`;
    $("#out").onclick = signOut;
    $("#vlang").onchange = e => { store.set("pl_voice_lang", e.target.value); toast("Voice language saved"); };
  }

  // ------------------------------------------------------------ start
  $("#queueBanner").onclick = () => { if (state.me) route("pending"); };
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => { });
  paintEnv();
  if (!CFG.apiUrl) {
    view.innerHTML = `<section class="card center"><h1>Premium Laundry &amp; Garment Care</h1>
      <p>The LIVE business app is <b>not switched on yet</b>.</p>
      <p class="muted">It will be activated after final checks. For practice, use the TEST app link Giuseppe sent you.</p></section>`;
  } else window.addEventListener("load", boot);
})();
