# Security Policy

worthline handles personal financial data, so security reports are taken
seriously. This is a personal, open-source project (no commercial SLA), but
genuine vulnerability reports will be acknowledged and addressed on a best-effort
basis.

## Reporting a vulnerability

**Do not open a public GitHub issue for security problems.** Report privately by
email instead:

- **Email:** jenarvaezg@gmail.com
- **Subject:** `[SECURITY] worthline: <short summary>`

Please include the following, so a report can be triaged quickly:

1. **Type / summary** — what kind of issue it is (e.g. auth bypass, injection,
   data exposure, SSRF) in one line.
2. **Affected area** — the file, route, package, or feature, and the commit SHA
   or branch you observed it on.
3. **Steps to reproduce** — a minimal, ordered sequence, including any required
   configuration or environment (local no-auth mode vs hosted mode).
4. **Impact** — what an attacker can actually do (read which data, escalate to
   what, affect which users/workspaces).
5. **Proof of concept** — request/response, payload, or script if you have one.
6. **Suggested fix** — optional, if you have one in mind.
7. **Credit** — whether you'd like to be credited, and how.

## What to expect

- An acknowledgement of your report within a few days.
- An honest assessment of severity and whether it's in scope.
- A heads-up when a fix lands on `main`.

Please give a reasonable window to fix the issue before disclosing it publicly,
and avoid accessing or modifying data that isn't yours while testing. Good-faith
research that follows this policy is welcome and won't be pursued.

## Scope

In scope: the worthline application code in this repository.

Out of scope: vulnerabilities in third-party dependencies (report those
upstream), and anything requiring physical access to a machine already running
the app with its local data.
