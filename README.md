# hungriAR CRM

WhatsApp CRM for restaurants and cafes. Live at **https://crm.hungriar.app**.

- **Check-in at billing:** type the guest's number, and visits, spend, loyalty rewards and unused coupons appear.
- **Review requests:** a WhatsApp rating link after each visit. Every guest can reach Google; low ratings also come to the owner privately.
- **Offer campaigns:** one-time coupon codes per guest, sent to segments (everyone, win-back, regulars, new, tag).
- **Coupons:** redeem by code or phone; a code can never be used twice.
- **QR sign-up:** guests scan, WhatsApp opens with JOIN, they're added with consent.
- **Birthday treats:** automatic coupon at 9 AM IST on the guest's birthday.
- **Reviews inbox, stats overview, CSV import/export.**
- **Multi-restaurant SaaS:** platform admin + one owner login per restaurant, fully isolated.

## Layout

```
index.html, app.js, app.css   dashboard (no build step)
r.html, r.js, r.css           public review page: /r/<token>
api/router.js                 the only Vercel function; routes every /api/* call
lib/core.js                   auth, tenant scoping, validation, WhatsApp client
lib/routes/*.js               account, customers, campaigns, counter (coupons/reviews/stats/QR), webhook
schema.sql, migrate-002.sql   database (run both, in order, on a new Supabase project)
tests/live.mjs                117 end-to-end tests against the live site
```

## Security model

- **Logins:** owners sign in with a login ID and password (scrypt-hashed); 5 wrong tries lock the account for 15 minutes. The platform admin signs in with `ADMIN_KEY` (12-hour session).
- **Sessions:** HMAC-signed tokens (`SESSION_SECRET`). Changing a password or pausing a restaurant logs out every device.
- **Tenant isolation:** owners are pinned to their own restaurant on every request; any record by ID is checked against it.
- **Webhook:** every Meta POST must carry a valid `X-Hub-Signature-256` (`WA_APP_SECRET`).
- **Browser:** strict CSP (no inline or third-party scripts), no framing, HSTS, all output escaped.
- **Database:** RLS on with no policies; only the server's service-role key can read or write. SQL functions are revoked from public roles.
- **Consent:** campaigns only reach guests with recorded consent who haven't replied STOP. Staff can unsubscribe a guest but never re-subscribe them.

## Running the tests

```bash
npm test
```
Creates throwaway restaurants on the live site, runs every flow (auth, isolation, check-in races, coupons, webhook signatures, birthdays…) and deletes them.

## Local development

```bash
npx vercel dev
```
Needs a `.env` file with the variables from `.env.example`, comments on their own lines.

## Connect a restaurant's WhatsApp (Meta Cloud API)

Without business verification you can message **250 unique customers per 24 hours** per number. The dashboard enforces this, and you press Send again the next day. Apply for verification in parallel.

1. **SIM:** a number that is *not* on the WhatsApp app.
2. **business.facebook.com:** create a Business portfolio for the restaurant.
3. **developers.facebook.com:** Create App → *Business* → add **WhatsApp**.
4. WhatsApp → API Setup → **Add phone number** → verify by OTP. Copy the **Phone number ID** into Settings.
5. **Permanent token:** Business Settings → System users → Add (Admin) → assign the app + WhatsApp account → Generate token with `whatsapp_business_messaging` and `whatsapp_business_management`, expiry *Never*. Paste into Settings.
6. **Payment method:** WhatsApp Manager → Payment settings.
7. **Webhook:** App → WhatsApp → Configuration → Callback URL `https://crm.hungriar.app/api/webhook`, Verify token = `WA_VERIFY_TOKEN`. Subscribe to **messages**. Put the App secret in the `WA_APP_SECRET` env var on Vercel.
8. **Templates:** WhatsApp Manager → Message templates (approval: minutes to hours).

### Templates

**Offer** (*Marketing*, `next_visit_offer`). Campaign variables: `{name}` `{business}` `{percent}` `{code}` `{expiry}`
```
Hi {{1}}, thanks for being a regular at {{2}}! 🎉
Here's {{3}}% off your next visit. Show this code at the counter: *{{4}}*
Valid till {{5}}. Reply STOP to stop offers.
```

**Review** (*Utility*, `visit_review`). Settings variables: `{name}` `{business}` `{link}`
```
Hi {{1}}, thanks for visiting {{2}} today. How did we do? It takes 10 seconds: {{3}}
```

**Birthday** (*Marketing*, `birthday_offer`). Settings variables: `{name}` `{business}` `{percent}` `{code}` `{expiry}`
```
Happy birthday {{1}}! 🎂 {{2}} has a treat for you: {{3}}% off with code *{{4}}*, valid till {{5}}.
```

## Rules that keep the number from being banned

- Only message guests who agreed. Check-in and import both record consent; QR sign-ups are consent by design.
- Every marketing template ends with "Reply STOP…". STOP/START are handled automatically.
- Start slow with a new number; blocks and reports lower its quality rating.
- Never use unofficial WhatsApp Web tools for bulk sends.
