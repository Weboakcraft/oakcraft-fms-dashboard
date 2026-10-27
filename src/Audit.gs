/**
 * Activity / security log (stored in the private Auth DB → "Activity" sheet).
 */

const ACTIVITY_COLS_ = ['timestamp', 'loginId', 'displayName', 'role', 'event', 'detail', 'result'];

function logActivity_(user, event, detail, result) {
  try {
    const sh = authDb_().getSheetByName('Activity');
    sh.appendRow([
      new Date(),
      sheetSafe_(str_(user && user.loginId, 64)),
      sheetSafe_(str_(user && user.displayName, 60)),
      sheetSafe_(str_(user && user.role, 20)),
      sheetSafe_(str_(event, 40)),
      sheetSafe_(str_(detail, 300)),
      sheetSafe_(str_(result || 'ok', 20))
    ]);
    // Occasionally trim old rows so the log never grows unbounded.
    if (Math.random() < 0.02) {
      const last = sh.getLastRow();
      const excess = last - 1 - CONFIG.ACTIVITY_LOG_MAX_ROWS;
      if (excess > 0) sh.deleteRows(2, excess);
    }
  } catch (e) {
    console.error('logActivity_ failed: ' + e);
  }
}

/** Most recent activity, newest first, optionally filtered. */
function readActivity_(opts) {
  opts = opts || {};
  const limit = Math.max(10, Math.min(1000, Number(opts.limit) || 300));
  const loginFilter = str_(opts.loginId, 64).toLowerCase();
  const eventFilter = str_(opts.event, 40).toUpperCase();

  const sh = authDb_().getSheetByName('Activity');
  const last = sh.getLastRow();
  if (last < 2) return [];
  const scan = Math.min(last - 1, (loginFilter || eventFilter) ? 5000 : limit);
  const vals = sh.getRange(last - scan + 1, 1, scan, ACTIVITY_COLS_.length).getValues();
  const out = [];
  for (let i = vals.length - 1; i >= 0 && out.length < limit; i--) {
    const v = vals[i];
    const rec = {
      timestamp: v[0] instanceof Date ? v[0].toISOString() : String(v[0]),
      loginId: String(v[1]), displayName: String(v[2]), role: String(v[3]),
      event: String(v[4]), detail: String(v[5]), result: String(v[6])
    };
    if (loginFilter && rec.loginId.toLowerCase() !== loginFilter) continue;
    if (eventFilter && rec.event !== eventFilter) continue;
    out.push(rec);
  }
  return out;
}
