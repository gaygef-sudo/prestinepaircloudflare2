# Pristine Pair Cleaning — Cloudflare Pages Deployment Guide

## Project type: Cloudflare Pages (NOT Workers)

This is a static site with Cloudflare Pages Functions.
There is intentionally NO wrangler.toml — its presence causes the
"Workers-specific command" error when GitHub deploys through Pages CI.

---

## Repo structure

```
/
├── functions/
│   └── api/
│       ├── get-availability.js        → GET  /api/get-availability
│       ├── create-checkout-session.js → POST /api/create-checkout-session
│       └── stripe-webhook.js          → POST /api/stripe-webhook
├── public/                            ← build output directory
│   ├── index.html
│   ├── success.html
│   ├── cancel.html
│   ├── _redirects                     ← must be inside public/
│   ├── _headers                       ← must be inside public/
│   ├── _routes.json                   ← routes /api/* to Functions
│   └── (images...)
├── package.json
├── .env.example
└── DEPLOY.md
```

---

## Cloudflare Dashboard — Build Settings
Pages → your project → Settings → Builds & deployments

| Setting                | Value              |
|------------------------|--------------------|
| Build command          | *(leave completely blank)* |
| Build output directory | `public`           |
| Root directory         | *(leave completely blank)* |
| Node.js version        | 18                 |

> Do NOT set a build command. This is a pre-built static site.
> Cloudflare Pages auto-detects the `functions/` folder at repo root.

---

## Environment Variables
Pages → your project → Settings → Environment Variables → Production

| Variable                       | Value                                        |
|--------------------------------|----------------------------------------------|
| `STRIPE_SECRET_KEY`            | `sk_live_...`                               |
| `STRIPE_WEBHOOK_SECRET`        | `whsec_...` from Stripe webhook signing secret |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | `your-sa@project.iam.gserviceaccount.com`   |
| `GOOGLE_PRIVATE_KEY`           | Full PEM key — paste with real newlines      |
| `GOOGLE_SHEET_ID`              | ID from your Google Sheet URL                |
| `GOOGLE_CALENDAR_ID`           | `gaygef@gmail.com`                          |
| `SITE_URL`                     | `https://prestinepair.com`                  |

### GOOGLE_PRIVATE_KEY — important note
In the Cloudflare env var field, paste the key exactly as it appears in the
JSON file downloaded from Google, including literal newline characters.
Do NOT use \n escape sequences — Cloudflare stores it correctly as-is.

---

## Stripe Webhook
Stripe Dashboard → Developers → Webhooks → Add endpoint

- URL: `https://prestinepair.com/api/stripe-webhook`
- Events to enable: `checkout.session.completed`, `invoice.payment_failed`
- Copy the **Signing secret** → add as `STRIPE_WEBHOOK_SECRET` in Cloudflare

---

## Google Setup (one-time)
1. console.cloud.google.com → create project
2. Enable: Google Sheets API + Google Calendar API
3. IAM → Service Accounts → Create → generate JSON key
4. Share your Google Sheet with the service account email (Editor)
5. Share your Google Calendar with the service account email (Make changes to events)

---

## Local Development
```bash
npm install
npx wrangler pages dev public
# → http://localhost:8788
# → /api/* routes served from functions/api/
```
