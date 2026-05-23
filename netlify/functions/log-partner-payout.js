/**
 * log-partner-payout.js
 * Records a payout to the partner that covers one or more revenue entries.
 * POST /.netlify/functions/log-partner-payout
 * Body: {
 *   password, date, amount, method, description,
 *   coversRevenueIds: [string]
 * }
 *
 * Flips each covered revenue's partnerPayoutPaidId. If amount is omitted,
 * it's set to the sum of partnerPayoutOwed across covered revenues.
 */

import {
  checkAuth, loadTransactions, saveTransactions, loadConfig,
  sanitizeTransaction, newId, clampMoney, clampStr,
} from './lib/finance.js';

export const handler = async (event) => {
  const auth = await checkAuth(event);
  if (auth.error) return auth.error;
  const { body, headers } = auth;

  const ids = Array.isArray(body.coversRevenueIds) ? body.coversRevenueIds : [];
  if (!ids.length) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'No revenues selected' }) };
  }

  try {
    const config = await loadConfig();
    const list = await loadTransactions();
    const idSet = new Set(ids);

    let owedTotal = 0;
    const targets = [];
    for (const t of list) {
      if (!idSet.has(t.id)) continue;
      if (t.type !== 'revenue') {
        return { statusCode: 400, headers, body: JSON.stringify({ error: `Transaction ${t.id} is not revenue` }) };
      }
      if (t.partnerPayoutPaidId) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: `Revenue ${t.id} payout already paid` }) };
      }
      owedTotal += Number(t.partnerPayoutOwed) || 0;
      targets.push(t);
    }
    if (targets.length !== ids.length) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: 'Some revenue ids not found' }) };
    }

    const id = newId();
    const payout = sanitizeTransaction({
      id,
      type: 'partner-payout',
      property: 'general',
      category: 'Partner Payout',
      amount: body.amount != null ? clampMoney(body.amount) : clampMoney(owedTotal),
      date: body.date,
      description: clampStr(body.description, 1000),
      paidBy: clampStr(config.partnerName, 80),
      coversRevenueIds: ids,
      method: clampStr(body.method, 40),
      submittedBy: clampStr(body.submittedBy, 80),
    }, config);

    for (const t of targets) t.partnerPayoutPaidId = id;
    list.push(payout);
    await saveTransactions(list);
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, payout }) };
  } catch (err) {
    console.error('log-partner-payout error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed' }) };
  }
};
