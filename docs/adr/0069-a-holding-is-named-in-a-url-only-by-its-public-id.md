# A holding is named in a URL only by its public id

The product used to hold two names for one holding. Storage calls it
`asset_…`/`liability_…`; the agent-view registry (#335) mints it a
`wl_hld_…` and the MCP accepts nothing else. The web addressed it by the storage
id, so `/patrimonio/asset_groupama_tresorerie_ic_1783421204785/editar` was what
the user saw and what the assistant read out of `screenContext` — and it was
precisely the one identifier no tool would take.

That is not a cosmetic mismatch, because the assistant layer injects the current
route into the system prompt. A session trying to retire two zero-value holdings
from the chat failed on the id from the URL, told the user «el sistema no
reconoce el identificador que aparece en la URL», and fell back to asking them to
press the delete button — while the same holding sat in that turn's
`get_financial_context` under its correct `wl_hld_`. The model then generalised
the wrong lesson and started asking the user to fetch «el ID de la URL de la
página de edición» as «la única forma de que pueda procesar la baja», a flow that
cannot work, and eventually invented `asset_fidelity_s_p_500_index_fund_…` in the
web's format. While the two vocabularies coexist, every screen the user is
looking at is a decoy pointed at the model.

So the public `wl_hld_…` id is the only id that may appear in a URL — path,
query or fragment. The internal id stays exactly what it always was, a storage
key: still fine in a hidden form field, in a store call, in a log. It is simply
never a link.

**There is no redirect from the internal id.** The obvious kindness — accept
both, 308 the old shape — is what was rejected: an alias is the second
vocabulary wearing a hat, and it keeps every producer honest only by accident.
An internal id is a 404. The cost is paid once, by converting every producer:
the board's rows and anchors, the ficha, the alta's success screen, the hero's
data-health links, the connected-source links in ajustes, and the ~50 places
where a server action used to rebuild its own return URL out of the storage id
(they read the `currentUrl` the form already posts instead). A grep guardian
(`apps/web/app/holding-url-guardian.test.ts`) fails the build on a hand-built
holding URL, so the retired vocabulary cannot creep back one template literal at
a time.

The registry is what makes this safe: every creation path mints a public id
(`ensureAgentViewPublicIds` in the asset, liability and connected-source stores,
the workspace import for live and trashed holdings alike, and the #335 backfill
migration), and a persistence test pins it. A gap is therefore a defect, and the
two layers answer it differently on purpose. The agent view raises a controlled
error (`requirePublicId`, ADR 0023) because its contract cannot answer without
the id. The web degrades — an unlinked row, a redirect without its scroll
anchor — because its callers are read surfaces and post-commit redirects, where
raising would blank a whole page or turn a mutation that already succeeded into a
500 over a scroll position. Neither ever falls back to the internal id, which is
the one outcome worse than no link.

The domain stops building holding URLs entirely: `projectPortfolio` used to hand
every row a `detailHref`, which put a web route inside the pure package and, more
to the point, put it there in the only vocabulary the domain knows. Rows carry
their id; the web builds the link.
