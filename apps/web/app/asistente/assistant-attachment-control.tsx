export const ASSISTANT_SPREADSHEET_ACCEPT =
  ".csv,text/csv,.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export default function AssistantAttachmentControl({
  disabled,
  file,
  onChange,
  onRemove,
}: {
  disabled: boolean;
  file: File | null;
  onChange: (file: File | null) => void;
  onRemove: () => void;
}) {
  return (
    <div className="assistantAttachmentControl">
      <input
        accept={ASSISTANT_SPREADSHEET_ACCEPT}
        disabled={disabled}
        id="assistant-positions-file"
        onChange={(event) => onChange(event.currentTarget.files?.[0] ?? null)}
        type="file"
        value=""
      />
      <label className="assistantAttachmentButton" htmlFor="assistant-positions-file">
        Adjuntar CSV/XLSX
      </label>
      {file ? (
        <div aria-live="polite" className="assistantSelectedAttachment">
          <span>{file.name}</span>
          <button
            aria-label={`Quitar ${file.name}`}
            disabled={disabled}
            onClick={onRemove}
            type="button"
          >
            Quitar
          </button>
        </div>
      ) : null}
    </div>
  );
}
