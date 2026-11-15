// =====================================================================
// Premium Laundry - Ledger migration (Stage 2)
// Adds new columns (to the RIGHT of existing data) and new sheets.
// NEVER changes existing dates, names, amounts, notes or formulas.
// Run previewMigration first, read the log, then applyMigration.
// Safe to run more than once (idempotent).
// =====================================================================

const NEW_COLUMNS = {
  "Charges":  ["Txn ID", "Customer ID", "Order ID", "Expected collection date", "Collection status",
               "Recorded at", "Recorded by", "Source", "Record status", "Reverses Txn ID", "Correction reason"],
  "Payments": ["Txn ID", "Customer ID", "Order ID", "Payment method",
               "Recorded at", "Recorded by", "Source", "Record status", "Reverses Txn ID", "Correction reason"],
  "Expenses": ["Txn ID", "Payment method",
               "Recorded at", "Recorded by", "Source", "Record status", "Reverses Txn ID", "Correction reason"]
};

const NEW_SHEETS = {
  "Customers":      ["Customer ID", "Name", "Other spellings", "Phone", "History status",
                     "Created at", "Created by", "Status", "Merged into", "Notes"],
  "Accounts":       ["Account ID", "Name", "Type", "Provider", "Active",
                     "Opening balance", "Opening date", "Confirmed by"],
  "Cash Movements": ["Txn ID", "Date", "Type", "From account", "To account", "Amount GMD", "Customer ID",
                     "Description", "Recorded at", "Recorded by", "Record status", "Reverses Txn ID", "Correction reason"],
  "Cash Count":     ["Count ID", "Date", "Account", "Counted amount", "Expected amount", "Difference",
                     "Counted by", "Recorded at", "Notes"],
  "Users":          ["Email", "Role", "Active", "Added at", "Added by"],
  "Audit Log":      ["Log ID", "Timestamp", "User email", "Action", "Sheet", "Txn ID",
                     "Request ID", "Result", "Details"],
  "Settings":       ["Key", "Value"]
};

const LEGACY_PREFIX = { "Charges": "L-CHG-", "Payments": "L-PAY-", "Expenses": "L-EXP-" };

function previewMigration() { migrate_(true); }
function applyMigration()   { migrate_(false); }

function migrate_(dryRun) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const log = [];
  const say = m => { log.push(m); Logger.log((dryRun ? "[PREVIEW] " : "") + m); };
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const before = ledgerFingerprint_(ss);
    say("Before: " + JSON.stringify(before.totals));

    // 1. New columns on existing ledger sheets
    Object.keys(NEW_COLUMNS).forEach(name => {
      const sh = ss.getSheetByName(name);
      if (!sh) throw new Error("Missing sheet: " + name);
      const headers = headerRow_(sh);
      let nextCol = headers.length + 1;
      NEW_COLUMNS[name].forEach(h => {
        if (headers.indexOf(h) >= 0) { say(name + ": column '" + h + "' already present"); return; }
        say(name + ": add column " + columnLetter_(nextCol) + " '" + h + "'");
        if (!dryRun) {
          if (sh.getMaxColumns() < nextCol) sh.insertColumnsAfter(sh.getMaxColumns(), nextCol - sh.getMaxColumns());
          sh.getRange(1, nextCol).setValue(h);
          sh.getRange(1, 1).copyFormatToRange(sh, nextCol, nextCol, 1, 1);
        }
        nextCol++;
      });
    });

    // 2. New sheets
    Object.keys(NEW_SHEETS).forEach(name => {
      if (ss.getSheetByName(name)) { say("Sheet '" + name + "' already present"); return; }
      say("Create sheet '" + name + "' with columns: " + NEW_SHEETS[name].join(" | "));
      if (!dryRun) {
        const sh = ss.insertSheet(name, ss.getSheets().length);
        sh.getRange(1, 1, 1, NEW_SHEETS[name].length).setValues([NEW_SHEETS[name]])
          .setFontWeight("bold").setBackground("#173b49").setFontColor("#ffffff");
        sh.setFrozenRows(1);
      }
    });

    // 3. Customers from existing names (exact names, no merging)
    const customers = buildLegacyCustomers_(ss);
    customers.forEach(c => say("Customer " + c.id + " '" + c.name + "' -> history status: " + c.status + (c.isNew ? "" : " (already registered)")));
    if (!dryRun) writeLegacyCustomers_(ss, customers);

    // 4. Legacy row IDs and links (fill blanks only)
    Object.keys(NEW_COLUMNS).forEach(name => {
      const n = fillLegacyRows_(ss, name, customers, dryRun);
      say(name + ": " + n + " existing rows receive ID / Source / Record status" +
          (name !== "Charges" ? " / Payment method = Unknown" : "") + " (dates, names, amounts unchanged)");
    });

    // 5. Users, Settings, Accounts seeds
    const props = PropertiesService.getScriptProperties();
    const owner = (props.getProperty("OWNER_EMAIL") || "").toLowerCase();
    const dev = (props.getProperty("DEVELOPER_EMAIL") || "").toLowerCase();
    say("Users: Owner = " + (owner || "(not configured)") + (dev ? "; Developer = " + dev : ""));
    say("Accounts: 'Cash box' (Cash), opening balance blank; reconciliation disabled");
    if (!dryRun) seedSupportSheets_(ss, owner, dev);

    if (!dryRun) {
      SpreadsheetApp.flush();
      const after = ledgerFingerprint_(ss);
      say("After: " + JSON.stringify(after.totals));
      if (JSON.stringify(before.original) !== JSON.stringify(after.original)) {
        throw new Error("SAFETY CHECK FAILED: original columns changed. Restore from backup.");
      }
      say("SAFETY CHECK PASSED: all original cells identical before and after.");
    }
  } finally {
    lock.releaseLock();
  }
  return log;
}

// Snapshot of the ORIGINAL columns of the three ledger sheets, used to prove nothing changed.
function ledgerFingerprint_(ss) {
  const original = {}, totals = {};
  const width = { "Charges": 6, "Payments": 7, "Expenses": 6 };
  Object.keys(width).forEach(name => {
    const sh = ss.getSheetByName(name);
    const last = Math.max(sh.getLastRow(), 1);
    const vals = sh.getRange(1, 1, last, width[name]).getDisplayValues();
    original[name] = vals;
    const amtCol = name === "Payments" ? 2 : 3;
    totals[name] = vals.slice(1).reduce((s, r) => s + (Number(String(r[amtCol]).replace(/,/g, "")) || 0), 0);
  });
  return { original, totals };
}

function buildLegacyCustomers_(ss) {
  const existing = ss.getSheetByName("Customers");
  const known = {};
  let maxId = 0;
  if (existing && existing.getLastRow() > 1) {
    existing.getRange(2, 1, existing.getLastRow() - 1, 2).getValues().forEach(r => {
      if (r[1]) known[String(r[1]).trim().toLowerCase()] = String(r[0]);
      const k = Number(String(r[0]).replace(/^C-/, "")); if (k > maxId) maxId = k;
    });
  }
  const stats = {};
  const order = [];
  const touch = name => {
    const k = name.toLowerCase();
    if (!stats[k]) { stats[k] = { name, charges: 0, payments: 0, flags: 0 }; order.push(k); }
    return stats[k];
  };
  ss.getSheetByName("Charges").getDataRange().getValues().slice(1).forEach(r => {
    const name = String(r[1] || "").trim(); if (!name) return;
    const s = touch(name); s.charges += Number(r[3]) || 0;
    if (/pending/i.test(String(r[5])) || r[3] === "") s.flags++;
  });
  ss.getSheetByName("Payments").getDataRange().getValues().slice(1).forEach(r => {
    const name = String(r[1] || "").trim(); if (!name) return;
    const s = touch(name); s.payments += Number(r[2]) || 0;
    if (/pending/i.test(String(r[5])) || /previous balance/i.test(String(r[3])) || r[2] === "") s.flags++;
  });
  return order.map(k => {
    const s = stats[k];
    const incomplete = s.flags > 0 || s.payments > s.charges;
    return {
      id: known[k] || ("C-" + String(++maxId).padStart(4, "0")),
      isNew: !known[k],
      name: s.name,
      status: incomplete ? "Incomplete - needs review" : "Reported"
    };
  });
}

function writeLegacyCustomers_(ss, customers) {
  const sh = ss.getSheetByName("Customers");
  const rows = customers.filter(c => c.isNew).map(c =>
    [c.id, c.name, "", "", c.status, "", "Legacy (pre-app)", "Active", "", ""]);
  if (rows.length) sh.getRange(sh.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
}

function fillLegacyRows_(ss, name, customers, dryRun) {
  const sh = ss.getSheetByName(name);
  const last = sh.getLastRow();
  if (last < 2) return 0;
  const headers = headerRow_(sh);
  const idx = h => headers.indexOf(h);
  const data = sh.getRange(1, 1, last, Math.max(headers.length, 1)).getValues();
  const byName = {};
  customers.forEach(c => byName[c.name.toLowerCase()] = c.id);
  let count = 0, seq = 0;
  if (idx("Txn ID") >= 0) data.slice(1).forEach(r => {
    const m = String(r[idx("Txn ID")]).match(/^L-[A-Z]{3}-(\d+)$/); if (m) seq = Math.max(seq, Number(m[1]));
  });
  for (let i = 1; i < data.length; i++) {
    const r = data[i];
    const hasContent = r.slice(0, name === "Payments" ? 7 : 6).some(v => v !== "" && v !== null);
    if (!hasContent) continue;
    if (idx("Txn ID") >= 0 && r[idx("Txn ID")]) continue;
    count++;
    if (dryRun) continue;
    const set = (h, v) => { const c = idx(h); if (c >= 0 && (r[c] === "" || r[c] === null)) sh.getRange(i + 1, c + 1).setValue(v); };
    const fromForm = /recording form/i.test(String(r[4]));
    set("Txn ID", LEGACY_PREFIX[name] + String(++seq).padStart(4, "0"));
    if (name !== "Expenses") {
      const cid = byName[String(r[1] || "").trim().toLowerCase()];
      if (cid) set("Customer ID", cid);
    }
    if (name !== "Charges") set("Payment method", "Unknown");
    set("Source", fromForm ? "Recording form" : "Legacy (pre-app)");
    set("Record status", "Active");
  }
  return count;
}

function seedSupportSheets_(ss, owner, dev) {
  const now = new Date();
  const users = ss.getSheetByName("Users");
  const present = users.getLastRow() > 1
    ? users.getRange(2, 1, users.getLastRow() - 1, 1).getValues().map(r => String(r[0]).toLowerCase()) : [];
  if (owner && present.indexOf(owner) < 0) users.appendRow([owner, "Owner", true, now, "Setup"]);
  if (dev && present.indexOf(dev) < 0) users.appendRow([dev, "Developer", true, now, "Setup"]);

  const settings = ss.getSheetByName("Settings");
  if (settings.getLastRow() < 2) {
    settings.getRange(2, 1, 6, 2).setValues([
      ["Time zone", "Africa/Banjul"],
      ["Currency", "GMD"],
      ["Payment methods", "Cash, Bank, Mobile money"],
      ["Expense categories", "Electricity, Water, Detergent, Packaging, Staff meals, Staff allowances, Salaries, Rent, Transport, Maintenance, Other"],
      ["Cash reconciliation enabled", "FALSE"],
      ["Schema version", "2"]
    ]);
  }
  const acc = ss.getSheetByName("Accounts");
  if (acc.getLastRow() < 2) acc.appendRow(["ACC-CASH", "Cash box", "Cash", "", true, "", "", ""]);
}

function headerRow_(sh) {
  const lastCol = Math.max(sh.getLastColumn(), 1);
  const row = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(v => String(v).trim());
  while (row.length && row[row.length - 1] === "") row.pop();
  return row;
}

function columnLetter_(n) {
  let s = "";
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}
