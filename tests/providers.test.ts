import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getProvider,
  listProviders,
  registerCustom,
  unregisterCustom,
} from "../src/providers/registry.js";

describe("provider registry", () => {
  let dir: string;
  const originalHome = process.env.THOMAS_HOME;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "thomas-providers-"));
    process.env.THOMAS_HOME = dir;
  });

  afterEach(async () => {
    if (originalHome !== undefined) process.env.THOMAS_HOME = originalHome;
    else delete process.env.THOMAS_HOME;
    await rm(dir, { recursive: true, force: true });
  });

  it("returns built-in providers without any config file", async () => {
    expect(await getProvider("anthropic")).toMatchObject({
      id: "anthropic",
      protocol: "anthropic",
    });
    expect(await getProvider("openrouter")).toMatchObject({ protocol: "openai" });
    expect(await getProvider("nonexistent")).toBeUndefined();
  });

  it("registers and looks up custom providers", async () => {
    await registerCustom({
      id: "og-coding",
      protocol: "openai",
      originBaseUrl: "https://api.xiangxinai.cn/coding",
    });
    const provider = await getProvider("og-coding");
    expect(provider).toMatchObject({
      id: "og-coding",
      protocol: "openai",
      originBaseUrl: "https://api.xiangxinai.cn/coding",
    });
  });

  it("rejects ids that collide with built-ins", async () => {
    await expect(
      registerCustom({
        id: "anthropic",
        protocol: "openai",
        originBaseUrl: "https://example.com",
      }),
    ).rejects.toThrow(/built-in/);
  });

  it("upserts on duplicate registration", async () => {
    await registerCustom({
      id: "x",
      protocol: "openai",
      originBaseUrl: "https://a.example.com",
    });
    await registerCustom({
      id: "x",
      protocol: "openai",
      originBaseUrl: "https://b.example.com",
    });
    const all = await listProviders();
    const xs = all.filter((p) => p.id === "x");
    expect(xs).toHaveLength(1);
    expect(xs[0]!.originBaseUrl).toBe("https://b.example.com");
  });

  it("unregisters a custom provider", async () => {
    await registerCustom({
      id: "drop-me",
      protocol: "openai",
      originBaseUrl: "https://x.example.com",
    });
    expect(await unregisterCustom("drop-me")).toBe(true);
    expect(await getProvider("drop-me")).toBeUndefined();
    expect(await unregisterCustom("drop-me")).toBe(false);
  });

  it("lists built-ins plus customs with the custom flag", async () => {
    await registerCustom({
      id: "my-provider",
      protocol: "openai",
      originBaseUrl: "https://x.example.com",
    });
    const all = await listProviders();
    const builtin = all.find((p) => p.id === "openai");
    const custom = all.find((p) => p.id === "my-provider");
    expect(builtin?.custom).toBeUndefined();
    expect(custom?.custom).toBe(true);
  });
});
