// /api/proxy.js
// Usage: /api/proxy?url=https://example.com/some/resource
//
// Deploy: drop this file in an `api/` folder at your project root on Vercel.
// No extra config needed — Vercel auto-detects it as a serverless function.
//
// Notes on caching: Vercel functions are stateless between cold starts, so
// this in-memory cache only helps while an instance stays warm (handles a
// burst of requests). For durable caching across invocations, swap the
// `cache` Map below for Vercel KV / Upstash Redis / similar.

const CACHE_TTL_MS = 60 * 1000; // 1 minute, override with ?ttl=<ms>
const cache = new Map(); // key -> { expires, status, headers, body (base64) }

// Pool of realistic desktop browser UAs to rotate through when the caller
// doesn't supply their own.
const UA_POOL = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
];

const ACCEPT_LANG_POOL = [
  'en-US,en;q=0.9',
  'en-GB,en;q=0.9',
  'en-US,en;q=0.9,fr;q=0.8',
  'en-US,en;q=0.8,es;q=0.6',
];

function pick(pool) {
  return pool[Math.floor(Math.random() * pool.length)];
}

function cacheKey(method, targetUrl) {
  return `${method}:${targetUrl}`;
}

export default async function handler(req, res) {
  // --- CORS headers (always set, even on errors) ---
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Expose-Headers', '*');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  const { url, ttl, nocache } = req.query;

  if (!url) {
    return res.status(400).json({ error: 'Missing "url" query parameter. Usage: /api/proxy?url=https://example.com' });
  }

  let targetUrl;
  try {
    targetUrl = new URL(url);
  } catch (err) {
    return res.status(400).json({ error: 'Invalid URL provided.' });
  }

  if (!['http:', 'https:'].includes(targetUrl.protocol)) {
    return res.status(400).json({ error: 'Only http/https URLs are allowed.' });
  }

  const blockedHosts = ['localhost', '127.0.0.1', '0.0.0.0', '::1'];
  if (blockedHosts.includes(targetUrl.hostname)) {
    return res.status(400).json({ error: 'Requests to internal hosts are not allowed.' });
  }

  const effectiveTtl = ttl ? parseInt(ttl, 10) : CACHE_TTL_MS;
  const useCache = !nocache && ['GET', 'HEAD'].includes(req.method);
  const key = cacheKey(req.method, targetUrl.toString());

  // --- Serve from cache if fresh ---
  if (useCache) {
    const entry = cache.get(key);
    if (entry && entry.expires > Date.now()) {
      res.setHeader('X-Proxy-Cache', 'HIT');
      Object.entries(entry.headers).forEach(([k, v]) => res.setHeader(k, v));
      res.status(entry.status);
      return res.send(Buffer.from(entry.body, 'base64'));
    }
  }

  try {
    const forwardHeaders = { ...req.headers };
    delete forwardHeaders.host;
    delete forwardHeaders.connection;
    delete forwardHeaders['content-length'];
    delete forwardHeaders['x-forwarded-for'];
    delete forwardHeaders['x-forwarded-host'];
    delete forwardHeaders['x-forwarded-proto'];
    delete forwardHeaders['x-vercel-id'];
    delete forwardHeaders['x-vercel-deployment-url'];
    delete forwardHeaders.via;
    delete forwardHeaders.forwarded;
    delete forwardHeaders.origin;

    const targetOrigin = `${targetUrl.protocol}//${targetUrl.host}`;
    forwardHeaders['host'] = targetUrl.host;
    forwardHeaders['origin'] = targetOrigin;
    forwardHeaders['referer'] = targetOrigin + '/';

    // Prefer the header the request actually arrived with (e.g. if your
    // frontend forwards the real client's UA/Accept-Language), otherwise
    // pick a randomized realistic value so repeated calls don't all look
    // identical.
    if (!forwardHeaders['user-agent']) forwardHeaders['user-agent'] = pick(UA_POOL);
    if (!forwardHeaders['accept']) forwardHeaders['accept'] = '*/*';
    if (!forwardHeaders['accept-language']) forwardHeaders['accept-language'] = pick(ACCEPT_LANG_POOL);

    const init = { method: req.method, headers: forwardHeaders };

    if (!['GET', 'HEAD'].includes(req.method)) {
      init.body = req.body && Object.keys(req.body).length
        ? (typeof req.body === 'string' ? req.body : JSON.stringify(req.body))
        : req;
    }

    const upstreamResponse = await fetch(targetUrl.toString(), init);

    const skipHeaders = new Set([
      'content-encoding',
      'content-length',
      'transfer-encoding',
      'connection',
      'access-control-allow-origin',
      'access-control-allow-methods',
      'access-control-allow-headers',
      'x-vercel-id',
      'x-vercel-cache',
      'x-matched-path',
      'server',
      'via',
      'x-powered-by',
      'set-cookie', // don't cache/relay session cookies blindly
    ]);

    const relayHeaders = {};
    upstreamResponse.headers.forEach((value, k) => {
      if (!skipHeaders.has(k.toLowerCase())) relayHeaders[k] = value;
    });

    const buffer = Buffer.from(await upstreamResponse.arrayBuffer());

    if (useCache && upstreamResponse.ok) {
      cache.set(key, {
        expires: Date.now() + effectiveTtl,
        status: upstreamResponse.status,
        headers: relayHeaders,
        body: buffer.toString('base64'),
      });
    }

    res.setHeader('X-Proxy-Cache', 'MISS');
    Object.entries(relayHeaders).forEach(([k, v]) => res.setHeader(k, v));
    res.status(upstreamResponse.status);
    return res.send(buffer);
  } catch (err) {
    return res.status(502).json({ error: 'Failed to fetch target URL.', details: err.message });
  }
}

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '10mb',
    },
  },
};
