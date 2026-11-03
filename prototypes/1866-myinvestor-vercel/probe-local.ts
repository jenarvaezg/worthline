/** PROTOTIPO DESECHABLE de #1866: las mismas sondas sin credenciales, desde el Mac. */
import { probes } from "./lib/probes.js";

console.log(JSON.stringify({ where: "local", steps: await probes() }, null, 2));
