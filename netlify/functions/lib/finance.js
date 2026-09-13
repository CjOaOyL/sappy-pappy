/**
 * Shared helpers for finance functions.
 * Store: 'finance'
 *   key 'transactions' -> JSON array of transaction records
 *                         (write ONLY through mutateTransactions)
 *   key 'config'       -> { partnerName, cleaningFees }
 */

import { randomUUID } from 'crypto';

// Imported (not bare re-exported) because the helpers below call
// getConfiguredStore directly — `export ... from` creates no local binding.
import { connectBlobs, getConfiguredStore } from './blobs.js';
export { connectBlobs, getConfiguredStore };

export const FINANCE_STORE = 'finance';
export const TX_KEY = 'transactions';
export const CONFIG_KEY = 'config';

export const PROPERTIES = ['bluebear', 'hikercabin', 'general', 'both'];
export const TX_TYPES = ['expense', 'revenue', 'reimbursement', 'partner-payout'];

export const DEFAULT_CONFIG = {
  partnerName: 'Partner',
  cleaningFees: {
    bluebear:   { short: 75,  long: 150, threshold: 2 },
    hikercabin: { short: 100, long: 175, threshold: 2 },
  },
};

export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function checkAuth(event) {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': 'same-origin',
    'X-Content-Type-Options': 'nosniff',
  };
  if (event.httpMethod !== 'POST') {
    return { error: { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) } };
  }
  const pw = process.env.FINANCE_PASSWORD;
  if (!pw) {
    return { error: { statusCode: 500, headers, body: JSON.stringify({ error: 'Finance not configured' }) } };
  }
  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { error: { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) } }; }
  if (!safeEqual(body.password || '', pw)) {
    await new Promise(r => setTimeout(r, 500));
    return { error: { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) } };
  }
  return { body, headers };
}

export async function loadTransactions() {
  // Strong consistency so a read right after a write never returns the old list.
  const store = getConfiguredStore(FINANCE_STORE, { consistency: 'strong' });
  const raw = await store.get(TX_KEY);
  if (!raw) return [];
  try { return JSON.parse(raw); } catch { return []; }
}

const LOCK_KEY = 'transactions.lock';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Serialize writers with a lock blob.
 *
 * Measured on the production edge (2026-09-13): `onlyIfNew` creates ARE atomic
 * under concurrency (exactly one of N simultaneous creates wins), while
 * `onlyIfMatch` (ETag compare-and-swap) is NOT — N simultaneous writes with
 * the same ETag were all accepted. So the mutex is built on onlyIfNew.
 *
 * The lock carries an expiry so a holder killed mid-write (function timeout)
 * cannot wedge the store: an expired lock is deleted and re-acquired. That
 * takeover is the one remaining race (two waiters both see it expired), and
 * it needs an already-crashed holder plus two simultaneous waiters — vastly
 * rarer than the plain read-modify-write race this replaces.
 */
async function withTransactionsLock(store, fn, { waitMs = 8000, ttlMs = 15000 } = {}) {
  const me = newId();
  const deadline = Date.now() + waitMs;
  for (;;) {
    const r = await store.set(LOCK_KEY, me, { onlyIfNew: true, metadata: { owner: me, expiresAt: Date.now() + ttlMs } });
    if (r.modified) break;
    const cur = await store.getWithMetadata(LOCK_KEY, { type: 'text' });
    if (!cur) continue; // released between our attempt and this read
    const expiresAt = Number(cur.metadata && cur.metadata.expiresAt) || 0;
    if (expiresAt && Date.now() > expiresAt) {
      console.warn('withTransactionsLock: clearing expired lock held by', cur.data);
      await store.delete(LOCK_KEY);
      continue;
    }
    if (Date.now() > deadline) throw new Error('withTransactionsLock: timed out waiting for the transactions lock');
    await sleep(80 + Math.floor(Math.random() * 170));
  }
  try {
    return await fn();
  } finally {
    try {
      const cur = await store.getWithMetadata(LOCK_KEY, { type: 'text' });
      if (cur && cur.data === me) await store.delete(LOCK_KEY);
    } catch (e) { console.warn('withTransactionsLock: release failed:', e.message); }
  }
}

/**
 * Atomically update the transactions list.
 *
 * The list lives in one blob, so every writer used to do load → change → save.
 * Blobs reads are eventually consistent by default, so a request arriving a
 * second after another could load the pre-write list and clobber the newer
 * row (this dropped 3 of 7 back-to-back adds on 2026-09-13).
 *
 * Now, under the lock above:
 *   1. read the list with strong consistency (needs the uncached edge URL —
 *      see connectBlobs in blobs.js) plus its ETag,
 *   2. run `mutator(list)` (mutate in place; return a value to hand back),
 *   3. write with `onlyIfMatch: etag` as a belt-and-braces check (sequential
 *      CAS is enforced), or `onlyIfNew` when the key doesn't exist yet. If the
 *      backend returned no ETag (the `netlify dev` sandbox), write and verify
 *      a writeId in the metadata instead.
 *
 * `mutator` may run more than once, so keep it free of side effects other than
 * changing `list`. Return `{ write: false, ...anything }` to skip the write
 * (e.g. a validation failure) — the object is returned as-is.
 */
export async function mutateTransactions(mutator, { attempts = 3 } = {}) {
  const store = getConfiguredStore(FINANCE_STORE, { consistency: 'strong' });
  const debug = (...a) => { if (process.env.FINANCE_DEBUG) console.warn('mutateTransactions:', ...a); };

  return withTransactionsLock(store, async () => {
    for (let attempt = 0; attempt < attempts; attempt++) {
      const cur = await store.getWithMetadata(TX_KEY, { type: 'text' });
      let list = [];
      if (cur && cur.data) { try { list = JSON.parse(cur.data); } catch { list = []; } }

      const out = await mutator(list);
      if (out && out.write === false) return out;

      const writeId = newId();
      const metadata = { writeId, writtenAt: new Date().toISOString(), count: list.length };
      const body = JSON.stringify(list);

      let landed;
      if (!cur) {
        landed = !!(await store.set(TX_KEY, body, { onlyIfNew: true, metadata })).modified;
        debug('create', { landed });
      } else if (cur.etag) {
        landed = !!(await store.set(TX_KEY, body, { onlyIfMatch: cur.etag, metadata })).modified;
        debug('cas', { etag: cur.etag, landed });
      } else {
        await store.set(TX_KEY, body, { metadata });
        const back = await store.getWithMetadata(TX_KEY, { type: 'text' });
        landed = !!(back && back.metadata && back.metadata.writeId === writeId);
        debug('verify-fallback', { landed });
      }
      if (landed) return out;

      console.warn(`mutateTransactions: write did not land, retrying (attempt ${attempt + 1}/${attempts})`);
      await sleep(50 + Math.floor(Math.random() * 150));
    }
    throw new Error(`mutateTransactions: gave up after ${attempts} attempts`);
  });
}

export async function loadConfig() {
  const store = getConfiguredStore(FINANCE_STORE);
  const raw = await store.get(CONFIG_KEY);
  if (!raw) return { ...DEFAULT_CONFIG };
  try { return { ...DEFAULT_CONFIG, ...JSON.parse(raw) }; }
  catch { return { ...DEFAULT_CONFIG }; }
}

export async function saveConfig(config) {
  const store = getConfiguredStore(FINANCE_STORE);
  await store.set(CONFIG_KEY, JSON.stringify(config));
}

export function newId() { return randomUUID(); }

export function clampMoney(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.round(v * 100) / 100;
}

export function clampStr(s, max = 500) {
  return String(s == null ? '' : s).slice(0, max);
}

/**
 * Compute the partner payout owed for a booking.
 *   payout = 0.25 * (netPayout - cleaningFee) + cleaningFee
 * cleaningFee comes from config; pass nights to pick short vs long band.
 * If caller supplies cleaningFee directly, that wins.
 */
export function computePartnerPayout({ netPayout, nights, property, cleaningFee, config }) {
  const np = Number(netPayout) || 0;
  let fee = Number(cleaningFee);
  if (!Number.isFinite(fee)) {
    const cfg = config?.cleaningFees?.[property];
    if (cfg) {
      fee = (Number(nights) || 0) > (cfg.threshold || 2) ? cfg.long : cfg.short;
    } else {
      fee = 0;
    }
  }
  const net = np - fee;
  const partnerShare = 0.25 * net + fee;
  return {
    cleaningFee: clampMoney(fee),
    partnerPayoutOwed: clampMoney(Math.max(0, partnerShare)),
  };
}

export function sanitizeTransaction(input, config) {
  const type = TX_TYPES.includes(input.type) ? input.type : 'expense';
  const property = PROPERTIES.includes(input.property) ? input.property : 'general';
  const t = {
    id: input.id || newId(),
    type,
    property,
    category:    clampStr(input.category, 80),
    amount:      clampMoney(input.amount),
    date:        /^\d{4}-\d{2}-\d{2}$/.test(input.date) ? input.date : new Date().toISOString().slice(0, 10),
    description: clampStr(input.description, 1000),
    paidBy:      clampStr(input.paidBy, 80),
    vendor:      clampStr(input.vendor, 120),
    source:      clampStr(input.source || 'manual', 40),
    receiptImageKey: input.receiptImageKey ? clampStr(input.receiptImageKey, 200) : null,
    submittedAt: input.submittedAt || new Date().toISOString(),
    submittedBy: clampStr(input.submittedBy, 80),
  };
  if (type === 'expense') {
    t.reimbursable = !!input.reimbursable;
    t.linkedReimbursementId = input.linkedReimbursementId || null;
  }
  if (type === 'revenue') {
    t.nights       = Number(input.nights) || null;
    if (input.guestName) t.guestName = clampStr(input.guestName, 120);
    if (input.platform)  t.platform  = clampStr(input.platform, 40); // airbnb|vrbo|direct|other
    const calc = computePartnerPayout({
      netPayout: t.amount,
      nights: t.nights,
      property: t.property,
      cleaningFee: input.cleaningFee,
      config,
    });
    t.cleaningFee = calc.cleaningFee;
    t.partnerPayoutOwed = calc.partnerPayoutOwed;
    t.partnerPayoutPaidId = input.partnerPayoutPaidId || null;
  }
  if (type === 'reimbursement') {
    t.coversExpenseIds = Array.isArray(input.coversExpenseIds)
      ? input.coversExpenseIds.map(s => clampStr(s, 80))
      : [];
    t.method = clampStr(input.method, 40); // venmo|zelle|cash|other
  }
  if (type === 'partner-payout') {
    t.coversRevenueIds = Array.isArray(input.coversRevenueIds)
      ? input.coversRevenueIds.map(s => clampStr(s, 80))
      : [];
    t.method = clampStr(input.method, 40);
  }
  return t;
}
