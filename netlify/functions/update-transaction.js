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
  checkAuth, mutateTransactions,
  loadConfig, sanitizeTransaction, connectBlobs} from './lib/finance.js';

export const handler = async (event) => {
  connectBlobs(event);
  const auth = await checkAuth(event);
  if (auth.error) return auth.error;
  const { body, headers } = auth;

  if (!body.id) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing id' }) };
  }

  try {
    const config = body.action === 'delete' ? null : await loadConfig();
    const res = await mutateTransactions(list => {
      const idx = list.findIndex(t => t.id === body.id);
      if (idx === -1) return { write: false, status: 404, error: 'Not found' };
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
        return { deleted: existing.id };
      }

      const merged = { ...existing, ...(body.patch || {}), id: existing.id, type: existing.type, submittedAt: existing.submittedAt };
      list[idx] = sanitizeTransaction(merged, config);
      return { transaction: list[idx] };
    });

    if (res.write === false) {
      return { statusCode: res.status, headers, body: JSON.stringify({ error: res.error }) };
    }
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, ...res }) };
  } catch (err) {
    console.error('update-transaction error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed' }) };
  }
};
