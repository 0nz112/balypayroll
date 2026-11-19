# نظام المبيعات والرواتب — Sales & Weekly Payroll (IQD)

Arabic-first (RTL) sales management and accounting app for a company that manages **sales managers** and their **promoters**. It runs on **GitHub + Railway only**: one Node service (API + login + the app) and one Railway PostgreSQL database.

All money is stored as integer IQD (`bigint`), and all business dates use Asia/Baghdad.

---

## Deploy on Railway (step by step)

### 1. Put the code on GitHub
1. Create a new repository on github.com. A private one is fine.
2. Upload the contents of this folder (not the folder itself) with **Add file → Upload files**, or push it with git.

### 2. Create the Railway project
1. On railway.com choose **New Project → Deploy from GitHub repo** and pick your repository. Railway detects Node, runs `npm install` and `npm run build`, then starts with `npm start` (see `railway.json`).
2. In the same project click **+ Create → Database → PostgreSQL**.

### 3. Set the variables
Open your **app service → Variables** and add:

| Variable | Value |
|---|---|
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` (Railway fills it in) |
| `SESSION_SECRET` | a long random text, at least 32 characters |
| `ADMIN_EMAIL` | your email (first Super Admin) |
| `ADMIN_PASSWORD` | a strong password (8+ characters) |
| `ADMIN_NAME` | your name (optional) |
| `SEED_DEMO` | `true` only if you want demo data to try things; otherwise leave it out |

Railway redeploys automatically after you save.

### 4. Get the link
Open **app service → Settings → Networking → Generate Domain**. You get a link like `https://your-app.up.railway.app`.

- On first start the server creates every table, rule and security policy, and your Super Admin account. Check **Deploy Logs** for `✓ Super Admin ready`.
- Sign in with `ADMIN_EMAIL` / `ADMIN_PASSWORD`, then **delete the `ADMIN_PASSWORD` variable** (it's only used once).
- Add your sales managers from **مدراء المبيعات**.
- On a phone, open the link and use **Add to Home Screen** to install it as an app.

### 5. Updates and backups
- Every push to the GitHub repo redeploys automatically. New database migrations in `db/migrations/` are applied on start, once each.
- Backups: Railway's PostgreSQL service has a **Backups** tab where you can schedule daily backups. Attachments are stored inside the database, so they are included. Financial rows can't be deleted, so a restore only ever rolls forward.

If `SEED_DEMO=true`, the demo logins are `admin@demo.iq`, `karrar@demo.iq`, `noor@demo.iq` and `haider@demo.iq`, all with password `Demo@12345`. Don't use demo data in production.

---

## How it's built

```
server/        Node HTTP server (only dependency: pg)
  index.js     routes, static files, security headers, CSRF check
  auth.js      email/password login (bcrypt via pgcrypto), signed HttpOnly session cookie,
               lockout after 5 failed attempts, password change/reset
  api.js       RPC allowlist + named read queries
  db.js        every request runs as role "authenticated" with the user's id → RLS applies
  migrate.js   applies db/migrations once each, optional seed, first-admin bootstrap
db/
  migrations/  platform (accounts), schema, business logic, RLS, attachments
  seed.sql     demo data
  tests/       SQL test runner (parity + workflow/security)
src/           React app (Arabic/English, themes, PWA)
tests/         Node unit tests; pg-shim.js is a test-only driver
```

Security model: clients never write to tables directly. Every change calls a database function that validates the input and checks permission. Reads go through Row Level Security, so a manager can only ever see their own team, and the database enforces this even if the server had a bug. Sessions are HMAC-signed HttpOnly cookies, invalidated when a password changes. API calls require a custom header (CSRF protection), and responses carry a strict Content-Security-Policy.

## Roles

| Capability | Super Admin | Sales Manager |
|---|---|---|
| See data | Everything | Only their own team (RLS) |
| Promoters, registrations, ledger, expenses, payroll | All | Own team |
| Move promoters between managers | ✓ | — |
| Incentive rules per date | ✓ | Read-only |
| Create / suspend / delete managers, reset passwords | ✓ | — |
| Settings, expense categories, audit log | ✓ | — |
| Personal UI customization, language, own password | ✓ | ✓ |

## Business rules

**Car pricing (weekly).** Every day the manager enters, for each promoter, the number of **cars registered** and how many of them are **active** (completed 3 trips). Updating the active count is normal daily work and needs no reason. Changing a day's car count needs a reason, and is kept in the edit history.

For each payroll week (Saturday → Friday, paid the following Tuesday):

| Situation | Price per car |
|---|---|
| Registered only | 3,000 IQD |
| Registered + active (3 trips) | 6,000 IQD |
| **More than 5 cars in the week and ≥ 60% of them active** | **15,000 IQD for every car that week** |

All five values (both prices, the bonus price, the car threshold and the activity %) are editable in **الإعدادات → تسعير السيارات**. Each price plan applies from a chosen week. Earlier weeks keep the prices they were calculated with, and changing a week whose payroll is already approved or paid requires a reason.

**Weeks never mix.** Each week is calculated only from its own seven days: its cars, its active cars, its incentives and its deductions. A car counts in the week it was registered.

**Daily incentives.** For any calendar date, the Super Admin can add an amount per car registered that day, applied to all cars or to active cars only, optionally from a minimum number of cars and only for selected managers. It is added on top of the weekly car price.

**Manager daily bonus (tiers).** At the top of the **daily registrations** screen, a sales manager turns on the bonus for that day and types the amount for each tier by hand:

| Cars that day | Bonus |
|---|---|
| 2 | amount entered by hand |
| 3 | amount entered by hand |
| 4 | amount entered by hand |
| 5 | amount entered by hand |
| 6th car onwards (optional) | an extra amount entered by hand, **for each car** from the 6th |

The promoter gets **only the highest tier reached**. For example, 5 cars pay the 5-car amount, not the 2+3+4+5 amounts added together. 8 cars pay the 5-car amount plus 3 × the extra amount. You can count all cars or active cars only. No amounts are predefined. The Super Admin can set the bonus for one manager or for all of them. The bonus belongs to that day's payroll week only.

**Weekly payroll.** Status goes pending → approved → paid, or adjusted after a correction. Approval locks the week and links its deductions to that payroll, so nothing is deducted twice. A negative net is carried forward as debt. Payments can be partial, overpayment is rejected, and repeated submissions are ignored. A paid payroll is never overwritten; corrections are recorded as adjustments.

**Debts (الديون page).** Add old debts, new debts and repayments, filter by promoter, manager, date, type and status, and export to CSV or Excel. Deleting a debt entry voids it with a reason, so history stays auditable; an entry already used in an approved payroll can't be deleted. Repayments are deducted from that week's salary.

**Ledger, expenses, audit.** The ledger is append-only. Company expenses are kept separate from charges to promoters, and categories include حَرْقيات. Every change is logged with the user, the old and new values, and the reason.

## Reports & WhatsApp

- **Promoter sales report (كشف مبيعات المروج):** on any promoter page, choose a week, month or custom range to get a professional multi-page PDF. It has the promoter's details, KPIs, a table of every day (cars, active, registered only, activity %, incentives/bonus), and a table of every payroll week (rate, earnings, deductions, net, paid, status).
- **Send on WhatsApp:** opens the promoter's own WhatsApp chat directly, using the WhatsApp number saved on the promoter or their phone otherwise. The full summary is already typed in, and the PDF downloads at the same time so you can attach it. You confirm and press Send yourself; WhatsApp doesn't allow a website to send automatically. **Share PDF** uses the phone's share sheet instead.
- **Full inventory (الجرد الشامل)** in Reports: every promoter for one day, several days, a week or a month, broken down by promoter, by day and line by line. It exports to a paginated PDF and a 3-sheet Excel file, and each row has a WhatsApp button for that promoter.

## Install on Android and iPhone

The site is a Progressive Web App:
- **Android (Chrome):** tap **تثبيت التطبيق** in the app, or Chrome's menu ⋮ → *Install app*.
- **iPhone (Safari):** tap Share → *Add to Home Screen*. The app shows these steps itself.

It then opens from the home screen like an app (full screen, its own icon, shortcuts to registrations, payroll and debts). Installing needs the real HTTPS site (your Railway link), not a local file.

## Run locally (optional)

```bash
npm install
DATABASE_URL=postgres://postgres:pass@localhost:5432/sales SESSION_SECRET=dev-secret-dev-secret-dev-secret-00 \
  ADMIN_EMAIL=me@x.iq ADMIN_PASSWORD=Passw0rd! npm run build && npm start   # http://localhost:3000
npm test                                                                    # engine + demo tests
DATABASE_ADMIN_URL=postgres://postgres:pass@localhost:5432/postgres npm run test:db
```

Open the app with `?demo` added to the address to try it entirely in the browser (labelled demo data, nothing saved to a server).
