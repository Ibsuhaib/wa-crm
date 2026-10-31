# WhatsApp CRM (MVP)

Customer list, bulk WhatsApp offers with one-time coupon codes, review requests after each visit,
and STOP opt-out. Runs free on **Vercel** (hosting + API) and **Supabase** (database).
The only running cost is Meta's per-message fee, billed to each shop's own Meta account.

```
index.html        dashboard: Check-in, Customers, Campaigns, Redeem, Settings
r.html            public review page customers open from WhatsApp (yourapp.vercel.app/r/<token>)
api/              Vercel serverless functions (Node)
  visits.js       check a customer in, send review request
  campaigns.js    create campaign, queue messages + coupons
  send-batch.js   send next 20 messages (dashboard loops it; respects 250/day limit)
  webhook.js      Meta delivery receipts + STOP/START replies
  coupons.js      check / redeem a code (can only be redeemed once)
  review.js       public: save star rating + feedback
schema.sql        run once in Supabase
```

## 1. Supabase (10 min)

1. Create a free project at supabase.com (region: Mumbai).
2. SQL Editor → paste all of `schema.sql` → Run.
3. Project Settings → API: copy the **Project URL** and the **service_role** key.

## 2. Deploy to Vercel (5 min)

1. Push this folder to GitHub, then Vercel → Add New Project → import it. No build settings needed.
2. Settings → Environment Variables: add everything in `.env.example`.
   `ADMIN_KEY` and `WA_VERIFY_TOKEN` are any long random strings you make up.
3. Redeploy, open the site, enter your admin key, and create the first business in Settings.

## 3. Meta WhatsApp Cloud API, per shop (same day, no verification needed)

Without business verification you can message **250 unique customers per 24 hours** per number.
The dashboard enforces this and lets you press Send again the next day. Apply for verification in parallel.

1. **SIM**: get a fresh number for the shop that is *not* on the WhatsApp app (or delete WhatsApp from it first).
2. **business.facebook.com** → create a Business portfolio for the shop.
3. **developers.facebook.com** → My Apps → Create App → type *Business* → add the **WhatsApp** product.
4. WhatsApp → API Setup → **Add phone number** → enter display name, verify the SIM by OTP.
   Copy the **Phone number ID** into the dashboard's Settings.
5. **Permanent token** (the one on the API Setup page expires in 24 h):
   Business Settings → Users → System users → Add (Admin) → Assign assets → your app + WhatsApp account (full control)
   → Generate token with `whatsapp_business_messaging` and `whatsapp_business_management`, expiry *Never*.
   Paste it into Settings → WhatsApp access token.
6. **Payment method**: WhatsApp Manager → Payment settings → add the shop's card. Marketing templates won't send without it.
7. **Webhook**: App → WhatsApp → Configuration → Callback URL `https://<your-app>.vercel.app/api/webhook`,
   Verify token = your `WA_VERIFY_TOKEN` → Verify and save → subscribe to the **messages** field.
   Put the App secret (App settings → Basic) in `WA_APP_SECRET`.
8. **Templates**: WhatsApp Manager → Message templates → Create. Approval is usually minutes to hours.

### Templates to submit

**Offer** — category *Marketing*, name `next_visit_offer`:
```
Hi {{1}}, thanks for being a regular at {{2}}! 🎉
Here's {{3}}% off your next visit. Show this code at the counter: *{{4}}*
Valid till {{5}}.
Reply STOP to stop offers.
```
Dashboard variables (default): `{name}` `{business}` `{percent}` `{code}` `{expiry}`

**Review** — category *Utility* (cheaper; Meta may reclassify it as Marketing), name `visit_review`:
```
Hi {{1}}, thanks for visiting {{2}} today. How did we do? It takes 10 seconds: {{3}}
```
Settings variables (default): `{name}` `{business}` `{link}`

Meta wants an example value for each `{{n}}` when you submit; use realistic ones (`Rahul`, `Cafe Mocha`, `5`, `K7XM2P`, `30 Nov`).

## Rules that keep the number from being banned

- Only message customers who agreed (ask at the counter, or a sign on the QR stand).
- Every marketing template ends with "Reply STOP…". STOP replies are handled automatically.
- Start slow with a new number. Many blocks/reports drop the number's quality rating and Meta then limits it.
- Don't use unofficial WhatsApp Web tools for bulk sends.
- The review page shows the Google link to every customer, happy or not. Google's policy forbids
  sending only happy customers to Google ("review gating"), and can remove the shop's reviews for it.

## Run locally

```bash
npm install
npx vercel dev
```
Put the variables in `.env.local`. Meta can't reach localhost for webhooks, so test those on the deployed URL.

## Known MVP limits

- One admin key for the whole app, so it's for you (the agency) managing shops, not shop staff logins yet.
  Next step: Supabase Auth + a `business_users` table.
- Shop WhatsApp tokens are stored in the database as plain text. Keep the service_role key secret.
- No scheduled automations yet (birthday, "we miss you"). Vercel's free cron runs once a day, which is enough for those.
