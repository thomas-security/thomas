export type AgentId = "claude-code" | "codex" | "openclaw" | "hermes";

export type Protocol = "anthropic" | "openai";

export type CredentialSource =
  | { kind: "keychain"; service: string; account: string }
  | { kind: "file"; path: string }
  | { kind: "env"; name: string };

export type DetectResult = {
  installed: boolean;
  binaryPath?: string;
  version?: string;
  configPaths: string[];
  credentialSources: CredentialSource[];
  skillDir?: string;
};

import type { Credential } from "../config/credentials.js";

export type AgentSpec = {
  id: AgentId;
  displayName: string;
  binaries: string[];
  protocol: Protocol;
  shimEnv: { baseUrl: string; apiKey: string };
  /** Path appended after `http://host:port` when injecting the base URL env var.
   *  Empty for Anthropic (SDK appends /v1/messages itself); "/v1" for OpenAI. */
  baseUrlPath: string;
  detect(): Promise<DetectResult>;
  extractCredentials?: () => Promise<Credential[]>;
};
