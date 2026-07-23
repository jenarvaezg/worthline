import { impersonateWorkspaceAction } from "@web/admin/actions";
import {
  grantWorkspacePremiumAction,
  resyncWorkspaceBillingAction,
  revokeWorkspacePremiumAction,
} from "@web/admin/entitlement-actions";
import { guardAdmin } from "@web/admin/guard-admin";
import {
  type AdminEntitlementRow,
  listAdminEntitlements,
} from "@web/admin/list-admin-entitlements";
import { listAdminAiTokenUsage } from "@web/admin/list-ai-token-usage";
import { countAdminOpenMaintainerAlerts } from "@web/admin/list-maintainer-alerts";

export const dynamic = "force-dynamic";

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("es-ES", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

const tokenFormatter = new Intl.NumberFormat("es-ES");

const PLAN_LABEL: Record<AdminEntitlementRow["effectivePlan"], string> = {
  free: "Free",
  premium: "Premium",
  trial: "Trial",
};

/**
 * The human detail beneath a workspace's effective plan: for premium, whether
 * the grant is indefinite or until a date (and the MoR status when a webhook
 * set one, S5); for trial, when the window closes; free has none.
 */
function planDetail(row: AdminEntitlementRow): string | null {
  if (row.effectivePlan === "premium") {
    if (row.subscriptionStatus) return `MoR · ${row.subscriptionStatus}`;
    if (row.isIndefinitePremium) return "indefinido";
    if (row.premiumUntil) return `hasta ${formatDate(row.premiumUntil)}`;
    return null;
  }
  if (row.effectivePlan === "trial" && row.trialEndsAt) {
    return `hasta ${formatDate(row.trialEndsAt)}`;
  }
  return null;
}

/**
 * The /admin surface (#697, ADR 0030): a workspace list from the control plane
 * with per-row "Impersonar", plan state, and the premium palanca (PRD #1160 S4,
 * #1164) — grant premium (dated or indefinite) and revoke, the whole mechanism
 * for the beta grant (#1133) and comps. `guardAdmin()` runs first — any
 * non-admin request never reaches the queries below and gets the app's generic
 * 404, byte-identical to an unknown URL.
 */
export default async function AdminPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await guardAdmin();
  const [{ entError }, rows, openAlerts, tokenUsage] = await Promise.all([
    searchParams,
    listAdminEntitlements(),
    countAdminOpenMaintainerAlerts(),
    listAdminAiTokenUsage(),
  ]);

  return (
    <main className="demoLanding">
      <header className="demoLandingHead">
        <p className="demoKicker">worthline · admin</p>
        <h1>Usuarios</h1>
        <p className="demoLede">
          Workspaces dados de alta en el control plane, con su plan y palanca de premium.{" "}
          <a href="/admin/alertas">
            Alertas de mantenedor
            {openAlerts > 0 ? <span className="alertBadge">{openAlerts}</span> : null}
          </a>{" "}
          · <a href="/admin/catalogo">Catálogo de exposición</a>
        </p>
      </header>

      {/* Canon §2: /admin is an interior tool on paper — the list sits inside a
          section opened by a heavy rule, never on the cover. */}
      <section className="adminList section">
        {entError === "fecha" ? (
          <p className="premiumNotice" role="alert">
            <span className="premiumNoticeText">
              Fecha de premium no válida: usa una fecha futura (o déjala vacía para un
              grant indefinido).
            </span>
          </p>
        ) : null}
        {entError === "resync" ? (
          <p className="premiumNotice" role="alert">
            <span className="premiumNoticeText">
              No se pudo re-sincronizar: el workspace no tiene suscripción del MoR, el
              adapter configurado no coincide con su proveedor, o el proveedor no conoce
              esa suscripción.
            </span>
          </p>
        ) : null}
        <table>
          <thead>
            <tr>
              <th>Email</th>
              <th>Workspace</th>
              <th>Alta</th>
              <th>Plan</th>
              <th>Tokens hoy</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const detail = planDetail(row);
              return (
                <tr key={row.workspaceId}>
                  <td>{row.ownerEmail ?? "—"}</td>
                  <td>{row.workspaceId}</td>
                  <td>{formatDate(row.createdAt)}</td>
                  <td>
                    {PLAN_LABEL[row.effectivePlan]}
                    {detail ? (
                      <>
                        {" "}
                        <span className="demoLede">· {detail}</span>
                      </>
                    ) : null}
                  </td>
                  <td>{tokenFormatter.format(row.tokensToday)}</td>
                  <td className="rowActions">
                    <form action={impersonateWorkspaceAction}>
                      <input name="workspaceId" type="hidden" value={row.workspaceId} />
                      <button className="btnSmall" type="submit">
                        Impersonar
                      </button>
                    </form>
                    <form action={grantWorkspacePremiumAction}>
                      <input name="workspaceId" type="hidden" value={row.workspaceId} />
                      <label>
                        <span className="srOnly">Premium hasta (vacío = indefinido)</span>
                        <input name="premiumUntil" type="date" />
                      </label>
                      <button className="btnSmall" type="submit">
                        Conceder premium
                      </button>
                    </form>
                    {row.effectivePlan === "premium" ? (
                      <form action={revokeWorkspacePremiumAction}>
                        <input name="workspaceId" type="hidden" value={row.workspaceId} />
                        <button className="btnSmall" type="submit">
                          Revocar
                        </button>
                      </form>
                    ) : null}
                    {row.subscriptionId ? (
                      <form action={resyncWorkspaceBillingAction}>
                        <input name="workspaceId" type="hidden" value={row.workspaceId} />
                        <button className="btnSmall" type="submit">
                          Re-sync MoR
                        </button>
                      </form>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      {/* AI spend meter (PRD #1160 S3, #1163): the shared daily token totals so
          the maintainer can see the cost. Aggregate only — no workspace data. */}
      <section className="adminList section">
        <h2>Gasto de IA · tokens/día (global)</h2>
        {tokenUsage.length === 0 ? (
          <p className="demoLede">Aún no hay consumo de IA registrado.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Día</th>
                <th>Tokens</th>
              </tr>
            </thead>
            <tbody>
              {tokenUsage.map((day) => (
                <tr key={day.dayKey}>
                  <td>{day.dayKey}</td>
                  <td>{tokenFormatter.format(day.tokens)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </main>
  );
}
