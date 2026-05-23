// functions/api/get-availability.js
// Cloudflare Pages Function — GET /api/get-availability?date=YYYY-MM-DD
//
// Queries Google Sheets for booked time slots on the requested date.
// Returns: { date, bookedSlots: ["9:00 AM", ...] }
//
// Environment variables (set in Cloudflare Dashboard → Pages → Settings → Environment Variables):
//   GOOGLE_SERVICE_ACCOUNT_EMAIL
//   GOOGLE_PRIVATE_KEY
//   GOOGLE_SHEET_ID

const SHEET_TAB    = 'Bookings';
const COL_DATE     = 7;   // Column H (0-based)
const COL_TIMESLOT = 8;   // Column I
const COL_STATUS   = 10;  // Column K

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

// ── Minimal Google Sheets reader using the REST API + service-account JWT ──
// Cloudflare Workers cannot use the googleapis npm package (Node.js incompatible),
// so we implement the JWT + Sheets REST call directly using the Web Crypto API.

async function getGoogleJWT(env) {
  const email      = env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const privateKey = (env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  const scope      = 'https://www.googleapis.com/auth/spreadsheets.readonly';
  const now        = Math.floor(Date.now() / 1000);

  const header  = btoa(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
  const payload = btoa(JSON.stringify({
    iss: email, scope, aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600, iat: now,
  })).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');

  const sigInput = `${header}.${payload}`;

  // Import the private key
  const pemBody   = privateKey.replace(/-----BEGIN[^-]+-----|-----END[^-]+-----|\s/g, '');
  const keyBuffer = Uint8Array.from(atob(pemBody), c => c.charCodeAt(0));
  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8', keyBuffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false, ['sign']
  );

  const sigBuffer = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5', cryptoKey,
    new TextEncoder().encode(sigInput)
  );
  const sig = btoa(String.fromCharCode(...new Uint8Array(sigBuffer)))
    .replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');

  const jwt = `${sigInput}.${sig}`;

  // Exchange JWT for access token
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });
  const tokenData = await tokenRes.json();
  return tokenData.access_token;
}

async function fetchSheetRows(env) {
  const token   = await getGoogleJWT(env);
  const sheetId = env.GOOGLE_SHEET_ID;
  const range   = encodeURIComponent(`${SHEET_TAB}!A2:K`);
  const url     = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}`;

  const res  = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json();
  return data.values || [];
}

export async function onRequestGet({ request, env }) {
  // CORS preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 200, headers: CORS });
  }

  const url  = new URL(request.url);
  const date = url.searchParams.get('date');

  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return new Response(JSON.stringify({ error: 'Invalid or missing date (expected YYYY-MM-DD)' }), { status: 400, headers: CORS });
  }

  try {
    const rows = await fetchSheetRows(env);
    const bookedSlots = rows
      .filter(row =>
        (row[COL_DATE]     || '').trim() === date &&
        (row[COL_STATUS]   || '').trim().toLowerCase() === 'booked'
      )
      .map(row => (row[COL_TIMESLOT] || '').trim())
      .filter(Boolean);

    return new Response(JSON.stringify({ date, bookedSlots }), { status: 200, headers: CORS });

  } catch (err) {
    console.error('get-availability error:', err.message);
    // Fail open — return empty so customers aren't blocked
    return new Response(JSON.stringify({ date, bookedSlots: [] }), { status: 200, headers: CORS });
  }
}
