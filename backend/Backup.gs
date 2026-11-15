// =====================================================================
// Premium Laundry - nightly backups with retention + restore helper
// - Copies the whole ledger every night (~23:30 Africa/Banjul) into a PRIVATE folder.
// - Keeps the last 30 daily copies and the first copy of each month for 12 months.
//   Older copies are moved to Drive Trash (recoverable for 30 days), never hard-deleted.
// - Backups are named "BACKUP ... (DO NOT EDIT)" and are never shared.
// Scope: uses only files this script creates (drive.file) + the bound spreadsheet.
// =====================================================================

const BACKUP_FOLDER_PROP = "BACKUP_FOLDER_ID";
const KEEP_DAILY = 30;
const KEEP_MONTHLY = 12;

function nightlyBackup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const tz = ss.getSpreadsheetTimeZone() || "Africa/Banjul";
  const stamp = Utilities.formatDate(new Date(), tz, "yyyy-MM-dd HHmm");
  const folder = backupFolder_(ss);
  const copy = ss.copy("BACKUP " + stamp + " - " + ss.getName() + " (DO NOT EDIT)");   // private copy, not shared
  const file = DriveApp.getFileById(copy.getId());
  file.moveTo(folder);
  Logger.log("Backup created: " + file.getName() + " id=" + file.getId());
  applyRetention_(folder, tz);
  return file.getId();
}

function backupFolder_(ss) {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty(BACKUP_FOLDER_PROP);
  if (id) { try { return DriveApp.getFolderById(id); } catch (e) { /* recreate below */ } }
  const f = DriveApp.createFolder("Premium Laundry Backups - " + ss.getName());
  props.setProperty(BACKUP_FOLDER_PROP, f.getId());
  return f;
}

function applyRetention_(folder, tz) {
  const files = [];
  const it = folder.getFiles();
  while (it.hasNext()) { const f = it.next(); if (/^BACKUP /.test(f.getName())) files.push(f); }
  files.sort((a, b) => b.getDateCreated() - a.getDateCreated());       // newest first
  const keepMonths = {};
  files.forEach((f, i) => {
    const month = Utilities.formatDate(f.getDateCreated(), tz, "yyyy-MM");
    if (i < KEEP_DAILY) return;                                         // recent daily copies
    if (!keepMonths[month] && Object.keys(keepMonths).length < KEEP_MONTHLY) { keepMonths[month] = true; return; }
    f.setTrashed(true);                                                 // recoverable from Trash for 30 days
    Logger.log("Retention: moved to Trash " + f.getName());
  });
}

function installNightlyBackup() {
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === "nightlyBackup").forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger("nightlyBackup").timeBased().atHour(23).nearMinute(30).everyDays(1).inTimezone("Africa/Banjul").create();
  Logger.log("Nightly backup scheduled at about 23:30 Africa/Banjul.");
}

// Restore drill: compares a backup with the live ledger (read-only). Restoring itself is done by
// opening the backup and copying the needed sheet/rows back, or via File > Version history.
function verifyLatestBackup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const it = backupFolder_(ss).getFiles();
  let latest = null;
  while (it.hasNext()) { const f = it.next(); if (!latest || f.getDateCreated() > latest.getDateCreated()) latest = f; }
  if (!latest) throw new Error("No backup found.");
  const b = SpreadsheetApp.openById(latest.getId());
  const report = ["Charges", "Payments", "Expenses", "Customers", "Users"].map(name => {
    const live = ss.getSheetByName(name), bk = b.getSheetByName(name);
    const lv = live ? live.getDataRange().getDisplayValues() : [], bv = bk ? bk.getDataRange().getDisplayValues() : [];
    return name + ": live rows " + lv.length + ", backup rows " + bv.length + ", identical=" + (JSON.stringify(lv) === JSON.stringify(bv));
  });
  Logger.log("Latest backup: " + latest.getName() + "\n" + report.join("\n"));
}
