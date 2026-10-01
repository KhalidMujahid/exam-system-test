# CyberCops Academy · v2.0.1

Express, EJS, HTMX, and Prisma/PostgreSQL assessment platform.

## Development

Install dependencies with `npm ci`, configure the environment using `.env.example`, generate the Prisma client with `npm run prisma:generate`, then run `npm run dev`. The default port is 3000. Use an existing, compatible database; startup does not seed data automatically.

## Design system

- `tailwind.config.cjs`: utility theme and template scanning.
- `styles/tailwind.css`: utility stylesheet entry point.
- `public/utilities.css`: compiled utilities, served locally and checked in.
- `public/styles.css`: existing shared components and certificate styles.
- `public/design.css`: v2.0.1 tokens, page layouts, responsive and admin workspace styles.

Run `npm run build` after changing templates or utility classes, and before deployment. `npm start` runs the server. No runtime Tailwind CDN is required.

## Public materials

`/materials` publicly lists resources for both paid and free courses, with search, course filters, and pages of 24. No login or payment is required to browse, open, or download materials. Paid assessment selection remains on **Certifications**, and starting a paid assessment still requires verified payment. Admins can add resources and edit each material's title, link, and course under **Admin Dashboard → Course Materials**. No new database fields are required.

**Open material** opens the original link. **Download** converts Google Drive file links into download URLs; other links open at their provider. All resource links are public in the app; file-provider sharing settings still control access to the underlying file. Files are not copied or proxied through this server.

## Paid course enrolment

Select a course on Certifications and provide a payment email. Verified Paystack callbacks/webhooks mark the purchase successful without starting an exam. The callback grants a signed, HTTP-only course-access cookie. Students can then read materials, fill in their name and institution, and start the assessment. Repeated start requests reuse the same attempt; a database row lock serializes concurrent starts. Certificate purchases use their separate flow.

Access cookies last 30 days and are signed with the configured Paystack secret. Returning through the private payment confirmation link restores access. Admin login now uses expiring server-side sessions instead of a fixed cookie value; restarting the server or changing the password requires signing in again. These sessions are intended for one server process; multiple instances need a shared session store.

## Isolated checks

Run `node tests/course-flow.cjs` for isolated payment, access, duplicate-start, webhook, and material-edit checks. Start `node tests/design-preview.cjs` in one terminal, then run `node tests/design-check.cjs` in another. The preview runs the real routes with in-memory sample data on `127.0.0.1:3108`, without using your database or payment keys. Its test-session endpoint exists only in the isolated preview.

For browser checks, make Playwright available locally (or set `PLAYWRIGHT_MODULE` to its module path), then run `node tests/design-browser.cjs`. The script uses installed Microsoft Edge in headless mode and writes screenshots to `artifacts/`. It checks public search, empty states, admin tabs, course selection, mobile navigation, browser errors, and responsive overflow.

## Release limits

Full production readiness still requires server-side assessment deadline enforcement and migration coverage for the current Prisma schema. The isolated checks mock PostgreSQL and Paystack; live gateway behavior and database locking must also be validated in staging.
