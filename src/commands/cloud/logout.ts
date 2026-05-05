// `thomas cloud logout` — clear local cloud.json.
//
// Server-side device revocation (DELETE /v1/devices/{id}) lands once the
// API exposes that endpoint. For now, logout is purely local — the device
// token stays valid on the server but can't be used because nothing on
// this machine knows it anymore.

import { runJson } from "../../cli/json.js";
import type { CloudLogoutData } from "../../cli/output.js";
import { clearIdentity, readIdentity } from "../../cloud/identity.js";

export async function cloudLogout(opts: { json: boolean }): Promise<number> {
  return runJson({
    command: "cloud.logout",
    json: opts.json,
    fetch: async (): Promise<CloudLogoutData> => {
      const before = await readIdentity();
      const removed = await clearIdentity();
      return { wasLoggedIn: !!before && removed };
    },
    printHuman: (d) => {
      if (d.wasLoggedIn) {
        console.log("Logged out (local state cleared).");
      } else {
        console.log("Was not logged in.");
      }
    },
  });
}
