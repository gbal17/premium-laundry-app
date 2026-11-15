/* Premium Laundry - PWA client (v0.4.0 TEST: voice entry)
 * - Two separate environments: TEST (practice ledger, /test/) and LIVE (official ledger, root).
 *   The environment shown comes from the SERVER (its LEDGER_MODE); if it does not match this
 *   app's configured environment, the app refuses to work.
 * - Sign in with Google (ID token kept in memory + sessionStorage only for this tab session).
 * - Every API call sends the token; the server verifies it with Google.
 * - Writes carry a one-time requestId so double taps / resends never duplicate.
 * - Unsent writes are queued on this phone until the network is back.
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
    const res = await fetch(CFG.apiUrl, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" }, body, redirect: "follow", cache: "no-store" });
    const json = await res.json();
    if (!json.ok && (json.code === 401)) { showSignIn(json.error); throw new Error("signin"); }
    if (!json.ok && json.code === 403) { showSignIn(json.error); throw new Error("forbidden"); }
    if (!json.ok) { const e = new Error(json.error || "Request failed"); e.user = true; throw e; }
    return json;
  }

  // Offline queue for writes (kept only on this phone until sent).
  const QKEY = "pl_queue_v1_" + ENV;   // TEST and LIVE never share unsent records
  function queue() { return store.get(QKEY, []); }
  function updateQueueBanner() {
    const n = queue().length, b = $("#queueBanner");
    if (n) { b.textContent = n + " record(s) saved on this phone, waiting to send. Keep the app open when you have internet."; b.classList.remove("hidden"); }
    else b.classList.add("hidden");
  }
  async function write(action, data) {
    const requestId = uuid();
    try {
      return await api(action, data, requestId);
    } catch (e) {
      if (e.user || e.message === "signin" || e.message === "forbidden") throw e;
      // network problem: keep it and retry later (same requestId -> no duplicate)
      const q = queue(); q.push({ action, data, requestId, at: Date.now() }); store.set(QKEY, q); updateQueueBanner();
      return { ok: true, queued: true };
    }
  }
  async function flushQueue() {
    if (state.sending || !tokenValid()) return;
    let q = queue(); if (!q.length) return;
    state.sending = true;
    try {
      while (q.length) {
        const item = q[0];
        try { await api(item.action, item.data, item.requestId); }
        catch (e) {
          if (e.user) { toast("A saved record could not be sent: " + e.message, true); }
          else break;
        }
        q.shift(); store.set(QKEY, q);
      }
    } finally { state.sending = false; updateQueueBanner(); }
  }
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
    if (page === "home") { setTab("home"); return renderHome(); }
    if (page === "customers") { setTab("customers"); return renderCustomers(); }
    if (page === "customer") { setTab("customers"); return renderCustomer(arg); }
    if (page === "newcustomer") { setTab("customers"); return renderNewCustomer(); }
    if (page === "charge") { setTab("home"); return renderCharge(arg); }
    if (page === "payment") { setTab("home"); return renderPayment(arg); }
    if (page === "expense") { setTab("home"); return renderExpense(); }
    if (page === "more") { setTab("more"); return renderMore(); }
    if (page === "voice") { setTab("home"); return renderVoice(); }
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
      $("#dash").innerHTML = `
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
      const rows = [].concat(d.charges.map(x => ({ date: x.date, text: "Bill: " + (x.description || "Laundry"), amt: x.amount, sign: "+" })),
        d.payments.map(x => ({ date: x.date, text: "Paid" + (x.method && x.method !== "Unknown" ? " (" + x.method + ")" : "") + (x.notes ? " – " + x.notes : ""), amt: x.amount, sign: "−" })))
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
        <section class="card"><h2>History</h2>${rows.length ? `<ul class="list">${rows.map(r => `<li><span>${esc(r.text)}<br><span class="muted">${esc(niceDate(r.date))}</span></span><span class="amount">${r.amt == null ? "amount unknown" : r.sign + " " + money(r.amt)}</span></li>`).join("")}</ul>` : `<p class="muted">No records yet.</p>`}</section>`;
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
        if (r.queued) { toast("No internet: saved on this phone, will send later."); return route("customers"); }
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
  function confirmScreen(title, items, onSave) {
    const prev = view.innerHTML;
    view.innerHTML = `<h1>Please check</h1><p class="envline ${ENV === "TEST" ? "test" : "live"}">Saving to: ${ENV === "TEST" ? "TEST ledger (practice, not real money)" : "LIVE business ledger"}</p><section class="card"><h2>${esc(title)}</h2><dl class="confirm">${items.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl>
      <div id="err"></div><div class="row"><button class="btn secondary" id="back">Change</button><button class="btn" id="ok">Save</button></div></section>`;
    $("#back").onclick = () => { view.innerHTML = prev; };
    $("#ok").onclick = async () => {
      const b = $("#ok"); if (b.disabled) return; b.disabled = true; $("#back").disabled = true; b.textContent = "Saving…";
      try { await onSave(); } catch (e) { b.disabled = false; $("#back").disabled = false; b.textContent = "Save"; if (e.user) showErr(e.message); else if (e.message !== "signin") showErr("Not saved. Please try again."); }
    };
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
    $("#next").onclick = () => {
      const c = state.customers.find(x => x.id === $("#cust").value), a = Number($("#amt").value), p = Number($("#paid").value || 0);
      if (!$("#d").value) return showErr("Please choose the date.");
      if (!c) return showErr("Please choose the customer.");
      if (!(a > 0)) return showErr("Please enter the amount charged.");
      if (p < 0 || p > a) return showErr("Amount paid now must be between 0 and the amount charged.");
      if (p > 0 && !$("#pm").value) return showErr("Please choose how they paid.");
      const data = { date: $("#d").value, customerId: c.id, description: $("#desc").value.trim(), amount: a, paidNow: p, paidMethod: p > 0 ? $("#pm").value : "", expectedCollection: $("#col").value };
      confirmScreen("Customer brings clothes", [["Date", niceDate(data.date)], ["Customer", c.name], ["Clothes", data.description || "Clothes brought"], ["Bill", money(a)],
        ["Paid now", p > 0 ? money(p) + " (" + data.paidMethod + ")" : "Nothing"], ["Still to pay for this order", money(a - p)]], async () => {
        const r = await write("charge.create", data);
        toast(r.queued ? "No internet: saved on this phone, will send later." : (r.duplicate ? "Already saved earlier." : "Saved. Bill " + money(a) + (p > 0 ? ", paid " + money(p) : "")));
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
    $("#next").onclick = () => {
      const c = state.customers.find(x => x.id === $("#cust").value), a = Number($("#amt").value);
      if (!$("#d").value) return showErr("Please choose the date.");
      if (!c) return showErr("Please choose the customer.");
      if (!(a > 0)) return showErr("Please enter the amount received.");
      if (!$("#pm").value) return showErr("Please choose the payment method.");
      const data = { date: $("#d").value, customerId: c.id, amount: a, method: $("#pm").value, notes: $("#notes").value.trim() };
      const after = c.balanceStatus === "Needs verification" ? "Not confirmed" : money(c.balance - a);
      confirmScreen("Customer pays", [["Date", niceDate(data.date)], ["Customer", c.name], ["Amount received", money(a)], ["Method", data.method], ["Notes", data.notes || "—"], ["Balance after payment", after]], async () => {
        const r = await write("payment.create", data);
        toast(r.queued ? "No internet: saved on this phone, will send later." : (r.duplicate ? "Already saved earlier." : "Saved. Received " + money(a)));
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
    $("#next").onclick = () => {
      const a = Number($("#amt").value);
      if (!$("#d").value) return showErr("Please choose the date.");
      if (!$("#cat").value) return showErr("Please choose the category.");
      if (!(a > 0)) return showErr("Please enter the amount spent.");
      if (!$("#pm").value) return showErr("Please choose how it was paid.");
      const data = { date: $("#d").value, category: $("#cat").value, amount: a, method: $("#pm").value, description: $("#desc").value.trim() };
      confirmScreen("Business expense", [["Date", niceDate(data.date)], ["Category", data.category], ["Amount", money(a)], ["Paid with", data.method], ["Description", data.description || "—"]], async () => {
        const r = await write("expense.create", data);
        toast(r.queued ? "No internet: saved on this phone, will send later." : (r.duplicate ? "Already saved earlier." : "Saved. Expense " + money(a)));
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

  // ------------------------------------------------------------ more
  function renderMore() {
    view.innerHTML = `<h1>More</h1>
      <section class="card"><h2>Account</h2><p>${esc(state.me.email)}<br><span class="muted">Role: ${esc(state.me.role)} · ${esc(ENV === "TEST" ? "TEST ledger (practice)" : "LIVE business ledger")}</span></p>
        <button class="btn secondary" id="out" style="width:100%">Sign out</button></section>
      <section class="card"><h2>Install on your phone</h2><p>In Chrome, tap the ⋮ menu, then <b>Add to Home screen</b> (or <b>Install app</b>).</p></section>
      <section class="card"><h2>Voice entry</h2><label for="vlang">Voice language</label><select id="vlang">${VOICE_LANGS.map(([k, l]) => `<option value="${k}" ${store.get("pl_voice_lang", "en-GB") === k ? "selected" : ""}>${esc(l)}</option>`).join("")}</select>
        <p class="hint">If names or amounts are often misunderstood, try another English option.</p></section>
      <section class="card"><h2>Coming next</h2><p class="muted">Reports, cash count.</p><p class="muted">App version ${esc(CFG.appVersion)}</p></section>`;
    $("#out").onclick = signOut;
    $("#vlang").onchange = e => { store.set("pl_voice_lang", e.target.value); toast("Voice language saved"); };
  }

  // ------------------------------------------------------------ start
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => { });
  paintEnv();
  if (!CFG.apiUrl) {
    view.innerHTML = `<section class="card center"><h1>Premium Laundry &amp; Garment Care</h1>
      <p>The LIVE business app is <b>not switched on yet</b>.</p>
      <p class="muted">It will be activated after final checks. For practice, use the TEST app link Giuseppe sent you.</p></section>`;
  } else window.addEventListener("load", boot);
})();
