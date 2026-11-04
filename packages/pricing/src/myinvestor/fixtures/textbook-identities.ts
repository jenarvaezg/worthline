/**
 * Valid identifiers for the tests of the fixture tooling (#1887): the ECBS documentation
 * IBAN and the DNI/NIE examples every Spanish validator uses. They are BUILT here, never
 * written whole, so no file of the work holds a literal valid IBAN or DNI/NIE and the
 * leak check's identity check can run over every file without exceptions.
 */
import { ibanCheckDigits, spanishIdControlLetter } from "./identity-checks";

const BBAN = "21000418450200051332";

export const TEXTBOOK_IBAN = `ES${ibanCheckDigits("ES", BBAN)}${BBAN}`;
export const TEXTBOOK_DNI = `12345678${spanishIdControlLetter(12345678)}`;
export const TEXTBOOK_NIE = `X1234567${spanishIdControlLetter(1234567)}`;
export const TEXTBOOK_KLM = `K1234567${spanishIdControlLetter(1234567)}`;
