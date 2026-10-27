/* Deterministic, realistic mock FMS rows (same shape as the real sheet). */
function rng(seed) { let s = seed; return () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296; }
const SP = ['NITI KUMARI', 'UJALA RAJPUT', 'AMIRA SAIKH', 'VISHU MITTAL', 'MAYANK MITTAL'];
const CUST = ['KAMESHTI HEALTHCARE PRIVATE LIMITED', 'Sudhir Bhatnagar', 'SOFTEC ENTERPRISES', 'MOTORSPACE AUTOSALES PRIVATE LIMITED', 'Roopendra Pal', 'kanha nature oil', 'SARVU INTERNATIONAL', 'Lumami', 'Greenfield Infra LLP', 'Aarav Interiors', 'Blue Lotus Hotels', 'Nimbus Coworking'];
const CITY = ['Rajasthan', 'Uttrakhand', 'Delhi', 'Lucknow', 'Madhya Pradesh', 'Bahadurgarh', 'Manipur', 'Gurugram', 'Noida', 'Jaipur'];
const ITEM = ['OC-HURRICANE-GREY_50', 'Boom Back', 'VISITOR CHAIR', 'Manual Recliner', 'IMPORTED CHAIR', 'axora', 'OFFICE TABLE', 'MATRIX BLACK', 'Executive Chair', 'Workstation 4-Seater'];
const PT = ['Regular Products', 'Non Regular Products', "Other's Products"];
const TR = ['By Transport', 'By Porter', 'Self Pickup'];
const ST = ['Delivered To Customer', 'Delivered To Customer', 'Delivered To Customer', 'Ready For Dispatch', 'Order In Process', 'Order Dispatch From Factory', 'Pending From Customer', 'Order Cancelled', ''];

function d2(n) { return ('0' + n).slice(-2); }
function ddmmyyyy(d) { return d2(d.getUTCDate()) + '/' + d2(d.getUTCMonth() + 1) + '/' + d.getUTCFullYear(); }

function makeRows(count, seed, prefix, orderType) {
  const r = rng(seed);
  const pick = (a) => a[Math.floor(r() * a.length)];
  const rows = [];
  let i = 0, orderNo = 600;
  const start = Date.UTC(2026, 4, 1);
  while (rows.length < count) {
    const lines = 1 + Math.floor(r() * 3);
    const t = new Date(start + Math.floor(r() * 178) * 86400000 + Math.floor(r() * 36000000));
    const sp = pick(SP), cust = pick(CUST), city = pick(CITY), tr = pick(TR);
    const ot = orderType || (r() < 0.7 ? 'EXISTING PRODUCT' : 'CUSTOMIZED PRODUCT');
    const id = prefix + (orderNo++);
    for (let l = 0; l < lines && rows.length < count; l++) {
      const exp = new Date(t.getTime() + (2 + Math.floor(r() * 12)) * 86400000);
      const prom = new Date(t.getTime() + (3 + Math.floor(r() * 18)) * 86400000);
      const recent = t.getTime() > Date.UTC(2026, 9, 1);
      const status = recent ? pick(['Order In Process', 'Ready For Dispatch', 'Pending From Customer', '', 'Order Dispatch From Factory']) : pick(ST);
      const ts = ddmmyyyy(t) + ' ' + d2(t.getUTCHours()) + ':' + d2(t.getUTCMinutes()) + ':' + d2(t.getUTCSeconds());
      rows.push([ts, id, ot, tr, cust, String(7000000000 + Math.floor(r() * 2999999999)), city, pick(ITEM),
        'https://drive.google.com/thumbnail?id=FAKE' + (i++) + '&sz=w1200', 1 + Math.floor(r() * 60), ddmmyyyy(exp), sp, pick(PT), ddmmyyyy(prom), '', status]);
    }
  }
  return rows;
}
module.exports = { o2d: () => makeRows(380, 7, 'ORD0', null), tbo: () => makeRows(27, 11, 'ORD19', 'TO BE ORDERED'), SP };
