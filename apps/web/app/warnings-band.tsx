export interface Warning {
  entityId: string;
  message: string;
  code: string;
}

export default function WarningsBand({ warnings }: { warnings: Warning[] }) {
  if (warnings.length === 0) return null;

  return (
    <div className="warningBand" role="alert" aria-label="Avisos">
      <span className="warningCount">
        {warnings.length} {warnings.length === 1 ? "aviso" : "avisos"}
      </span>
      {warnings.map((w) => (
        <div className="warningItem" key={`${w.entityId}-${w.code}`}>
          <span>⚠ {w.message}</span>
          <a href={`/patrimonio/${w.entityId}/editar`} className="warningLink">
            Ver activo
          </a>
        </div>
      ))}
    </div>
  );
}
