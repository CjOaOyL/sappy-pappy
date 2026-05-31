/**
 * get-transactions.js
 * Return all transactions + config + summary.
 * POST /.netlify/functions/get-transactions
 * Body: { password, filters?: { property?, type?, from?, to? } }
 */

import { checkAuth, loadTransactions, loadConfig, connectBlobs } from './lib/finance.js';

function inRange(date, from, to) {
  if (from && date < from) return false;
  if (to   && date > to)   return false;
  return true;
}

function summarize(list) {
  const out = {
    totalRevenue: 0, totalExpenses: 0,
    pendingReimbursements: 0, pendingPartnerPayouts: 0,
    byProperty: {},
  };
  for (const t of list) {
    if (t.type === 'revenue')  out.totalRevenue  += Number(t.amount) || 0;
    if (t.type === 'expense')  out.totalExpenses += Number(t.amount) || 0;
    const p = t.property || 'general';
    if (!out.byProperty[p]) out.byProperty[p] = { revenue: 0, expenses: 0, net: 0 };
    if (t.type === 'revenue') out.byProperty[p].revenue  += Number(t.amount) || 0;
    if (t.type === 'expense') out.byProperty[p].expenses += Number(t.amount) || 0;
  }
  for (const p of Object.keys(out.byProperty)) {
    out.byProperty[p].net = out.byProperty[p].revenue - out.byProperty[p].expenses;
  }
  // pending reimbursements: reimbursable expenses with no linkedReimbursementId
  for (const t of list) {
    if (t.type === 'expense' && t.reimbursable && !t.linkedReimbursementId) {
      out.pendingReimbursements += Number(t.amount) || 0;
    }
    if (t.type === 'revenue' && !t.partnerPayoutPaidId) {
      out.pendingPartnerPayouts += Number(t.partnerPayoutOwed) || 0;
    }
  }
  return out;
}

export const handler = async (event) => {
  connectBlobs(event);
  const auth = await checkAuth(event);
  if (auth.error) return auth.error;
  const { body, headers } = auth;

  try {
    const [all, config] = await Promise.all([loadTransactions(), loadConfig()]);
    const f = body.filters || {};
    let list = all;
    if (f.property) list = list.filter(t => t.property === f.property);
    if (f.type)     list = list.filter(t => t.type === f.type);
    if (f.from || f.to) list = list.filter(t => inRange(t.date, f.from, f.to));
    list.sort((a, b) => (b.date > a.date ? 1 : b.date < a.date ? -1 : (b.submittedAt > a.submittedAt ? 1 : -1)));
    const summary = summarize(all);
    return { statusCode: 200, headers, body: JSON.stringify({ transactions: list, summary, config }) };
  } catch (err) {
    console.error('get-transactions error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: `Failed to load: ${err && err.message ? err.message : String(err)}` }) };
  }
};
