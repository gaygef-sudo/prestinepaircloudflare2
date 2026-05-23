// functions/api/stripe-webhook.js
// Cloudflare Pages Function — POST /api/stripe-webhook
//
// On checkout.session.completed:
//   1. Verifies Stripe webhook signature
//   2. Appends booking row to Google Sheets
//   3. Creates Google Calendar event
//
// Register in Stripe Dashboard → Developers → Webhooks:
//   URL: https://prestinepair.com/api/stripe-webhook
//   Events: checkout.session.completed, invoice.payment_failed
//
// Environment variables:
//   STRIPE_SECRET_KEY
//   STRIPE_WEBHOOK_SECRET
//   GOOGLE_SERVICE_ACCOUNT_EMAIL
//   GOOGLE_PRIVATE_KEY
//   GOOGLE_SHEET_ID
//   GOOGLE_CALENDAR_ID   (e.g. gaygef@gmail.com)

const SHEET_TAB  = 'Bookings';
const SLOT_HOURS = { '9:00 AM': 9, '12:00 PM': 12, '3:00 PM': 15 };
const CLEAN_DUR  = { 'Standard Cleaning': 2, 'Deep Cleaning': 3, 'Move-In / Move-Out Cleaning': 3.5 };

// ── Stripe signature verification using Web Crypto ──
async function verifyStripeSignature(body, sigHeader, secret) {
  const parts    = Object.fromEntries(sigHeader.split(',').map(p => p.split('=')));
  const timestamp = parts.t;
  const sig       = parts.v1;
  if (!timestamp || !sig) return false;

  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const expected = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}.${body}`));
  const expectedHex = Array.from(new Uint8Array(expected)).map(b => b.toString(16).padStart(2,'0')).join('');
  return expectedHex === sig;
}

// ── Google JWT (read+write scopes for Sheets + Calendar) ──
async function getGoogleJWT(env) {
  const email      = env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const privateKey = (env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  const scope      = 'https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/calendar';
  const now        = Math.floor(Date.now() / 1000);

  const b64url = s => btoa(s).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
  const header  = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({ iss: email, scope, aud: 'https://oauth2.googleapis.com/token', exp: now+3600, iat: now }));
  const sigInput  = `${header}.${payload}`;
  const pemBody   = privateKey.replace(/-----BEGIN[^-]+-----|-----END[^-]+-----|\s/g, '');
  const keyBuffer = Uint8Array.from(atob(pemBody), c => c.charCodeAt(0));
  const cryptoKey = await crypto.subtle.importKey('pkcs8', keyBuffer, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sigBuffer = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', cryptoKey, new TextEncoder().encode(sigInput));
  const sig = btoa(String.fromCharCode(...new Uint8Array(sigBuffer))).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');

  const jwt      = `${sigInput}.${sig}`;
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });
  const td = await tokenRes.json();
  return td.access_token;
}

// ── Append row to Google Sheets ──
async function appendBookingRow(env, token, meta, sessionId) {
  const now = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
  const row = [
    now,
    meta.customer_name   || '',
    meta.customer_email  || '',
    meta.phone           || '',
    meta.address         || '',
    meta.cleaning_type   || '',
    meta.frequency       || 'One-Time',
    meta.preferred_date  || '',
    meta.time_slot       || '',
    sessionId            || '',
    'Booked',
  ];

  const url = `https://sheets.googleapis.com/v4/spreadsheets/${env.GOOGLE_SHEET_ID}/values/${SHEET_TAB}!A:K:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;
  const res = await fetch(url, {
    method:  'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify({ values: [row] }),
  });
  const data = await res.json();
  console.log('Sheets append:', data.updates?.updatedRange || 'done');
}

// ── Create Google Calendar event ──
async function createCalendarEvent(env, token, meta) {
  const calId = env.GOOGLE_CALENDAR_ID || 'gaygef@gmail.com';
  const date  = meta.preferred_date;
  const slot  = meta.time_slot;
  const startH = SLOT_HOURS[slot];

  if (!date || startH === undefined) {
    console.warn('Skipping calendar event — missing date or slot:', date, slot);
    return;
  }

  const dur  = CLEAN_DUR[meta.cleaning_type] || 2.5;
  const pad  = n => String(n).padStart(2, '0');
  const endH = Math.floor(startH + dur);
  const endM = Math.round((dur % 1) * 60);

  const description = [
    `📞 Phone: ${meta.phone || 'N/A'}`,
    `📧 Email: ${meta.customer_email || 'N/A'}`,
    `🏠 Home: ${meta.home_summary || meta.address || 'N/A'}`,
    `🧹 Service: ${meta.cleaning_type || 'N/A'}`,
    meta.notes ? `💬 Notes: ${meta.notes}` : null,
    '',
    `💳 Stripe Session: ${meta.session_id || 'N/A'}`,
    `📌 Booked via PrestinePair.com`,
  ].filter(s => s !== null).join('\n');

  const event = {
    summary:     `${meta.cleaning_type || 'Cleaning'} – ${meta.customer_name || 'Customer'}`,
    location:    meta.address || '',
    description,
    start: { dateTime: `${date}T${pad(startH)}:00:00`, timeZone: 'America/New_York' },
    end:   { dateTime: `${date}T${pad(endH)}:${pad(endM)}:00`, timeZone: 'America/New_York' },
    reminders: { useDefault: false, overrides: [{ method: 'email', minutes: 1440 }, { method: 'popup', minutes: 60 }] },
    colorId: '2',
  };

  const res  = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calId)}/events`, {
    method:  'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify(event),
  });
  const data = await res.json();
  console.log('Calendar event created:', data.htmlLink || data.error?.message || 'unknown');
}

// ── Main handler ──
export async function onRequestPost({ request, env }) {
  const rawBody   = await request.text();
  const sigHeader = request.headers.get('stripe-signature') || '';
  const secret    = env.STRIPE_WEBHOOK_SECRET;

  // Verify signature if secret is set
  if (secret) {
    const valid = await verifyStripeSignature(rawBody, sigHeader, secret);
    if (!valid) {
      console.error('Invalid Stripe webhook signature');
      return new Response('Webhook signature invalid', { status: 400 });
    }
  }

  let stripeEvent;
  try { stripeEvent = JSON.parse(rawBody); }
  catch { return new Response('Invalid JSON', { status: 400 }); }

  if (stripeEvent.type === 'checkout.session.completed') {
    const session = stripeEvent.data.object;
    const meta    = { ...(session.metadata || {}), session_id: session.id };

    console.log('✅ Payment confirmed:', {
      id:       session.id,
      customer: meta.customer_name,
      date:     meta.preferred_date,
      time:     meta.time_slot,
      service:  meta.cleaning_type,
    });

    try {
      const token = await getGoogleJWT(env);
      const [sheetsRes, calRes] = await Promise.allSettled([
        appendBookingRow(env, token, meta, session.id),
        createCalendarEvent(env, token, meta),
      ]);
      if (sheetsRes.status === 'rejected') console.error('❌ Sheets:', sheetsRes.reason?.message);
      if (calRes.status   === 'rejected') console.error('❌ Calendar:', calRes.reason?.message);
    } catch (err) {
      console.error('Post-payment processing error:', err.message);
    }
  } else if (stripeEvent.type === 'invoice.payment_failed') {
    console.warn('❌ Payment failed:', stripeEvent.data.object?.customer_email);
  } else {
    console.log('Unhandled webhook event:', stripeEvent.type);
  }

  return new Response(JSON.stringify({ received: true }), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  });
}
