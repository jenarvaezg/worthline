/**
 * «Aportación» (#1886, design B): the tab of a holding MyInvestor owns that has
 * scheduled contributions there. Read-only and server-rendered: the schedule in
 * one line opened by a rule, who changes it, and each occurrence beside the order
 * that matched it, most recent first. The words are `scheduledContributionView`'s.
 *
 * Its own table, not the compact ledger's (`.opsLedger`): that one recomposes its
 * cells into a grid on the phone by the ledger's columns, which these are not.
 */

import type { ScheduledContributionView } from "./scheduled-contribution-view";

export function ScheduledContributionSection({
  view,
}: {
  view: ScheduledContributionView;
}) {
  return (
    <section aria-label="Aportación programada en MyInvestor">
      {view.blocks.map((block, index) => (
        <div className="fichaSchedule" key={block.key}>
          <p className="fichaScheduleLine">
            {block.lead ? <strong>{block.lead}</strong> : null}
            {block.lead ? " " : null}
            {block.line}
          </p>
          {/* Who changes it and whether it warns: said once, under the first line. */}
          {index === 0 ? <p className="muted fichaScheduleNote">{view.note}</p> : null}
          {block.rows.length > 0 ? (
            <table className="fichaScheduleTable">
              <thead>
                <tr>
                  <th scope="col">Programada</th>
                  <th scope="col">Orden que casa</th>
                  <th scope="col">Estado</th>
                </tr>
              </thead>
              <tbody>
                {block.rows.map((row) => (
                  <tr key={row.key}>
                    <td className="fichaScheduleFigure">{row.date}</td>
                    <td className="fichaScheduleFigure">{row.order}</td>
                    <td>
                      {row.tone === "missing" ? (
                        <span className="fichaScheduleMissing">{row.status}</span>
                      ) : (
                        row.status
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
        </div>
      ))}
    </section>
  );
}
