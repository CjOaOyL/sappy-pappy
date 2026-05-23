/**
 * finance-config.js
 * GET (action='get') or save (action='save') the finance config.
 * POST /.netlify/functions/finance-config
 * Body: { password, action: 'get'|'save', config? }
 */

import {
  checkAuth, loadConfig, saveConfig, clampStr, clampMoney, DEFAULT_CONFIG,
} from './lib/finance.js';

function sanitizeConfig(input) {
  const cleaningFees = {};
  for (const prop of ['bluebear', 'hikercabin']) {
    const src = input?.cleaningFees?.[prop] || {};
    cleaningFees[prop] = {
      short:     clampMoney(src.short ?? DEFAULT_CONFIG.cleaningFees[prop].short),
      long:      clampMoney(src.long  ?? DEFAULT_CONFIG.cleaningFees[prop].long),
      threshold: Math.max(1, Math.min(30, Number(src.threshold) || DEFAULT_CONFIG.cleaningFees[prop].threshold)),
    };
  }
  return {
    partnerName: clampStr(input?.partnerName || DEFAULT_CONFIG.partnerName, 80),
    cleaningFees,
    updatedAt: new Date().toISOString(),
  };
}

export const handler = async (event) => {
  const auth = await checkAuth(event);
  if (auth.error) return auth.error;
  const { body, headers } = auth;

  try {
    if (body.action === 'save') {
      const clean = sanitizeConfig(body.config || {});
      await saveConfig(clean);
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, config: clean }) };
    }
    const config = await loadConfig();
    return { statusCode: 200, headers, body: JSON.stringify({ config }) };
  } catch (err) {
    console.error('finance-config error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed' }) };
  }
};
