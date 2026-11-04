/**
 * Cloudflare Worker entry of the MyInvestor relay. All the behaviour is in
 * `relay.ts`, with the network injected so it is tested without Cloudflare.
 */
import { handleRelay, type RelayEnv } from "./relay";

export default {
  fetch(request: Request, env: RelayEnv): Promise<Response> {
    return handleRelay(request, env, (input, init) => fetch(input, init));
  },
};
