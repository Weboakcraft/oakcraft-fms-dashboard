/**
 * ============================================================================
 *  OakCraft FMS Dashboard — Configuration
 * ============================================================================
 *  SECURITY NOTE (Apps Script):
 *  Every top-level function WITHOUT a trailing underscore can be invoked by
 *  any browser through google.script.run. Therefore ALL internal functions in
 *  this project end with "_" (private). The only public entry points are:
 *     doGet()            – serves the web app shell (no data)
 *     api(requestJson)   – single, authenticated JSON API gateway
 *     initialSetup()     – one-time bootstrap (refuses to run twice, returns nothing)
 *     emergencyResetAdmin() – owner-only recovery (disabled unless a Script
 *                             Property ALLOW_RECOVERY=true is set manually)
 * ============================================================================
 */

const CONFIG = Object.freeze({
  APP_NAME: 'OakCraft FMS',
  APP_SUBTITLE: 'Fulfilment Dashboard',

  /** The FMS spreadsheet (source of truth for order data). */
  SPREADSHEET_ID: '16Dwyzt5-BZWv6PdwRAARLGAeUdrQnHaoXsSiHwTXFow',

  /**
   * Data sources. Columns are 1-based. `range` A:O is read as one block and the
   * extra status column (CN / CE) is read separately, so nothing else in the
   * (very wide) FMS sheets is ever loaded or exposed.
   */
  SOURCES: {
    o2d: {
      key: 'o2d',
      sheetName: 'o2d_for_pc',
      label: 'O2D (Order to Delivery)',
      shortLabel: 'O2D Orders',
      headerRow: 8,
      firstDataRow: 9,
      firstCol: 1,   // A
      lastCol: 15,   // O
      statusCol: 92, // CN
      salespersonCol: 12 // L
    },
    tbo: {
      key: 'tbo',
      sheetName: 'to_be_ordred',
      label: 'To Be Ordered',
      shortLabel: 'To Be Ordered',
      headerRow: 8,
      firstDataRow: 9,
      firstCol: 1,   // A
      lastCol: 15,   // O
      statusCol: 83, // CE
      salespersonCol: 12 // L
    }
  },

  /** Normalised field keys for columns A..O followed by the extra status column. */
  FIELDS: [
    'timestamp', 'orderId', 'orderType', 'transport', 'customer', 'contact',
    'city', 'item', 'imageUrl', 'qty', 'expectedDate', 'salesperson',
    'productType', 'promiseDate', 'orderStatus', 'finalStatus'
  ],
  DATE_FIELDS: ['timestamp', 'expectedDate', 'promiseDate'],

  /** Status vocabulary used in the FMS (column CN / CE). */
  STATUS_DONE: ['DELIVERED TO CUSTOMER'],
  STATUS_CANCELLED: ['ORDER CANCELLED'],

  /** Authentication & session policy. */
  AUTH: {
    SESSION_IDLE_MINUTES: 60,        // sliding idle timeout
    SESSION_MAX_HOURS: 12,           // absolute lifetime of a session
    MAX_FAILED_ATTEMPTS: 5,          // per login ID …
    LOCKOUT_MINUTES: 15,             // … then locked for this long
    HASH_ITERATIONS: 100,            // HMAC-SHA256 rounds (+ secret pepper); kept low for fast sign-in on Apps Script
    PASSWORD_MIN_LENGTH: 8
  },

  /** Server-side cache of parsed sheet data (seconds). */
  DATA_CACHE_SECONDS: 60,
  /** Client auto-sync interval (seconds). */
  CLIENT_SYNC_SECONDS: 120,
  /** Keep at most this many rows in the activity log. */
  ACTIVITY_LOG_MAX_ROWS: 20000,

  ROLES: ['admin', 'manager', 'salesperson']
});

/** Script-property keys (stored server-side, never sent to the browser). */
const PROP = Object.freeze({
  AUTH_DB_ID: 'AUTH_DB_ID',
  PEPPER: 'AUTH_PEPPER',
  SESSION_EPOCH: 'SESSION_EPOCH',
  ALLOW_RECOVERY: 'ALLOW_RECOVERY'
});
