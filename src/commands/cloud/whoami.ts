// `thomas cloud whoami` — local-only inspection of cloud.json.
//
// Doesn't hit the network. The agent driving thomas hits this every time it
// needs to render "are we logged in?" — keeping it cheap matters.

import { runJson } from "../../cli/json.js";
import type { CloudWhoamiData } from "../../cli/output.js";
import { readIdentity } from "../../cloud/identity.js";

export async function cloudWhoami(opts: { json: boolean }): Promise<number> {
  return runJson({
    command: "cloud.whoami",
    json: opts.json,
    fetch: async (): Promise<CloudWhoamiData> => {
      const identity = await readIdentity();
      if (!identity) {
        return {
          loggedIn: false,
          baseUrl: null,
          workspaceId: null,
          deviceId: null,
          loggedInAt: null,
          lastSyncAt: null,
        };
      }
      return {
        loggedIn: true,
        baseUrl: identity.baseUrl,
        workspaceId: identity.workspaceId,
        deviceId: identity.deviceId,
        loggedInAt: identity.loggedInAt,
        lastSyncAt: identity.lastSyncAt ?? null,
      };
    },
    printHuman: (d) => {
      if (!d.loggedIn) {
        console.log("Not logged in. Run `thomas cloud login`.");
        return;
      }
      console.log(`Logged in to ${d.baseUrl}`);
      console.log(`  workspace:    ${d.workspaceId}`);
      console.log(`  device:       ${d.deviceId}`);
      console.log(`  logged in at: ${d.loggedInAt}`);
      console.log(`  last sync:    ${d.lastSyncAt ?? "never (run `thomas cloud sync`)"}`);
    },
  });
}
