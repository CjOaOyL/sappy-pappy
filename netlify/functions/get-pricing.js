/**
 * get-pricing.js
 * Returns the current pricing configuration from Netlify Blobs.
 * Falls back to sensible defaults if no config has been saved yet.
 *
 * GET /.netlify/functions/get-pricing
 * Returns: PricingConfig object (see DEFAULT_CONFIG)
 */

import { getStore } from '@netlify/blobs';

export const DEFAULT_CONFIG = {
  baseRate: 150,          // $ per night (baseline)
  cleaningFee: 85,        // $ flat fee per stay
  minimumStay: 2,         // nights
  weekendPremium: 25,     // $ extra per night Fri/Sat
  taxRate: 0,             // % — set if collecting taxes directly

  // Seasonal rate windows — override baseRate for date ranges
  // Format: [{ label, startMMDD, endMMDD, rate }]
  seasons: [
    { label: 'Summer Peak',    startMMDD: '06-15', endMMDD: '08-31', rate: 175 },
    { label: 'Holiday Season', startMMDD: '12-20', endMMDD: '01-05', rate: 200 },
  ],

  // Per-date overrides — exact dates take highest priority
  // Format: { "YYYY-MM-DD": rateOrNull }  (null = blocked/unavailable)
  overrides: {},

  // Notes shown to guest at booking (e.g. "No parties")
  guestNotes: 'Please leave the property as you found it. Quiet hours 10pm–8am. No smoking indoors.',

  // Updated timestamp
  updatedAt: null,
};

export const handler = async () => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-cache',
  };

  try {
    const store = getStore('bluebear-pricing');
    const raw = await store.get('config');

    if (!raw) {
      return { statusCode: 200, headers, body: JSON.stringify(DEFAULT_CONFIG) };
    }

    const config = JSON.parse(raw);
    // Merge with defaults so new fields are always present
    const merged = { ...DEFAULT_CONFIG, ...config };
    return { statusCode: 200, headers, body: JSON.stringify(merged) };
  } catch (err) {
    console.error('get-pricing error:', err);
    // Always return something usable
    return { statusCode: 200, headers, body: JSON.stringify(DEFAULT_CONFIG) };
  }
};
