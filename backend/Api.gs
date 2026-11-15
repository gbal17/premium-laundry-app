// =====================================================================
// Premium Laundry Management App - secure JSON API (Stage 2)
// Every request must carry a Google ID token. The token is verified
// server-side with Google, its audience must be our OAuth client ID,
// and the verified email must be an active user in the "Users" sheet.
// The email sent by the browser is never trusted.
// =====================================================================

const API_VERSION = "2.0.0";
const TZ_FALLBACK = "Africa/Banjul";
const ROLES_ALL = ["Owner", "Developer"];          // Staff role reserved for later
const PAYMENT_METHODS = ["Cash", "Bank", "Mobile money"];
const EXPENSE_CATEGORIES = ["Electricity", "Water", "Detergent", "Packaging", "Staff meals",
  "Staff allowances", "Salaries", "Rent", "Transport", "Maintenance", "Other"];
const MAX_AMOUNT = 1000000;

const ACTIONS = {
  "bootstrap":        { roles: ROLES_ALL, write: false, fn: apiBootstrap_ },
  "dashboard":        { roles: ROLES_ALL, write: false, fn: apiDashboard_ },
  "customers.list":   { roles: ROLES_ALL, write: false, fn: apiCustomersList_ },
  "customer.detail":  { roles: ROLES_ALL, write: false, fn: apiCustomerDetail_ },
  "customers.create": { roles: ROLES_ALL, write: true,  fn: apiCustomerCreate_ },
  "charge.create":    { roles: ROLES_ALL, write: true,  fn: apiChargeCreate_ },
  "payment.create":   { roles: ROLES_ALL, write: true,  fn: apiPaymentCreate_ },
  "expense.create":   { roles: ROLES_ALL, write: true,  fn: apiExpenseCreate_ },
  "selftest":         { roles: ["Developer"], write: false, fn: apiSelfTest_ }
};

// ---------------------------------------------------------------- entry
function doPost(e) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let req = {};
  try {
    req = JSON.parse((e && e.postData && e.postData.contents) || "{}");
  } catch (err) {
    return reply_({ ok: false, code: 400, error: "Bad request." });
  }
  const action = String(req.action || "").slice(0, 40);
  const requestId = String(req.requestId || "").slice(0, 64);

  const auth = verifyIdToken_(req.idToken);
  if (!auth.ok) {
    audit_(ss, auth.email || "", action, "", "", requestId, "Rejected", "Authentication failed: " + auth.reason);
    return reply_({ ok: false, code: 401, error: "Please sign in again." });
  }
  const user = findUser_(ss, auth.email);
  if (!user) {
    audit_(ss, auth.email, action, "", "", requestId, "Rejected", "Account not authorised");
    return reply_({ ok: false, code: 403, error: "This Google account is not authorised for Premium Laundry." });
  }
  const def = ACTIONS[action];
  if (!def) {
    audit_(ss, user.email, action, "", "", requestId, "Rejected", "Unknown action");
    return reply_({ ok: false, code: 400, error: "Unknown request." });
  }
  if (def.roles.indexOf(user.role) < 0) {
    audit_(ss, user.email, action, "", "", requestId, "Rejected", "Role " + user.role + " not allowed");
    return reply_({ ok: false, code: 403, error: "You do not have permission for this action." });
  }

  try {
    if (!def.write) return reply_({ ok: true, data: def.fn(ss, req.data || {}, user) });

    if (!/^[A-Za-z0-9-]{8,64}$/.test(requestId)) throw userError_("Missing request ID.");
    const lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      const prior = findPriorRequest_(ss, requestId);
      if (prior) return reply_({ ok: true, duplicate: true, data: prior });   // double tap / offline resend
      const result = def.fn(ss, req.data || {}, user, requestId);
      if (result && result.needsConfirmation) return reply_({ ok: true, data: result });
      audit_(ss, user.email, action, result.sheet || "", (result.txnIds || []).join(","), requestId, "OK",
        JSON.stringify(result));
      SpreadsheetApp.flush();
      return reply_({ ok: true, data: result });
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    const msg = err && err.userMessage ? err.userMessage : "Something went wrong. Nothing was saved.";
    audit_(ss, user.email, action, "", "", requestId, "Error", String(err && err.message || err).slice(0, 500));
    return reply_({ ok: false, code: err && err.userMessage ? 422 : 500, error: msg });
  }
}

function reply_(obj) {
  obj.apiVersion = API_VERSION;
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function userError_(m) { const e = new Error(m); e.userMessage = m; return e; }

// ---------------------------------------------------------------- authentication
function verifyIdToken_(token) {
  if (!token || typeof token !== "string" || token.length > 4096 || token.split(".").length !== 3) {
    return { ok: false, reason: "No token or malformed token" };
  }
  const clientId = PropertiesService.getScriptProperties().getProperty("OAUTH_CLIENT_ID");
  if (!clientId) return { ok: false, reason: "Server sign-in not configured" };

  const cache = CacheService.getScriptCache();
  const key = "tok_" + Utilities.base64EncodeWebSafe(
    Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, token)).slice(0, 40);
  let info = null;
  const cached = cache.get(key);
  if (cached) {
    info = JSON.parse(cached);
  } else {
    const resp = UrlFetchApp.fetch("https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(token),
      { muteHttpExceptions: true });
    if (resp.getResponseCode() !== 200) return { ok: false, reason: "Google rejected the token (invalid signature or expired)" };
    info = JSON.parse(resp.getContentText());
  }
  const now = Math.floor(Date.now() / 1000);
  const problem = checkClaims_(info, clientId, now);
  if (problem) return { ok: false, reason: problem, email: String(info.email || "").toLowerCase() };
  if (!cached) {
    const ttl = Math.min(600, Number(info.exp) - now);
    if (ttl > 30) cache.put(key, JSON.stringify({ aud: info.aud, iss: info.iss, email: info.email,
      email_verified: info.email_verified, exp: info.exp }), ttl);
  }
  return { ok: true, email: String(info.email).toLowerCase() };
}

// Pure function - unit tested by apiSelfTest_.
function checkClaims_(info, clientId, nowSec) {
  if (!info || typeof info !== "object") return "No claims";
  if (info.aud !== clientId) return "Wrong audience (token issued for another app)";
  if (["accounts.google.com", "https://accounts.google.com"].indexOf(info.iss) < 0) return "Wrong issuer";
  if (String(info.email_verified) !== "true") return "Email not verified by Google";
  if (!info.email) return "No email in token";
  if (!(Number(info.exp) > nowSec)) return "Token expired";
  return null;
}

function findUser_(ss, email) {
  const sh = ss.getSheetByName("Users");
  if (!sh || sh.getLastRow() < 2) return null;
  const rows = sh.getRange(2, 1, sh.getLastRow() - 1, 3).getValues();
  for (const r of rows) {
    if (String(r[0]).trim().toLowerCase() === email && (r[2] === true || String(r[2]).toUpperCase() === "TRUE")) {
      return { email, role: String(r[1]).trim() };
    }
  }
  return null;
}

// ---------------------------------------------------------------- audit & idempotency
function audit_(ss, email, action, sheet, txnIds, requestId, result, details) {
  try {
    const sh = ss.getSheetByName("Audit Log");
    if (!sh) return;
    sh.appendRow(["LOG-" + Utilities.getUuid().slice(0, 8), new Date(), email, action, sheet, txnIds,
      requestId, result, String(details || "").slice(0, 2000)]);
  } catch (e) { /* audit must never break the request */ }
}

function findPriorRequest_(ss, requestId) {
  const sh = ss.getSheetByName("Audit Log");
  if (!sh || sh.getLastRow() < 2) return null;
  const hits = sh.getRange(2, 7, sh.getLastRow() - 1, 1).createTextFinder(requestId).matchEntireCell(true).findAll();
  for (const h of hits) {
    const row = sh.getRange(h.getRow(), 1, 1, 9).getValues()[0];
    if (row[7] === "OK") { try { return JSON.parse(row[8]); } catch (e) { return { txnIds: String(row[5]).split(",") }; } }
  }
  return null;
}

// ---------------------------------------------------------------- helpers
function tz_(ss) { return ss.getSpreadsheetTimeZone() || TZ_FALLBACK; }
function today_(ss) { return Utilities.formatDate(new Date(), tz_(ss), "yyyy-MM-dd"); }
function fmtDate_(ss, v) { return v instanceof Date ? Utilities.formatDate(v, tz_(ss), "yyyy-MM-dd") : ""; }
function safeText_(v, max) {
  const t = String(v == null ? "" : v).replace(/[\r\n\t]+/g, " ").trim().slice(0, max || 200);
  return /^[=+\-@]/.test(t) ? "'" + t : t;
}
function newId_(prefix, ss) {
  return prefix + "-" + Utilities.formatDate(new Date(), tz_(ss), "yyyyMMdd") + "-" +
    Utilities.getUuid().replace(/-/g, "").slice(0, 6).toUpperCase();
}

function table_(ss, name) {
  const sh = ss.getSheetByName(name);
  if (!sh) throw new Error("Missing sheet " + name);
  const lastRow = sh.getLastRow(), lastCol = sh.getLastColumn();
  const values = sh.getRange(1, 1, Math.max(lastRow, 1), Math.max(lastCol, 1)).getValues();
  const headers = values[0].map(h => String(h).trim());
  const col = h => { const i = headers.indexOf(h); if (i < 0) throw new Error(name + " missing column " + h); return i; };
  return { sh, headers, rows: values.slice(1), col };
}

function appendByHeader_(t, obj) {
  const row = t.headers.map(h => (h in obj ? obj[h] : ""));
  t.sh.appendRow(row);
  const r = t.sh.getLastRow();
  Object.keys(obj).forEach(h => {
    if (obj[h] instanceof Date) t.sh.getRange(r, t.col(h) + 1).setNumberFormat(h === "Recorded at" || h === "Created at" ? "yyyy-mm-dd hh:mm:ss" : "yyyy-mm-dd");
  });
  return r;
}

function parseDate_(ss, s, label) {
  s = String(s || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw userError_("Please enter a valid " + label + ".");
  const d = Utilities.parseDate(s, tz_(ss), "yyyy-MM-dd");
  if (Utilities.formatDate(d, tz_(ss), "yyyy-MM-dd") !== s) throw userError_("Please enter a valid " + label + ".");
  if (s > today_(ss)) throw userError_("The " + label + " cannot be in the future.");
  return d;
}

function parseAmount_(v, label, allowZero) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || (!allowZero && n === 0) || n > MAX_AMOUNT || Math.round(n * 100) !== n * 100) {
    throw userError_("Please enter a valid " + label + " in dalasi.");
  }
  return n;
}

function num_(v) { return v === "" || v === null || v === undefined ? null : Number(v); }

// ---------------------------------------------------------------- read model
function loadModel_(ss) {
  const cust = table_(ss, "Customers");
  const ch = table_(ss, "Charges");
  const pay = table_(ss, "Payments");
  const exp = table_(ss, "Expenses");
  const customers = cust.rows.filter(r => r[cust.col("Customer ID")]).map(r => ({
    id: String(r[cust.col("Customer ID")]),
    name: String(r[cust.col("Name")]),
    otherSpellings: String(r[cust.col("Other spellings")] || ""),
    phone: String(r[cust.col("Phone")] || ""),
    historyStatus: String(r[cust.col("History status")] || ""),
    status: String(r[cust.col("Status")] || "Active")
  }));
  const byName = {};
  customers.forEach(c => byName[c.name.trim().toLowerCase()] = c.id);
  const cidOf = (r, t) => String(r[t.col("Customer ID")] || "") || byName[String(r[1] || "").trim().toLowerCase()] || "";

  const charges = ch.rows.filter(r => r[1] !== "" || r[3] !== "").map(r => ({
    txnId: String(r[ch.col("Txn ID")] || ""), date: fmtDate_(ss, r[0]), customer: String(r[1]),
    customerId: cidOf(r, ch), description: String(r[2]), amount: num_(r[3]),
    orderId: String(r[ch.col("Order ID")] || ""), verification: String(r[5]),
    collectionStatus: String(r[ch.col("Collection status")] || "")
  }));
  const payments = pay.rows.filter(r => r[1] !== "" || r[2] !== "").map(r => ({
    txnId: String(r[pay.col("Txn ID")] || ""), date: fmtDate_(ss, r[0]), customer: String(r[1]),
    customerId: cidOf(r, pay), amount: num_(r[2]), appliesTo: String(r[3]),
    method: String(r[pay.col("Payment method")] || "Unknown"), orderId: String(r[pay.col("Order ID")] || ""),
    verification: String(r[5]), notes: String(r[6] || "")
  }));
  const expenses = exp.rows.filter(r => r[1] !== "" || r[3] !== "").map(r => ({
    txnId: String(r[exp.col("Txn ID")] || ""), date: fmtDate_(ss, r[0]), category: String(r[1]),
    description: String(r[2]), amount: num_(r[3]), method: String(r[exp.col("Payment method")] || "Unknown"),
    verification: String(r[5])
  }));
  return { customers, charges, payments, expenses };
}

function balances_(m) {
  const map = {};
  m.customers.forEach(c => map[c.id] = { id: c.id, name: c.name, phone: c.phone, historyStatus: c.historyStatus,
    charges: 0, payments: 0, unknownAmounts: 0, lastActivity: "" });
  const touch = (id, date) => { if (map[id] && date > map[id].lastActivity) map[id].lastActivity = date; };
  m.charges.forEach(x => { const b = map[x.customerId]; if (!b) return;
    if (x.amount === null) b.unknownAmounts++; else b.charges += x.amount; touch(x.customerId, x.date); });
  m.payments.forEach(x => { const b = map[x.customerId]; if (!b) return;
    if (x.amount === null) b.unknownAmounts++; else b.payments += x.amount; touch(x.customerId, x.date); });
  return Object.keys(map).map(id => {
    const b = map[id];
    b.balance = Math.round((b.charges - b.payments) * 100) / 100;
    if (/incomplete/i.test(b.historyStatus) || b.unknownAmounts > 0) b.balanceStatus = "Needs verification";
    else if (b.balance > 0) b.balanceStatus = "Owes";
    else if (b.balance === 0) b.balanceStatus = "Paid up";
    else b.balanceStatus = "Paid more than recorded charges - check";
    return b;
  });
}

// ---------------------------------------------------------------- read actions
function apiBootstrap_(ss, data, user) {
  return { email: user.email, role: user.role, mode: PropertiesService.getScriptProperties().getProperty("LEDGER_MODE") || "UNKNOWN",
    today: today_(ss), timeZone: "Africa/Banjul", currency: "GMD",
    paymentMethods: PAYMENT_METHODS, expenseCategories: EXPENSE_CATEGORIES };
}

function apiDashboard_(ss, data) {
  const from = /^\d{4}-\d{2}-\d{2}$/.test(data.from || "") ? data.from : today_(ss);
  const to = /^\d{4}-\d{2}-\d{2}$/.test(data.to || "") ? data.to : from;
  const m = loadModel_(ss);
  const inRange = d => d && d >= from && d <= to;
  const sum = (list, f) => Math.round(list.reduce((s, x) => s + (f(x) ? (x.amount || 0) : 0), 0) * 100) / 100;
  const byKey = (list, key) => { const o = {}; list.forEach(x => { o[x[key]] = Math.round(((o[x[key]] || 0) + (x.amount || 0)) * 100) / 100; }); return o; };

  const pay = m.payments.filter(x => inRange(x.date));
  const chg = m.charges.filter(x => inRange(x.date));
  const exp = m.expenses.filter(x => inRange(x.date));
  const received = sum(pay, () => true);
  const expenses = sum(exp, () => true);
  const cashIn = sum(pay, x => x.method === "Cash");
  const cashOut = sum(exp, x => x.method === "Cash");
  const unknownMethod = sum(pay, x => x.method === "Unknown") + sum(exp, x => x.method === "Unknown");

  const bal = balances_(m);
  const owes = bal.filter(b => b.balanceStatus === "Owes").sort((a, b) => b.balance - a.balance);
  const verify = bal.filter(b => b.balanceStatus === "Needs verification");
  const credit = bal.filter(b => b.balanceStatus.indexOf("Paid more") === 0);

  return {
    from, to,
    moneyReceived: received, receivedByMethod: byKey(pay, "method"),
    newBills: sum(chg, () => true), billsCount: chg.length,
    expenses, expensesByCategory: byKey(exp, "category"),
    netCashMovement: Math.round((cashIn - cashOut) * 100) / 100,
    netCashNote: unknownMethod ? "Excludes GMD " + unknownMethod + " with unknown payment method" : "",
    cashBalance: null, cashBalanceNote: "Not set - opening balances not yet confirmed",
    confirmedOwingTotal: Math.round(owes.reduce((s, b) => s + b.balance, 0) * 100) / 100,
    owing: owes.map(b => ({ id: b.id, name: b.name, balance: b.balance })),
    needsVerification: verify.map(b => ({ id: b.id, name: b.name, charges: b.charges, payments: b.payments, balance: b.balance })),
    creditCheck: credit.map(b => ({ id: b.id, name: b.name, balance: b.balance })),
    undated: { payments: m.payments.filter(x => !x.date).length, expenses: m.expenses.filter(x => !x.date).length,
      charges: m.charges.filter(x => !x.date).length }
  };
}

function apiCustomersList_(ss) {
  return { customers: balances_(loadModel_(ss)).sort((a, b) => a.name.localeCompare(b.name)) };
}

function apiCustomerDetail_(ss, data) {
  const m = loadModel_(ss);
  const b = balances_(m).filter(x => x.id === data.id)[0];
  if (!b) throw userError_("Customer not found.");
  return { customer: b,
    charges: m.charges.filter(x => x.customerId === data.id),
    payments: m.payments.filter(x => x.customerId === data.id) };
}

// ---------------------------------------------------------------- write actions
function normName_(s) { return String(s || "").toLowerCase().normalize("NFD").replace(/[^a-z]/g, ""); }
function lev_(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

function apiCustomerCreate_(ss, data, user) {
  const name = safeText_(data.name, 80);
  if (name.replace(/[^A-Za-z]/g, "").length < 2) throw userError_("Please enter the customer's name.");
  const phone = safeText_(data.phone, 30);
  const other = safeText_(data.otherSpellings, 200);
  const m = loadModel_(ss);
  const n = normName_(name);
  const matches = m.customers.filter(c => {
    const names = [c.name].concat(c.otherSpellings.split(",")).map(normName_).filter(Boolean);
    return names.some(x => x === n || (n.length >= 4 && lev_(x, n) <= 1) || (n.length >= 4 && (x.indexOf(n) >= 0 || n.indexOf(x) >= 0)));
  });
  const exact = matches.filter(c => normName_(c.name) === n);
  if (exact.length && !data.confirmed) return { needsConfirmation: true, reason: "exact", matches: exact.map(c => ({ id: c.id, name: c.name })) };
  if (matches.length && !data.confirmed) return { needsConfirmation: true, reason: "similar", matches: matches.map(c => ({ id: c.id, name: c.name })) };

  const t = table_(ss, "Customers");
  let max = 0;
  m.customers.forEach(c => { const k = Number(String(c.id).replace(/^C-/, "")); if (k > max) max = k; });
  const id = "C-" + String(max + 1).padStart(4, "0");
  appendByHeader_(t, { "Customer ID": id, "Name": name, "Other spellings": other, "Phone": phone,
    "History status": "Complete (recorded in app)", "Created at": new Date(), "Created by": user.email, "Status": "Active" });
  return { sheet: "Customers", txnIds: [id], customer: { id, name } };
}

function requireCustomer_(ss, id) {
  const c = loadModel_(ss).customers.filter(x => x.id === id && x.status !== "Merged")[0];
  if (!c) throw userError_("Please choose a registered customer.");
  return c;
}

function apiChargeCreate_(ss, data, user) {
  const date = parseDate_(ss, data.date, "date");
  const c = requireCustomer_(ss, data.customerId);
  const amount = parseAmount_(data.amount, "amount charged");
  const paidNow = data.paidNow === "" || data.paidNow == null ? 0 : parseAmount_(data.paidNow, "amount paid now", true);
  if (paidNow > amount) throw userError_("Amount paid now cannot be more than the amount charged.");
  const desc = safeText_(data.description || "Clothes brought", 300);
  let expected = "";
  if (data.expectedCollection) {
    const s = String(data.expectedCollection);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw userError_("Please enter a valid collection date.");
    expected = Utilities.parseDate(s, tz_(ss), "yyyy-MM-dd");
  }
  if (paidNow > 0 && PAYMENT_METHODS.indexOf(data.paidMethod) < 0) throw userError_("Please choose how the customer paid.");

  const now = new Date();
  const orderId = newId_("ORD", ss);
  const chgId = newId_("CHG", ss);
  appendByHeader_(table_(ss, "Charges"), {
    "Date": date, "Customer": c.name, "Description": desc, "Amount GMD": amount, "Reference": "App",
    "Verification": "Pending", "Txn ID": chgId, "Customer ID": c.id, "Order ID": orderId,
    "Expected collection date": expected, "Collection status": "In progress",
    "Recorded at": now, "Recorded by": user.email, "Source": "App", "Record status": "Active" });
  const ids = [chgId];
  if (paidNow > 0) {
    const payId = newId_("PAY", ss);
    appendByHeader_(table_(ss, "Payments"), {
      "Date": date, "Customer": c.name, "Amount GMD": paidNow, "Applies to": "Order " + orderId,
      "Reference": "App", "Verification": "Pending", "Notes": "Paid when clothes were brought",
      "Txn ID": payId, "Customer ID": c.id, "Order ID": orderId, "Payment method": data.paidMethod,
      "Recorded at": now, "Recorded by": user.email, "Source": "App", "Record status": "Active" });
    ids.push(payId);
  }
  return { sheet: paidNow > 0 ? "Charges, Payments" : "Charges", txnIds: ids, orderId,
    remainingForOrder: Math.round((amount - paidNow) * 100) / 100 };
}

function apiPaymentCreate_(ss, data, user) {
  const date = parseDate_(ss, data.date, "date");
  const c = requireCustomer_(ss, data.customerId);
  const amount = parseAmount_(data.amount, "amount received");
  if (PAYMENT_METHODS.indexOf(data.method) < 0) throw userError_("Please choose the payment method.");
  const orderId = safeText_(data.orderId, 40);
  const payId = newId_("PAY", ss);
  appendByHeader_(table_(ss, "Payments"), {
    "Date": date, "Customer": c.name, "Amount GMD": amount,
    "Applies to": orderId ? "Order " + orderId : "Customer balance",
    "Reference": "App", "Verification": "Pending", "Notes": safeText_(data.notes, 300),
    "Txn ID": payId, "Customer ID": c.id, "Order ID": orderId, "Payment method": data.method,
    "Recorded at": new Date(), "Recorded by": user.email, "Source": "App", "Record status": "Active" });
  const b = balances_(loadModel_(ss)).filter(x => x.id === c.id)[0];
  return { sheet: "Payments", txnIds: [payId], balanceAfter: b ? b.balance : null, balanceStatus: b ? b.balanceStatus : "" };
}

function apiExpenseCreate_(ss, data, user) {
  const date = parseDate_(ss, data.date, "date");
  if (EXPENSE_CATEGORIES.indexOf(data.category) < 0) throw userError_("Please choose an expense category.");
  const amount = parseAmount_(data.amount, "amount spent");
  if (PAYMENT_METHODS.indexOf(data.method) < 0) throw userError_("Please choose the payment method.");
  const expId = newId_("EXP", ss);
  appendByHeader_(table_(ss, "Expenses"), {
    "Date": date, "Category": data.category, "Description": safeText_(data.description, 300),
    "Amount GMD": amount, "Reference": "App", "Verification": "Pending",
    "Txn ID": expId, "Payment method": data.method, "Recorded at": new Date(), "Recorded by": user.email,
    "Source": "App", "Record status": "Active" });
  return { sheet: "Expenses", txnIds: [expId] };
}

// ---------------------------------------------------------------- self test (Developer only)
function apiSelfTest_() {
  const cid = "test-client.apps.googleusercontent.com", now = 2000000000;
  const good = { aud: cid, iss: "https://accounts.google.com", email: "a@b.c", email_verified: "true", exp: String(now + 100) };
  const cases = [
    ["valid claims", good, null],
    ["wrong audience", Object.assign({}, good, { aud: "other-app" }), "Wrong audience (token issued for another app)"],
    ["wrong issuer", Object.assign({}, good, { iss: "evil.example" }), "Wrong issuer"],
    ["email not verified", Object.assign({}, good, { email_verified: "false" }), "Email not verified by Google"],
    ["expired", Object.assign({}, good, { exp: String(now - 1) }), "Token expired"]
  ];
  return { results: cases.map(c => { const got = checkClaims_(c[1], cid, now); return { test: c[0], expected: c[2], got, pass: got === c[2] }; }) };
}

// Run from the editor to see the unit tests in the Execution log.
function runSelfTest() { Logger.log(JSON.stringify(apiSelfTest_(), null, 1)); }
