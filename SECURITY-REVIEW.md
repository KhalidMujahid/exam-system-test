# Security review

The application is a single-process Express 5 server using EJS/HTMX, Prisma/PostgreSQL, and Paystack. Paid purchases unlock course access and an assessment; free assessments start directly. Learning materials are intentionally public according to the existing regression tests. Certificates use a lookup code and may require a separate payment.

## Verified issues fixed

- Exam submission previously accepted any attempt ID without ownership evidence. Both free and paid starts now issue an HttpOnly signed attempt cookie, checked before reading results or submitting answers.
- The browser was the only deadline enforcement. The signed cookie binds the start time and duration; submissions beyond the deadline plus a 10-second transport grace period receive no credit.
- Concurrent submissions could overwrite grades and duplicate responses. A PostgreSQL row lock now serializes grading inside a transaction, including the completion counter.
- Certificate lookup codes were truncated base64 of names and scores, exposing identity and allowing collisions/prediction. New results use 192 bits of randomness. Existing codes are preserved for compatibility and should be reviewed before public deployment.
- Admin login had no throttling, allowed a known default password, and accepted four-character replacements. The default is rejected, replacement passwords require 12 characters (maximum 72 UTF-8 bytes), and the single admin account is limited to 20 login requests per 15 minutes.
- All browser POST routes now require a matching Origin or Referer. The Paystack webhook is exempt and continues to require its HMAC signature. This follows [OWASP origin verification guidance](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html).
- Payment callback URLs now require configured APP_BASE_URL instead of trusting Host. Certificate transaction verification also checks the transaction reference.
- Material opening rejects unsafe URL schemes. Responses suppress referrers and caching and prevent framing and MIME sniffing.

## Operations and limits

Set APP_BASE_URL to the exact public origin. Set SESSION_SECRET to a randomly generated secret of at least 32 bytes; without it, assessment cookies stop working after restart. Existing active assessments need to be restarted or resumed to receive an access cookie.

If the admin password is still the old default, set ADMIN_INITIAL_PASSWORD to a strong password, run `node scripts/reset-admin.cjs`, then restart the server and remove that bootstrap password from the environment. The review did not execute this command or modify the configured database.

Admin sessions and throttling remain process-local. Multiple replicas require a shared store. The account-wide throttle limits distributed guessing but can temporarily deny legitimate login. Payment confirmation URLs are bearer links that restore access; do not share them. Public material links remain public by design. Existing certificate codes have not been rotated. Exam duration comes from the current setting when a paid assessment is resumed; immutable per-attempt deadlines would require a database migration.

## Verification

Run `node tests/course-flow.cjs` and `node tests/security.cjs`. Both use an isolated in-memory Prisma/payment fixture; they do not connect to the configured database or payment account. A real PostgreSQL integration test is still needed to validate row-lock behavior in deployment. Run `npm audit` for dependency advisories.
