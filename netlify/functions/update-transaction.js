/**
 * update-transaction.js
 * Edit or delete a transaction by id.
 * POST /.netlify/functions/update-transaction
 * Body: { password, id, action: 'update'|'delete', patch? }
 *
 * Deleting a reimbursement frees its linked expenses; deleting a partner-payout
 * frees its linked revenues.
 */

import {
  checkAuth, loadTransactions, saveTransactions,
  loadConfig, sanitizeTransaction,
} from './lib/finance.js';

export const handler = async (event) => {
  const auth = await checkAuth(event);
  if (auth.error) return auth.error;
  const { body, headers } = auth;

  if (!body.id) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing id' }) };
  }

  try {
    const list = await loadTransactions();
    const idx = list.findIndex(t => t.id === body.id);
    if (idx === -1) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: 'Not found' }) };
    }
    const existing = list[idx];

    if (body.action === 'delete') {
      if (existing.type === 'reimbursement') {
        for (const t of list) {
          if (t.type === 'expense' && t.linkedReimbursementId === existing.id) {
            t.linkedReimbursementId = null;
          }
        }
      }
      if (existing.type === 'partner-payout') {
        for (const t of list) {
          if (t.type === 'revenue' && t.partnerPayoutPaidId === existing.id) {
            t.partnerPayoutPaidId = null;
          }
        }
      }
      list.splice(idx, 1);
      await saveTransactions(list);
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, deleted: existing.id }) };
    }

    const config = await loadConfig();
    const merged = { ...existing, ...(body.patch || {}), id: existing.id, type: existing.type, submittedAt: existing.submittedAt };
    list[idx] = sanitizeTransaction(merged, config);
    await saveTransactions(list);
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, transaction: list[idx] }) };
  } catch (err) {
    console.error('update-transaction error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed' }) };
  }
};
