// functions/api/create-checkout-session.js
// Cloudflare Pages Function — POST /api/create-checkout-session
//
// 1. Runs a backend double-booking guard against Google Sheets
// 2. Creates a Stripe Checkout session (one-time payment)
// 3. Returns { sessionId } to the frontend
//
// Environment variables (Cloudflare Dashboard → Pages → Settings → Environment Variables):
//   STRIPE_SECRET_KEY
//   GOOGLE_SERVICE_ACCOUNT_EMAIL
//   GOOGLE_PRIVATE_KEY
//   GOOGLE_SHEET_ID

const SHEET_TAB    = 'Bookings';
const COL_DATE     = 7;
const COL_TIMESLOT = 8;
const COL_STATUS   = 10;

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

// ── Google JWT helper (Web Crypto — works in Cloudflare Workers runtime) ──
async function getGoogleJWT(env, scopes) {
  const email      = env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const privateKey = (env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  const now        = Math.floor(Date.now() / 1000);

  const header  = btoa(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
  const payload = btoa(JSON.stringify({
    iss: email, scope: scopes, aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600, iat: now,
  })).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');

  const sigInput  = `${header}.${payload}`;
  const pemBody   = privateKey.replace(/-----BEGIN[^-]+-----|-----END[^-]+-----|\s/g, '');
  const keyBuffer = Uint8Array.from(atob(pemBody), c => c.charCodeAt(0));
  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8', keyBuffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false, ['sign']
  );
  const sigBuffer = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', cryptoKey, new TextEncoder().encode(sigInput));
  const sig = btoa(String.fromCharCode(...new Uint8Array(sigBuffer))).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');

  const jwt = `${sigInput}.${sig}`;
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });
  const tokenData = await tokenRes.json();
  return tokenData.access_token;
}

async function isSlotTaken(env, date, timeSlot) {
  try {
    const token   = await getGoogleJWT(env, 'https://www.googleapis.com/auth/spreadsheets.readonly');
    const range   = encodeURIComponent(`${SHEET_TAB}!A2:K`);
    const res     = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${env.GOOGLE_SHEET_ID}/values/${range}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data  = await res.json();
    const rows  = data.values || [];
    return rows.some(row =>
      (row[COL_DATE]     || '').trim() === date &&
      (row[COL_TIMESLOT] || '').trim() === timeSlot &&
      (row[COL_STATUS]   || '').trim().toLowerCase() === 'booked'
    );
  } catch (err) {
    console.warn('Slot check skipped (non-fatal):', err.message);
    return false; // fail open
  }
}

// ── Minimal Stripe API caller (no npm package needed) ──
async function stripePost(env, path, params) {
  const body = new URLSearchParams(params).toString();
  const res  = await fetch(`https://api.stripe.com/v1/${path}`, {
    method:  'POST',
    headers: {
      Authorization:  `Bearer ${env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });
  return res.json();
}

// ── Flatten metadata object into Stripe-compatible form params ──
function flattenMetadata(meta, prefix = 'metadata') {
  return Object.fromEntries(
    Object.entries(meta).map(([k, v]) => [`${prefix}[${k}]`, String(v)])
  );
}

export async function onRequestPost({ request, env }) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 200, headers: CORS });

  let body;
  try { body = await request.json(); }
  catch { return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400, headers: CORS }); }

  const {
    amount, serviceDesc,
    customerName, customerEmail, phone, address, notes,
    homeSummary, cleaningType, frequency,
    preferredDate, timeSlot,
    location, bedrooms, bathrooms, homeSize,
  } = body;

  if (!preferredDate || !timeSlot)
    return new Response(JSON.stringify({ error: 'Date and time slot required' }), { status: 400, headers: CORS });
  if (!amount || isNaN(amount) || Number(amount) < 1)
    return new Response(JSON.stringify({ error: 'Invalid amount' }), { status: 400, headers: CORS });

  // Backend double-booking guard
  if (await isSlotTaken(env, preferredDate, timeSlot))
    return new Response(JSON.stringify({ slotTaken: true }), { status: 200, headers: CORS });

  const siteUrl = env.SITE_URL || 'https://prestinepair.com';
  const cents   = Math.round(Number(amount) * 100);

  const itemDesc = [
    homeSummary   ? `Home: ${homeSummary}`   : null,
    preferredDate ? `Date: ${preferredDate}` : null,
    timeSlot      ? `Time: ${timeSlot}`      : null,
    address       ? `Address: ${address}`    : null,
    phone         ? `Phone: ${phone}`        : null,
    notes         ? `Notes: ${notes}`        : null,
  ].filter(Boolean).join(' | ');

  const metadata = {
    customer_name:  customerName  || '',
    customer_email: customerEmail || '',
    phone:          phone         || '',
    address:        address       || '',
    notes:          notes         || '',
    cleaning_type:  cleaningType  || '',
    frequency:      frequency     || 'One-Time',
    preferred_date: preferredDate || '',
    time_slot:      timeSlot      || '',
    location:       location      || '',
    home_summary:   homeSummary   || '',
    bedrooms:       String(bedrooms  || ''),
    bathrooms:      String(bathrooms || ''),
    home_size:      homeSize      || '',
    service_desc:   serviceDesc   || '',
  };

  try {
    const session = await stripePost(env, 'checkout/sessions', {
      'payment_method_types[]':     'card',
      'mode':                       'payment',
      'customer_email':             customerEmail || '',
      'line_items[0][quantity]':    '1',
      'line_items[0][price_data][currency]':                'usd',
      'line_items[0][price_data][unit_amount]':             String(cents),
      'line_items[0][price_data][product_data][name]':      `Pristine Pair — ${serviceDesc || 'Cleaning Service'}`,
      'line_items[0][price_data][product_data][description]': itemDesc,
      'payment_intent_data[description]': serviceDesc || 'Cleaning Service',
      'billing_address_collection':  'auto',
      'success_url':                `${siteUrl}/success?session_id={CHECKOUT_SESSION_ID}`,
      'cancel_url':                 `${siteUrl}/#booking`,
      ...flattenMetadata(metadata),
      ...flattenMetadata(metadata, 'payment_intent_data[metadata]'),
    });

    if (session.error) throw new Error(session.error.message);

    return new Response(JSON.stringify({ sessionId: session.id }), { status: 200, headers: CORS });

  } catch (err) {
    console.error('Stripe session error:', err.message);
    return new Response(JSON.stringify({ error: err.message || 'Failed to create checkout session' }), { status: 500, headers: CORS });
  }
}
