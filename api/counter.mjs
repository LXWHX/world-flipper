// /api/counter — the site's same-origin relay for its three Supabase RPCs. supabase.co is blocked
// at the network level in mainland China, so the deployed site never calls it from the browser:
// supabaseRpc() (wf-chrome.js) POSTs here with { rpc, args } and this function forwards to
// Supabase's REST endpoint server-side — the browser only ever fetches the site's own domain.
// Deployed by Vercel's zero config (any file under api/ becomes a function at /api/<name>); the
// .mjs extension pins ESM regardless of package.json, and there are no imports, so nothing from
// node_modules gets bundled. See the Supabase section of ARCHITECTURE.md.
//
// The key below is the same anon key wf-core.js already ships to every browser — relaying it adds
// no privilege: the Supabase roles still grant EXECUTE on only these SECURITY DEFINER functions,
// and the allowlist is what keeps this endpoint from being a generic proxy. Set the
// SUPABASE_URL / SUPABASE_ANON_KEY env vars in Vercel to override (e.g. after rotating keys).

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://lgxnpzdzhnfvxmrzgevg.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY
  || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxneG5wemR6aG5mdnhtcnpnZXZnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQxODczNjUsImV4cCI6MjA5OTc2MzM2NX0.FvC9ttc5rri71_URT-hRk4xG6gG-bTDyJK5g4-HP9k4';

// Exactly the RPCs supabaseRpc() names — anything else is refused rather than forwarded.
const ALLOWED_RPC = new Set(['record_visit', 'art_stats_all', 'vote_art']);

// Reads the body off the stream instead of leaning on Vercel's automatic JSON parsing, so the
// function behaves the same whatever the runtime does with req.body.
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function send(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(payload);
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return send(res, 405, JSON.stringify({ error: 'POST only' }));

  let rpc = '', args = {};
  try {
    const body = JSON.parse(await readBody(req));
    rpc = String(body.rpc || '');
    if (body.args && typeof body.args === 'object' && !Array.isArray(body.args)) args = body.args;
  } catch (e) {
    return send(res, 400, JSON.stringify({ error: 'invalid JSON body' }));
  }
  if (!ALLOWED_RPC.has(rpc)) return send(res, 404, JSON.stringify({ error: 'unknown rpc' }));

  try {
    const r = await fetch(SUPABASE_URL + '/rest/v1/rpc/' + rpc, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': 'Bearer ' + SUPABASE_ANON_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(args)
    });
    // Supabase's body passes through verbatim. An empty body becomes JSON null rather than '' —
    // all three RPCs return rows, but a text() of '' would make the browser's r.json() throw.
    // A Supabase failure surfaces as 502 so the browser falls back to calling Supabase directly
    // (supabaseRpc's one-shot retry), keeping the counters alive if this function is ever broken.
    const text = await r.text();
    return send(res, r.ok ? 200 : 502, text || 'null');
  } catch (e) {
    return send(res, 502, 'null');
  }
}
