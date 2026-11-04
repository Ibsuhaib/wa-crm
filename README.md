# hungriAR CRM

WhatsApp CRM for restaurants and cafes. Live at **https://crm.hungriar.app**.

- **Check-in at billing:** type the guest's number or name; returning guests are found as you type. Add an optional birthday, and visits, spend and loyalty rewards add up.
- **Review requests:** a WhatsApp rating link after each visit. Every guest can reach Google; low ratings also come to the owner privately.
- **Customers:** search, VIP / Common filter, last-visit date and time filter, tick customers or select all, and send them an approved message.
- **No repeats:** the same message goes to the same guest at most once every 30 days (changeable per restaurant).
- **QR sign-up:** guests scan, WhatsApp opens with JOIN, they're added with consent.
- **Cheap messages by default:** visit messages are Utility (about 14 paise). The admin writes templates in the CRM; restaurants can only read and send them. A visit message Meta labels Marketing is blocked.
- **Birthdays:** optional per restaurant, given by the admin. The owner picks a named birthday template and switches automatic wishes on or off. Sent at 9 AM IST, once a year per guest, as Marketing (about ₹1).
- **Reviews inbox, stats overview, CSV import/export.**
- **Multi-restaurant SaaS:** platform admin + one owner login per restaurant, fully isolated.

## Layout

```
index.html, app.js, app.css   dashboard (no build step)
r.html, r.js, r.css           public review page: /r/<token>
api/router.js                 the only Vercel function; routes every /api/* call
lib/core.js                   auth, tenant scoping, validation, WhatsApp client
lib/routes/*.js               account, customers, templates, messages (send + daily template check), counter (reviews/stats/QR), webhook
schema.sql, migrate-00*.sql   database (run them in order on a new Supabase project)
tests/live.mjs                117 end-to-end tests against the live site
```

## Security model

- **Logins:** owners sign in with a login ID and password (scrypt-hashed); 5 wrong tries lock the account for 15 minutes. The platform admin signs in with `ADMIN_KEY` (12-hour session).
- **Sessions:** HMAC-signed tokens (`SESSION_SECRET`). Changing a password or pausing a restaurant logs out every device.
- **Tenant isolation:** owners are pinned to their own restaurant on every request; any record by ID is checked against it.
- **Webhook:** every Meta POST must carry a valid `X-Hub-Signature-256` (`WA_APP_SECRET`).
- **Browser:** strict CSP (no inline or third-party scripts), no framing, HSTS, all output escaped.
- **Database:** RLS on with no policies; only the server's service-role key can read or write. SQL functions are revoked from public roles.
- **Consent:** messages only reach guests with recorded consent who haven't replied STOP. Staff can unsubscribe a guest but never re-subscribe them.

## Running the tests

```bash
npm test
```
Creates throwaway restaurants on the live site, runs every flow (auth, isolation, check-in races, repeat blocking, templates, webhook signatures…) and deletes them.

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

The platform admin creates them on the **Templates** screen, typing `{name}`, `{business}` and `{link}` (the guest's review page). The CRM submits them to Meta as *Utility* and shows the live status and category. Add the restaurant's WhatsApp account ID in Settings first, then pick the check-in message there.

```
Hi {name}, thanks for visiting {business} today. How did we do? It takes 10 seconds: {link} Thank you!
```

Meta decides the final category. Keep messages about the guest's visit, with no offers: a template labelled Marketing (about ₹1) can't be sent. Birthday templates (Type: Birthday) are submitted as Marketing instead, and can only be used for birthday wishes. Templates are re-checked with Meta every morning, whenever the Templates screen opens, and before every bulk send.

## Rules that keep the number from being banned

- Only message guests who agreed. Check-in and import both record consent; QR sign-ups are consent by design.
- STOP/START replies are handled automatically.
- Start slow with a new number; blocks and reports lower its quality rating.
- Never use unofficial WhatsApp Web tools for bulk sends.
