/**
 * submit-transaction.js
 * Append a new transaction (expense or revenue).
 * POST /.netlify/functions/submit-transaction
 * Body: { password, transaction: {...} }
 */

import {
  checkAuth, loadTransactions, saveTransactions,
  loadConfig, sanitizeTransaction, connectBlobs} from './lib/finance.js';

export const handler = async (event) => {
  connectBlobs(event);
  const auth = await checkAuth(event);
  if (auth.error) return auth.error;
  const { body, headers } = auth;

  if (!body.transaction || typeof body.transaction !== 'object') {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing transaction' }) };
  }
  if (!['expense', 'revenue'].includes(body.transaction.type)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Use log-reimbursement / log-partner-payout for those types' }) };
  }

  try {
    const config = await loadConfig();
    const list = await loadTransactions();
    const t = sanitizeTransaction(body.transaction, config);
    list.push(t);
    await saveTransactions(list);
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, transaction: t }) };
  } catch (err) {
    console.error('submit-transaction error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to save' }) };
  }
};
