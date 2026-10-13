/**
 * Los `formId` con los que las acciones de cada fuente conectada etiquetan sus
 * errores (#1223/#1225, PRD #1222).
 *
 * Existen porque el error vuelve por redirect y la página tiene que reabrir el
 * pliegue EXACTO que lo produjo: sin esto, el aviso de arriba hablaría de un
 * formulario plegado. La acción escribe el id y el registry de UI lo lee, así que
 * viven aquí —en un módulo plano, no en el `"use server"` de las acciones, que
 * solo puede exportar funciones— para que las dos mitades no puedan divergir.
 */

export const NUMISTA_CONNECT_FORM_ID = "numista";
export const BINANCE_CONNECT_FORM_ID = "binance";

/** El pliegue de cambiar credenciales de una fuente YA conectada (#1225). */
export const NUMISTA_CREDENTIALS_FORM_ID = "numista-credentials";
export const BINANCE_CREDENTIALS_FORM_ID = "binance-credentials";

/**
 * Desconectar una fuente (#1849). En la ficha de su activo el formulario vive en el
 * panel lateral: su rechazo tiene que reabrirlo y pintarse dentro, no en la banda
 * de la página que el panel tapa en móvil.
 */
export const NUMISTA_DISCONNECT_FORM_ID = "numista-disconnect";
export const BINANCE_DISCONNECT_FORM_ID = "binance-disconnect";

/**
 * Adónde vuelve «Eliminar y conservar histórico» cuando no puede volver a la página
 * desde la que se envió: desde la ficha del activo, que ese modo borra, al tablero
 * (#1849). Sin él, a `currentUrl`, como desde Conexiones.
 */
export const RETURN_AFTER_REMOVE_FIELD = "returnToAfterRemove";
