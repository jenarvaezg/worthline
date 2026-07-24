# Turbo Remote Cache (Vercel)

> **Issue:** [#802](https://github.com/jenarvaezg/worthline/issues/802).  
> **Mapa:** [#804](https://github.com/jenarvaezg/worthline/issues/804).

CI and deploy share Turborepo task outputs via [Vercel Remote Cache](https://turbo.build/docs/core-concepts/remote-caching) (included on Hobby). Without credentials, Turbo keeps using **local** `.turbo/` only — workflows still pass.

## One-time GitHub setup

1. **`TURBO_CACHE_TOKEN`** — a Vercel access token scoped to the remote cache, **not** the deploy-capable `VERCEL_TOKEN` (#1180). CI runs on every pull request; it must not carry a token that can deploy or mutate the Vercel project just to hit a build cache.

   ```bash
   # Vercel → Account Settings → Tokens → Create, then:
   gh secret set TURBO_CACHE_TOKEN -R jenarvaezg/worthline
   ```

   Both workflows read `${{ secrets.TURBO_CACHE_TOKEN || secrets.VERCEL_TOKEN }}`: **until `TURBO_CACHE_TOKEN` exists the fallback keeps the cache working with the deploy token** — i.e. the hardening is inert until the secret is provisioned. Setting it is the whole change; nothing else needs editing. `tests/tooling/workflow-permissions.test.ts` guards the wiring.

2. **Repository variable** `TURBO_TEAM`  
   GitHub → Settings → Secrets and variables → Actions → Variables.  
   Value: team **slug** from `vercel teams ls` (first column), e.g. `jenarvaezgs-projects` — not `VERCEL_ORG_ID` (`team_…`).

   ```bash
   vercel teams ls
   gh variable set TURBO_TEAM --body "<slug>" -R jenarvaezg/worthline
   ```

## Local development (optional)

Share the same remote cache from your machine:

```bash
bunx turbo login
```

Or export `VERCEL_TOKEN` (or `TURBO_TOKEN` with the same value) and `TURBO_TEAM` before running `bun run build` / `verify`.

## Verifying in CI

After secrets are set, re-run a green workflow twice on the same commit (or push an empty commit). Turbo logs should show **cache hit** / `>>> FULL TURBO` for unchanged packages — especially `@worthline/web#build` shared between the **quality** and **e2e** jobs.

## What is cached

Per `turbo.json`: `build`, `typecheck`, `test`, `test:coverage` (and their dependency graph). Biome runs at repo root and is **not** a Turbo task.
