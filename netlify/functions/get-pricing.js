/**
 * get-pricing.js
 * Returns pricing configuration from Netlify Blobs for a given property.
 *
 * GET /.netlify/functions/get-pricing?property=bluebear|hikercabin|both
 *   bluebear   — Blue Bear Cottage pricing
 *   hikercabin — Hiker Delight Homestead Cabin pricing
 *   both       — Returns { bluebear: {...}, hikercabin: {...} } for combined booking
 */

import { connectBlobs, getConfiguredStore } from './lib/blobs.js';


export const DEFAULT_CONFIG = {
  baseRate: 150,
  cleaningFee: 85,
  minimumStay: 2,
  weekendPremium: 25,
  taxRate: 0,
  bufferBefore: 1,
  bufferAfter: 1,
  seasons: [
    { label: 'Summer Peak',    startMMDD: '06-15', endMMDD: '08-31', rate: 175 },
    { label: 'Holiday Season', startMMDD: '12-20', endMMDD: '01-05', rate: 200 },
  ],
  overrides: {},
  guestNotes: 'Please leave the property as you found it. Quiet hours 10pm–8am. No smoking indoors.',
  updatedAt: null,
};

export const CABIN_DEFAULT_CONFIG = {
  baseRate: 89,
  cleaningFee: 60,
  minimumStay: 2,
  weekendPremium: 15,
  taxRate: 0,
  bufferBefore: 1,
  bufferAfter: 1,
  seasons: [
    { label: 'Summer Peak',    startMMDD: '06-15', endMMDD: '08-31', rate: 109 },
    { label: 'Holiday Season', startMMDD: '12-20', endMMDD: '01-05', rate: 129 },
  ],
  overrides: {},
  guestNotes: 'Please leave the property as you found it. Quiet hours 10pm–8am. No smoking. Respect the wildlife!',
  updatedAt: null,
};

async function fetchConfig(storeName, defaultCfg) {
  const store = getConfiguredStore(storeName);
  const raw = await store.get('config');
  if (!raw) return defaultCfg;
  return { ...defaultCfg, ...JSON.parse(raw) };
}

export const handler = async (event) => {
  connectBlobs(event);
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-cache',
  };

  const prop = event?.queryStringParameters?.property || 'bluebear';

  try {
    if (prop === 'both') {
      const [bb, hc] = await Promise.all([
        fetchConfig('bluebear-pricing', DEFAULT_CONFIG),
        fetchConfig('hikercabin-pricing', CABIN_DEFAULT_CONFIG),
      ]);
      return { statusCode: 200, headers, body: JSON.stringify({ bluebear: bb, hikercabin: hc }) };
    }

    const defaultCfg = prop === 'hikercabin' ? CABIN_DEFAULT_CONFIG : DEFAULT_CONFIG;
    const storeName  = prop === 'hikercabin' ? 'hikercabin-pricing' : 'bluebear-pricing';
    const config = await fetchConfig(storeName, defaultCfg);
    return { statusCode: 200, headers, body: JSON.stringify(config) };
  } catch (err) {
    console.error('get-pricing error:', err);
    const defaultCfg = prop === 'hikercabin' ? CABIN_DEFAULT_CONFIG : DEFAULT_CONFIG;
    return { statusCode: 200, headers, body: JSON.stringify(defaultCfg) };
  }
};
