/**
 * Shared helpers for finance functions.
 * Store: 'finance'
 *   key 'transactions' -> JSON array of transaction records
 *   key 'config'       -> { partnerName, cleaningFees }
 */

import { getStore } from '@netlify/blobs';
import { randomUUID } from 'crypto';

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

export function getConfiguredStore(name) {
  const ctx = process.env.NETLIFY_BLOBS_CONTEXT;
  if (ctx) {
    try {
      const parsed = JSON.parse(Buffer.from(ctx, 'base64').toString('utf8'));
      const siteID = parsed.siteID || parsed.site_id;
      const token  = parsed.token;
      const url    = parsed.url || parsed.edgeURL;
      if (siteID && token) {
        const opts = { name, siteID, token };
        if (url) opts.url = url;
        return getStore(opts);
      }
    } catch { /* fall through */ }
  }
  const siteID = process.env.NETLIFY_SITE_ID || process.env.SITE_ID;
  const token  = process.env.NETLIFY_BLOBS_TOKEN || process.env.NETLIFY_AUTH_TOKEN;
  if (siteID && token) return getStore({ name, siteID, token });
  return getStore(name);
}

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
  const store = getConfiguredStore(FINANCE_STORE);
  const raw = await store.get(TX_KEY);
  if (!raw) return [];
  try { return JSON.parse(raw); } catch { return []; }
}

export async function saveTransactions(list) {
  const store = getConfiguredStore(FINANCE_STORE);
  await store.set(TX_KEY, JSON.stringify(list));
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
