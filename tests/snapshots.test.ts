import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deleteSnapshot, readSnapshot, writeSnapshot } from "../src/config/snapshots.js";

describe("snapshots", () => {
  let dir: string;
  const originalHome = process.env.THOMAS_HOME;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "thomas-snap-"));
    process.env.THOMAS_HOME = dir;
  });

  afterEach(async () => {
    if (originalHome !== undefined) process.env.THOMAS_HOME = originalHome;
    else delete process.env.THOMAS_HOME;
    await rm(dir, { recursive: true, force: true });
  });

  it("returns undefined when no snapshot exists", async () => {
    expect(await readSnapshot("openclaw")).toBeUndefined();
  });

  it("round-trips a snapshot", async () => {
    await writeSnapshot({
      agentId: "openclaw",
      takenAt: "2026-05-02T00:00:00.000Z",
      configFile: "/tmp/openclaw.json",
      data: { previousModelPrimary: "vllm/og-coding" },
    });
    const got = await readSnapshot("openclaw");
    expect(got?.agentId).toBe("openclaw");
    expect(got?.data.previousModelPrimary).toBe("vllm/og-coding");
  });

  it("delete is idempotent and removes the snapshot", async () => {
    await deleteSnapshot("openclaw");
    await writeSnapshot({
      agentId: "openclaw",
      takenAt: "2026-05-02T00:00:00.000Z",
      configFile: "/tmp/openclaw.json",
      data: {},
    });
    expect(await readSnapshot("openclaw")).toBeDefined();
    await deleteSnapshot("openclaw");
    expect(await readSnapshot("openclaw")).toBeUndefined();
  });
});
