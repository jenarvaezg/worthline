# The service provider's identity is configuration, never source

## Context

Spain's LSSI-CE art. 10 obliges whoever operates a paid online service to publish, in a
"permanent, easy, direct and free" way, their **name**, **tax id (NIF)** and a channel for
"direct and effective communication". worthline's legal cover (#1172, PRD #1171 S1) is where
that lives: `/legal/aviso-legal`, and — for the data controller — `/legal/privacidad`.

This repository is **public**. The operator is an individual sole trader, so the identity the
law wants published is a natural person's name, tax id and postal address. Committing any of
it would put personal data in the git history permanently, where no later edit can remove it,
and where it is copied into every fork and clone. The project already keeps real data out of
git for exactly this reason (real-data scripts live under `.local/`).

There is also an operational asymmetry: the texts themselves are product — reviewed,
versioned, tested — while the identity is a property of **the deployment**. A fork, a preview
deploy and a self-hosted instance each have a different (or no) provider.

## Decision

The provider's identity enters through **environment variables**, resolved at request time,
and never appears as a literal in source:

| Variable | Required | Publishes |
| --- | --- | --- |
| `WORTHLINE_LEGAL_OPERATOR_NAME` | yes | name of the provider |
| `WORTHLINE_LEGAL_TAX_ID` | yes | tax id (NIF) |
| `WORTHLINE_LEGAL_CONTACT_EMAIL` | yes | the direct, effective contact channel |
| `WORTHLINE_LEGAL_POSTAL_ADDRESS` | no | address for notices; published only when set |

Three consequences follow, and each is enforced rather than documented:

1. **A missing value is stated, never silently omitted.** `resolveLegalIdentity` returns the
   list of unset mandatory variables; the page renders "pendiente de configurar" where the
   value would be. The *names* of the variables go to the server log, not to the public page
   — a legal notice is not the place to publish a deployment's configuration keys.
2. **No literal identity in the legal sources.** A guardian test walks `app/legal/_documents`
   and fails on anything shaped like a Spanish NIF/NIE, or on an email that is not an
   `example.com` placeholder.
3. **The read happens at request time, behind `connection()`.** Reading `process.env` during
   render would otherwise also run during the build prerender, freezing the static shell with
   the build's environment; when the serving runtime has different values, the served HTML
   and the React tree diverge and hydration fails (React error 418, reproduced locally). The
   document body therefore sits inside a `<Suspense>` whose async child awaits `connection()`
   first, and a guardian pins `legal-page.tsx` as the only caller of `readLegalIdentity()`.

The postal address is deliberately optional: art. 10.1.a is satisfied by a channel allowing
direct and effective communication, and whether to publish an address is a decision for the
operator and their advisor, not a code default.

## Consequences

- Changing the published identity is a deploy-time change: set the variable and redeploy. No
  code change, no PR, no trace in the public history.
- A fork or a self-hosted instance publishes its own operator, or says plainly that it has
  none configured — it cannot accidentally publish this project's.
- The deployment checklist owns these four variables. A deploy that charges money with them
  unset serves a legal notice that does not satisfy art. 10; the page says so out loud, and
  the server log names the gap, but nothing refuses to boot — the refusal belongs with the
  day-L checklist of PRD #1171, not with a page render.
- Whether the tax id is published at all remains the operator's decision with their advisor.
  The code makes it possible and honest either way; it does not make it for them.
