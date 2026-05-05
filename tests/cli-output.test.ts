import { describe, expect, it } from "bun:test";
import type { ListData } from "../src/cli/output.js";
import { ThomasError, formatError, formatOk, runJson, toErrorPayload } from "../src/cli/json.js";
import { captureStdout } from "./_util.js";

const FROZEN = new Date("2026-05-03T12:00:00.000Z");

const SAMPLE_LIST: ListData = {
  proxy: {
    running: true,
    pid: 1234,
    port: 51168,
    url: "http://127.0.0.1:51168",
    startedAt: "2026-05-03T11:00:00.000Z",
    uptimeSeconds: 3600,
  },
  agents: [{ id: "claude-code", connected: true, shimPath: "/home/u/.thomas/bin/claude" }],
  providers: [
    {
      id: "anthropic",
      protocol: "anthropic",
      baseUrl: "https://api.anthropic.com",
      isBuiltin: true,
      isCustom: false,
      hasCredentials: true,
      credentialSource: "thomas-store",
      knownModels: null,
    },
  ],
  routes: [{ agent: "claude-code", target: { provider: "anthropic", model: "claude-opus-4-7" } }],
};

describe("formatOk", () => {
  it("emits a stable JSON envelope with schemaVersion, command, generatedAt, data", () => {
    const line = formatOk("list", SAMPLE_LIST, FROZEN);
    expect(line.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(line);
    expect(parsed).toEqual({
      schemaVersion: 1,
      command: "list",
      generatedAt: "2026-05-03T12:00:00.000Z",
      data: SAMPLE_LIST,
    });
  });
});

describe("formatError", () => {
  it("emits an error envelope with code, message, and optional remediation", () => {
    const line = formatError(
      "connect",
      {
        code: "E_AGENT_NOT_INSTALLED",
        message: "openclaw is not installed on this host",
        remediation: "install openclaw first, then re-run",
        details: { agent: "openclaw", expectedPaths: ["/usr/local/bin/openclaw"] },
      },
      FROZEN,
    );
    const parsed = JSON.parse(line);
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.command).toBe("connect");
    expect(parsed.error.code).toBe("E_AGENT_NOT_INSTALLED");
    expect(parsed.error.remediation).toBe("install openclaw first, then re-run");
    expect(parsed.data).toBeUndefined();
  });
});

describe("toErrorPayload", () => {
  it("preserves ThomasError payload verbatim", () => {
    const err = new ThomasError({ code: "E_PROVIDER_AUTH", message: "rejected" });
    expect(toErrorPayload(err)).toEqual({ code: "E_PROVIDER_AUTH", message: "rejected" });
  });

  it("wraps generic Error as E_INTERNAL", () => {
    expect(toErrorPayload(new Error("boom"))).toEqual({ code: "E_INTERNAL", message: "boom" });
  });

  it("stringifies non-Error throws as E_INTERNAL", () => {
    expect(toErrorPayload("kaboom")).toEqual({ code: "E_INTERNAL", message: "kaboom" });
  });
});

describe("runJson", () => {
  it("returns 0 and writes JSON envelope on success in --json mode", async () => {
    const { result, out, err } = await captureStdout(() =>
      runJson({
        command: "list",
        json: true,
        fetch: async () => SAMPLE_LIST,
        printHuman: () => {
          throw new Error("printHuman should not be called in json mode");
        },
      }),
    );
    expect(result).toBe(0);
    expect(err).toBe("");
    const parsed = JSON.parse(out);
    expect(parsed.command).toBe("list");
    expect(parsed.data).toEqual(SAMPLE_LIST);
  });

  it("returns 0 and calls printHuman in text mode (no JSON on stdout)", async () => {
    let printed: ListData | null = null;
    const { result, out } = await captureStdout(() =>
      runJson({
        command: "list",
        json: false,
        fetch: async () => SAMPLE_LIST,
        printHuman: (data) => {
          printed = data;
        },
      }),
    );
    expect(result).toBe(0);
    expect(out).toBe("");
    expect(printed).toEqual(SAMPLE_LIST);
  });

  it("returns 1 and writes error envelope on ThomasError in --json mode", async () => {
    const { result, out, err } = await captureStdout(() =>
      runJson<"connect">({
        command: "connect",
        json: true,
        fetch: async () => {
          throw new ThomasError({
            code: "E_AGENT_NOT_FOUND",
            message: "no such agent: foo",
            remediation: "run `thomas doctor` to see installed agents",
          });
        },
        printHuman: () => undefined,
      }),
    );
    expect(result).toBe(1);
    expect(err).toBe("");
    const parsed = JSON.parse(out);
    expect(parsed.error.code).toBe("E_AGENT_NOT_FOUND");
    expect(parsed.error.remediation).toBe("run `thomas doctor` to see installed agents");
  });

  it("returns 1 and writes message + remediation to stderr in text mode", async () => {
    const { result, out, err } = await captureStdout(() =>
      runJson<"connect">({
        command: "connect",
        json: false,
        fetch: async () => {
          throw new ThomasError({
            code: "E_AGENT_NOT_FOUND",
            message: "no such agent: foo",
            remediation: "run `thomas doctor`",
          });
        },
        printHuman: () => undefined,
      }),
    );
    expect(result).toBe(1);
    expect(out).toBe("");
    expect(err).toContain("no such agent: foo");
    expect(err).toContain("run `thomas doctor`");
  });

  it("converts non-ThomasError throws to E_INTERNAL", async () => {
    const { result, out } = await captureStdout(() =>
      runJson<"list">({
        command: "list",
        json: true,
        fetch: async () => {
          throw new Error("unexpected");
        },
        printHuman: () => undefined,
      }),
    );
    expect(result).toBe(1);
    const parsed = JSON.parse(out);
    expect(parsed.error.code).toBe("E_INTERNAL");
    expect(parsed.error.message).toBe("unexpected");
  });
});
