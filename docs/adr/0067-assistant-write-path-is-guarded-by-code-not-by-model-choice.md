# The assistant's write path is guarded by code, not by the choice of model

The admission gate scores two dimensions and admits only a candidate that clears
the threshold in each. `reading` asks how well a model reads the workspace —
figure and delta attribution, honest missing-fact behaviour, sources cited,
Spanish by default. `tool-discipline` asks whether the turn called the tool it
claimed to call, whether an identifier it wrote came out of a read, whether it
reached for a bulk import over evidence worthline never validated, and whether it
asks rather than guesses when the holding or the figure is ambiguous. The second
is graded from the tool trace; prose cannot satisfy it.

The dimensions are scored apart because one ratio let the strong one pay for the
broken one. A live run scored the pool's first model at 88% on a day it had faked
a proposal card in prose and written a holding id that came from nowhere: reading
checks outnumber write-path checks about two to one, so the number that decided
admission was mostly measuring the half that was working. A blended score cannot
answer «is this model fit for the path that writes», which is the only question
that matters before a model is allowed near money.

Routing by task — a cheap model for reads, an expensive one for turns that can
end in a write — is deliberately NOT adopted. The two failures the write-path
questions actually found are both in the class that code closes and a better
model only makes rarer: the model asked for a bulk import from rows pasted into
the chat, which the unvalidated-evidence frontier rejects and routes, and it
built a proposal around an identifier no read had surfaced, which is a server-side
invariant to enforce rather than a behaviour to hope for. A frontier model lowers
the frequency of both; it converts neither into a boundary. Paying per-turn for a
lower frequency, while the boundary itself is still missing, buys the weaker half
of the same guarantee.

This is the same principle as the eighth decision of the PRD #1241 grilling — no
guarantee may depend on the prompt — applied one layer out: a guarantee that
depends on the model is that same bet with a different face. It is also what the
security review of #1246 assumed, where the confirmation card is the last defence
against an injected turn; the card must hold for the model we have, not for the
model we hope to buy.

So both paths keep the same model: the pool's first credential-backed entry,
today Gemini 3.1 Flash Lite, for reads and for writes alike. What the runs fix is
the shape of the bill if that ever changes. One turn's floor is about 13.000 input
tokens — measured, not estimated: Groq's free tier rejects the request outright
with «Limit 12000, Requested 13017» — and it is a floor because it is the system
prompt plus the tool schemas, before a single word of conversation. Routing the
write turns to a paid frontier model therefore trades a free turn for a
cents-per-turn one at a volume worthline meters precisely because it is the
product's variable cost (PRD #1160), and buys a lower failure frequency rather
than a boundary. The free tier offers no second path either: on 2026-07-27 the
pool's third entry could not accept a single request of the current turn (#1278),
and its second lost two of eighteen questions to tokens per minute even at 55 s of
pacing.

The two-model comparison also shows why a better write-path number is not
automatically a better model. Gemini acts and gets one thing wrong — it built a
proposal around an identifier no read had surfaced. Cerebras scores higher on the
same questions largely by not acting at all: on three of the five write-path turns
it called no read tool, and on the one that should end in a proposal it called no
proposal tool. Three of those five questions grade the model for NOT doing
something, so inertia scores well there. Discipline and inertia are not the same
property, and only the tool trace tells them apart.

What would flip the decision is written down, so it is a deferral and not a
silence. Route by task when a run shows the `tool-discipline` dimension below the
admission threshold, or when it shows a failure of a kind code cannot check: a
proposal that names a real but WRONG holding among ambiguous candidates, or a
figure invented rather than asked for. Both are failures of judgement, not of
provenance, and no server-side invariant can catch them. Until then the write
path's cost stays flat and the work goes into the frontiers.

## Consequences

- Admission is per dimension, so a model that reads well and writes badly is
  rejected rather than averaged into the pool.
- The pool keeps one model for every turn: no per-turn model decision, no second
  cost curve, and no turn whose behaviour depends on which path routed it.
- The graders for the write path call the production frontiers rather than
  restating them, so a widened frontier cannot leave the measurement behind.
- A committed pool mark from before this dimension existed states a reading score
  and nothing about writes; refreshing it is a real re-run, not an edit.
- The write-path failures the gate finds are ticket material for the frontiers
  (#1263 for identifier provenance), not an argument to change models.
