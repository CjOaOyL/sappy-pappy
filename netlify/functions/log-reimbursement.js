/**
 * log-reimbursement.js
 * Records a reimbursement payment that covers one or more reimbursable expenses.
 * POST /.netlify/functions/log-reimbursement
 * Body: {
 *   password,
 *   paidTo, date, amount, method, description,
 *   coversExpenseIds: [string]
 * }
 *
 * Flips each covered expense's linkedReimbursementId. If amount is omitted,
 * it's set to the sum of covered expenses.
 */

import {
  checkAuth, loadTransactions, saveTransactions, loadConfig,
  sanitizeTransaction, newId, clampMoney, clampStr,
} from './lib/finance.js';

export const handler = async (event) => {
  const auth = await checkAuth(event);
  if (auth.error) return auth.error;
  const { body, headers } = auth;

  const ids = Array.isArray(body.coversExpenseIds) ? body.coversExpenseIds : [];
  if (!ids.length) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'No expenses selected' }) };
  }

  try {
    const config = await loadConfig();
    const list = await loadTransactions();
    const idSet = new Set(ids);

    let coveredTotal = 0;
    const targets = [];
    for (const t of list) {
      if (!idSet.has(t.id)) continue;
      if (t.type !== 'expense' || !t.reimbursable) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: `Transaction ${t.id} is not a reimbursable expense` }) };
      }
      if (t.linkedReimbursementId) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: `Expense ${t.id} already reimbursed` }) };
      }
      coveredTotal += Number(t.amount) || 0;
      targets.push(t);
    }
    if (targets.length !== ids.length) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: 'Some expense ids not found' }) };
    }

    const id = newId();
    const reimbursement = sanitizeTransaction({
      id,
      type: 'reimbursement',
      property: 'general',
      category: 'Reimbursement',
      amount: body.amount != null ? clampMoney(body.amount) : clampMoney(coveredTotal),
      date: body.date,
      description: clampStr(body.description, 1000),
      paidBy: clampStr(body.paidTo, 80), // the person being paid back
      coversExpenseIds: ids,
      method: clampStr(body.method, 40),
      submittedBy: clampStr(body.submittedBy, 80),
    }, config);

    for (const t of targets) t.linkedReimbursementId = id;
    list.push(reimbursement);
    await saveTransactions(list);
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, reimbursement }) };
  } catch (err) {
    console.error('log-reimbursement error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed' }) };
  }
};
