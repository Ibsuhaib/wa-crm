// Single Vercel function for the whole API (the free plan allows only 12 functions).
// vercel.json rewrites /api/<path> here as ?path=<path>.
import { authenticate, fail, HttpError } from '../lib/core.js';
import { login, me, businesses, password } from '../lib/routes/account.js';
import { customers, customerDetail, visits } from '../lib/routes/customers.js';
import { campaigns, preview, sendBatch, cronBirthdays } from '../lib/routes/campaigns.js';
import { coupons, reviews, review, stats, qr } from '../lib/routes/counter.js';
import { webhook } from '../lib/routes/webhook.js';

const PUBLIC = {
  'login': login,
  'review': review,
  'webhook': webhook,
  'cron/birthdays': cronBirthdays,  // checks CRON_SECRET itself
};
const PRIVATE = {
  'me': me,
  'businesses': businesses,
  'businesses/password': password,
  'customers': customers,
  'customers/detail': customerDetail,
  'visits': visits,
  'campaigns': campaigns,
  'campaigns/preview': preview,
  'send-batch': sendBatch,
  'coupons': coupons,
  'reviews': reviews,
  'stats': stats,
  'qr': qr,
};

function routeOf(req) {
  let p = req.query.path;
  if (Array.isArray(p)) p = p.join('/');
  if (!p) p = new URL(req.url, 'http://x').pathname.replace(/^\/api\/?/, '');
  return String(p).replace(/^\/+|\/+$/g, '');
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const route = routeOf(req);
    // Parse the JSON body up front (Vercel parses lazily and throws its own error type on bad JSON).
    // The webhook is skipped: it reads the raw bytes to check Meta's signature.
    if (route !== 'webhook' && !['GET', 'HEAD'].includes(req.method)) {
      let body;
      try { body = req.body; } catch { throw new HttpError(400, 'Invalid request body'); }
      // `vercel dev` can hand over the raw string/Buffer instead of parsed JSON.
      if (typeof body === 'string' || Buffer.isBuffer(body)) {
        try { body = body.length ? JSON.parse(body.toString('utf8')) : {}; } catch { throw new HttpError(400, 'Invalid request body'); }
        Object.defineProperty(req, 'body', { value: body, writable: true, configurable: true });
      }
    }
    if (PUBLIC[route]) return await PUBLIC[route](req, res);
    if (!PRIVATE[route]) throw new HttpError(404, 'Not found');
    const ctx = await authenticate(req);
    await PRIVATE[route](req, res, ctx);
  } catch (e) {
    fail(res, e);
  }
}
