/**
 * The alta form's shared ownership footer (#737), extracted from the page in
 * #1700.
 *
 * Shared chrome, not a family: it posts UNSUFFIXED (`ownershipPreset`,
 * `scopeMemberId`, `owner_<member>`) because every pane shares it — the reading
 * half of that contract is `carryOwnership` in `_families/alta-form.ts`.
 *
 * A single-member workspace has nothing to choose, so it posts two hidden fields
 * instead of a fieldset. Custom splits below 100% are honoured only for real
 * estate: money and investments always sum to 100.
 */

import type { Member } from "@worthline/domain";

export function OwnershipInputs({
  members,
  scopeMemberId,
  values,
  allowCustomSplit,
  stepLabel,
}: {
  members: Member[];
  scopeMemberId: string | undefined;
  values: Record<string, string>;
  /** Custom splits below 100% are only honoured for real estate (#737). */
  allowCustomSplit: boolean;
  /**
   * El rótulo de tramo del alta simple (#1732), p. ej. «Paso 3 de 3 · Reparto».
   * Lo pone quien sabe cuántos tramos tiene su formulario; omitirlo deja la
   * leyenda de siempre, que es lo que quiere el modo avanzado.
   */
  stepLabel?: string;
}) {
  const scopeMember = members.find((m) => m.id === scopeMemberId) ?? members[0];

  if (!scopeMember) {
    return null;
  }

  if (members.length <= 1) {
    return (
      <>
        <input name="scopeMemberId" type="hidden" value={scopeMember.id} />
        <input name="ownershipPreset" type="hidden" value="scope" />
      </>
    );
  }

  const preset = allowCustomSplit
    ? values["ownershipPreset"]
    : values["ownershipPreset"] === "custom"
      ? "even"
      : values["ownershipPreset"];

  return (
    <fieldset className="ownershipGrid simpleOwnership">
      <legend>{stepLabel ?? "Reparto"}</legend>
      <input name="scopeMemberId" type="hidden" value={scopeMember.id} />
      <label className="ownerPreset">
        <input
          defaultChecked={preset === "scope"}
          name="ownershipPreset"
          type="radio"
          value="scope"
        />
        Solo mío
      </label>
      <label className="ownerPreset">
        <input
          defaultChecked={!preset || preset === "even"}
          name="ownershipPreset"
          type="radio"
          value="even"
        />
        De los dos (mitad y mitad)
      </label>
      {allowCustomSplit ? (
        <label className="ownerPreset">
          <input
            defaultChecked={preset === "custom"}
            name="ownershipPreset"
            type="radio"
            value="custom"
          />
          Otro reparto…
        </label>
      ) : null}
      {allowCustomSplit ? (
        <div className="ownerCustom">
          {members.map((member, index) => (
            <label key={member.id}>
              {member.name}
              <input
                aria-label={`Porcentaje de ${member.name}`}
                defaultValue={values[`owner_${member.id}`] ?? (index === 0 ? "50" : "50")}
                inputMode="decimal"
                name={`owner_${member.id}`}
              />
            </label>
          ))}
          <p className="simpleHint">
            ¿Un inmueble a medias con alguien de fuera? Pon solo vuestra parte; el resto
            se da por suyo. Solo se admite en inmuebles — el dinero y las inversiones
            suman al 100%.
          </p>
        </div>
      ) : null}
    </fieldset>
  );
}
