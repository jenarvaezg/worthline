# Turbo Remote Cache (Vercel)

> **Issue:** [#802](https://github.com/jenarvaezg/worthline/issues/802).  
> **Mapa:** [#804](https://github.com/jenarvaezg/worthline/issues/804).

CI and deploy share Turborepo task outputs via [Vercel Remote Cache](https://turbo.build/docs/core-concepts/remote-caching) (included on Hobby). Without credentials, Turbo keeps using **local** `.turbo/` only — workflows still pass.

## One-time GitHub setup

1. **Create a Vercel token**  
   [Vercel → Account/Team Settings → Tokens](https://vercel.com/account/tokens)  
   Scope: access to the team that owns the worthline project.

2. **Repository secret** `TURBO_TOKEN`  
   GitHub → `jenarvaezg/worthline` → Settings → Secrets and variables → Actions → New repository secret.

3. **Repository variable** `TURBO_TEAM`  
   Same page → Variables → New repository variable.  
   Value: your **team slug** from the Vercel URL (`vercel.com/<slug>/…`), not the `team_…` id. For a personal account, use your username.

## Local development (optional)

Share the same remote cache from your machine:

```bash
bunx turbo login
```

Or export the same `TURBO_TOKEN` and `TURBO_TEAM` before running `bun run build` / `verify`.

## Verifying in CI

After secrets are set, re-run a green workflow twice on the same commit (or push an empty commit). Turbo logs should show **cache hit** / `>>> FULL TURBO` for unchanged packages — especially `@worthline/web#build` shared between the **quality** and **e2e** jobs.

## What is cached

Per `turbo.json`: `build`, `typecheck`, `test`, `test:coverage` (and their dependency graph). Biome runs at repo root and is **not** a Turbo task.
