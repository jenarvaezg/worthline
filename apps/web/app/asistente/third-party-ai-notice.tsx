/** Provider-agnostic copy for the permanent third-party AI notice (#955). */
export const THIRD_PARTY_AI_NOTICE_TEXT =
  "Este asistente usa servicios de inteligencia artificial de terceros. Tus preguntas y los datos de tu workspace pueden enviarse a esos proveedores.";

/**
 * Permanent disclosure that the assistant routes prompts and workspace data to
 * third-party AI providers (#955). Shown at the top of the conversation area in
 * every state — empty, active, or after an error — and never tied to the active
 * provider in the pool.
 */
export default function ThirdPartyAiNotice() {
  return (
    <p className="assistantThirdPartyNotice" role="note">
      {THIRD_PARTY_AI_NOTICE_TEXT}
    </p>
  );
}
