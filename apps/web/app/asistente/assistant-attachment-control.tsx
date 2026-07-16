import { ASSISTANT_ATTACHMENT_ACCEPT } from "./attachment-types";

export { ASSISTANT_ATTACHMENT_ACCEPT };

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
        accept={ASSISTANT_ATTACHMENT_ACCEPT}
        disabled={disabled}
        id="assistant-positions-file"
        onChange={(event) => onChange(event.currentTarget.files?.[0] ?? null)}
        type="file"
        value=""
      />
      <label className="assistantAttachmentButton" htmlFor="assistant-positions-file">
        Adjuntar captura/CSV/XLSX/PDF
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
