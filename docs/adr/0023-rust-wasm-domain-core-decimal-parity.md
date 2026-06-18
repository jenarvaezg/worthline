# A Rust→WASM domain core, gated on integer-cent parity

worthline's net-worth math — the **amortization plan** engine, the **ripple recalculation**,
the **liquidity ladder**, FIRE — lives in `packages/domain`, a pure-TypeScript package whose
decimal arithmetic is backed by `big.js` behind a single seam (`decimal.ts`). It is the
side-effect-free heart of the product and the most exhaustively tested code in the repo. We
begin carving that math into a **Rust core compiled to WASM**, delegated to from behind the
**unchanged `@worthline/domain` barrel**, starting with the amortization engine as a tracer
bullet (PRD #280). The motivation is **portability**, not speed: a `.wasm` core has no native
addon and no Node builtins, so it runs identically on edge runtimes (Cloudflare Workers,
Vercel Edge) where the current Node-bound stack cannot, and it makes the README's mobile-reuse
goal concrete (the same artifact runs in a future Expo / React Native app).

The hard constraint is that **frozen snapshots stay byte-identical** (ADR 0008) and dated
facts trigger **ripple recalculation** (ADR 0012): if a Rust engine computed even one cent
differently from `big.js`, the ripple would rewrite history. So the whole effort is gated on
**decimal parity defined on the rounded integer minor units** — the values that flow into
snapshots — and nothing else. Parity is _not_ defined on the internal decimal representation
or the choice of Rust crate; only the final rounded integer must match. That is what makes it
tractable: `big.js` and `bigdecimal` both do exact `+ − ×`, and the only rounding is division
(20 decimal places, half-up) and a single edge round to the cent. The contract is enforced by
a **golden-vector harness** (#287) that dumps the TS engine's output over fixtures plus a
seeded fuzz and asserts the Rust engine is integer-identical — proven across 4907 cases before
any app code was touched.

The WASM binding is exposed with the **same signatures** the domain exports today and is
**synchronous after a one-time eager instantiation**: the domain is synchronous and interleaves
with synchronous DB reads and the synchronous `recalculate*` ripple paths, so the engine must
not become async. The cutover is **reversible**: `amortization.ts` becomes a delegation seam
with a `ts | wasm | shadow` flag, and `shadow` runs both engines and reports any diff (never
silently) so confidence is built on real data before the TS implementation is removed.

## Considered options

- **Port the fine-grained `decimal.ts` per-operation seam (add/sub/mul/div/cmp)** — rejected: a
  per-operation JS↔WASM boundary would be _slower_ than `big.js` and far harder to keep at
  parity. The boundary is deliberately **coarse-grained**: one WASM call computes a whole
  schedule internally, so the only values crossing are decimal strings and integers, and parity
  is asserted on the integer result, not on each intermediate operation.
- **Make the WASM calls async (instantiate/await on first use)** — rejected: the domain is
  synchronous and is called inside synchronous DB reads and synchronous ripple recalculation.
  Going async would ripple through `packages/db` and the ~56 web consumers. Eager one-time
  instantiation at package load keeps every subsequent call synchronous.
- **A native addon (N-API) instead of WASM** — rejected: a native addon needs per-platform
  builds and runs on neither edge runtimes nor a future mobile app. Portability is the entire
  point, so WASM wins despite being the slower option in principle.
- **Cut straight over to WASM-only once the gate is green** — rejected: parity is proven on
  sampled vectors, not exhaustively over every real loan. The dual-engine **shadow** mode diffs
  both engines on real data, and the flag keeps the switch reversible at any moment; the TS
  implementation is deleted only after a clean shadow window, in a later change.

## Consequences

- A new `worthline-core` Rust crate (workspace member under `crates/`) holds the engine. It is
  **pure** — no I/O, no clock, dates passed in — and emits **integer minor units**. Decimal
  arithmetic reproduces `big.js`'s defaults (`DP = 20`, round-half-up); `RoundingMode::HalfUp`
  matches `Big.roundHalfUp` (half away from zero).
- The **golden-vector parity harness is a committed gate, not scaffolding**. It asserts
  integer-identical output over fixtures and a seeded fuzz, regenerated from the TS oracle, and
  **must not be deleted or "simplified away"**: it is the standing guarantee that no frozen
  snapshot drifts and no ripple rewrites history. The same applies to the **dual-engine seam** —
  the `ts | wasm | shadow` flag and the retained TS implementation are load-bearing during the
  confidence window, not dead code.
- The JS↔WASM boundary carries **decimal strings and integers only** (no floats), so marshalling
  loses no precision. The `@worthline/domain` barrel surface is unchanged, so `packages/db` and
  every web consumer compile and behave identically.
- This is **pure compute**: no schema, no migration ladder step, no figure moves. The
  frozen-snapshot guarantee (ADR 0008) is preserved **by construction** (parity), not by a
  migration.
- The TS boundary memo (#158) is a byte-identical performance optimization and is **not** ported
  into the Rust engine. If the per-call schedule rebuild proves too slow on the WASM hot path, a
  curve cache belongs **behind the seam**, never inside the pure engine.
- Scope is the **amortization engine only**. `debt-balance`, `housing-valuation`, the ripple
  orchestration in `historical-snapshot.ts`, `fire`, `net-worth`, connected sources, and
  statement parsing each follow in later PRDs once Modules B (binding), C (parity harness), and
  D (seam) are proven on this tracer bullet.
- Builds on the two-date disbursement/first-payment model of **ADR 0019** (the engine reproduces
  its stub-interest first cuota and flat-stub balance curve), and exists to protect **ADR 0008**
  (byte-identical frozen snapshots) and **ADR 0012** (ripple recalculation) through the cutover.
