// Integration test for the finance transaction writers (submit / update /
// log-partner-payout) — exercises the lock-serialized read-modify-write in
// netlify/functions/lib/finance.js. Creates tagged rows and deletes them.
//
//   node scripts/finance-write-test.mjs <baseUrl> <envFileWithFINANCE_PASSWORD>
//   e.g. node scripts/finance-write-test.mjs https://sappy-pappy.com ../jaquanslist/.env
//
// Run it against a draft deploy or production. The `netlify dev` sandbox
// (file-based Blobs server) has no atomic conditional writes, so the
// "concurrent adds" assertion is expected to fail there; everything else
// should pass.
import fs from 'fs';
const [BASE, ENVFILE] = process.argv.slice(2);
const env = fs.readFileSync(ENVFILE, 'utf8');
const PW = (env.match(/^FINANCE_PASSWORD=(.*)$/m) || [])[1]?.trim().replace(/^["']|["']$/g, '');
const call = async (path, body = {}) => {
  const r = await fetch(`${BASE}/.netlify/functions/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: PW, ...body }) });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = { raw: t }; }
  return { status: r.status, ...j };
};
const TAG = 'MUTATE-TEST-' + Date.now();
const count = async () => (await call('get-transactions')).transactions.length;
const mine = async () => (await call('get-transactions')).transactions.filter(t => (t.description || '').startsWith(TAG));
const assert = (c, m) => { if (!c) { console.error('FAIL:', m); process.exitCode = 1; } else console.log('ok  :', m); };
const rev = (i) => ({ type: 'revenue', property: 'hikercabin', category: 'Other', date: '2026-01-01', amount: 10 + i, nights: 2, guestName: 'Test ' + i, description: `${TAG} row ${i}` });

const start = await count();
console.log('start rows', start);

// 1. five sequential adds (what the UI does)
for (let i = 0; i < 5; i++) { const r = await call('submit-transaction', { transaction: rev(i) }); assert(r.ok, `seq add ${i} -> ${r.status}`); }
assert((await count()) === start + 5, 'all 5 sequential adds present');

// 2. five concurrent adds (exercises the write-verify retry)
const rs = await Promise.all([5, 6, 7, 8, 9].map(i => call('submit-transaction', { transaction: rev(i) })));
assert(rs.every(r => r.ok), 'concurrent adds all returned ok: ' + rs.map(r => r.status).join(','));
const afterConc = await count();
assert(afterConc === start + 10, `all 5 concurrent adds present (have ${afterConc - start - 5}/5)`);

// 3. update + 404
const rows = await mine();
const u = await call('update-transaction', { id: rows[0].id, action: 'update', patch: { description: `${TAG} row 0 edited` } });
assert(u.ok && u.transaction.description.endsWith('edited'), 'update patch applied');
const nf = await call('update-transaction', { id: 'nope', action: 'update', patch: {} });
assert(nf.status === 404, 'update unknown id -> 404');

// 4. partner payout over two rows, then error on re-pay, then delete payout frees them
const p = await call('log-partner-payout', { coversRevenueIds: [rows[1].id, rows[2].id], date: '2026-01-02', method: 'test', description: `${TAG} payout` });
assert(p.ok && p.payout, 'partner payout logged');
const again = await call('log-partner-payout', { coversRevenueIds: [rows[1].id], date: '2026-01-02' });
assert(again.status === 400, 're-pay same revenue -> 400');
let cur = await mine();
assert(cur.filter(t => t.partnerPayoutPaidId === p.payout.id).length === 2, 'two revenues flagged paid');
const dp = await call('update-transaction', { id: p.payout.id, action: 'delete' });
assert(dp.ok, 'delete payout');
cur = await mine();
assert(cur.every(t => !t.partnerPayoutPaidId), 'deleting payout freed the revenues');

// 5. cleanup
for (const t of await mine()) { const d = await call('update-transaction', { id: t.id, action: 'delete' }); assert(d.ok, `delete ${t.id.slice(0, 8)}`); }
const end = await count();
assert(end === start, `row count back to start (${end} vs ${start})`);
console.log(process.exitCode ? 'SOME CHECKS FAILED' : 'ALL CHECKS PASSED');
