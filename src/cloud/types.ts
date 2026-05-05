// Wire shapes that thomas-cloud's HTTP API speaks. Mirrors the Pydantic
// models in apps/api/app/api/{devices,sync}.py. Kept in one file so changes
// to the cloud contract surface as one diff here.

export type DeviceBeginRequest = {
  label: string;
  platform?: string;
  thomas_version?: string;
};

export type DeviceBeginResponse = {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  interval: number;
  expires_in: number;
};

export type DevicePollResponse = {
  device_token: string;
  workspace_id: string;
  device_id: string;
};

// Saved at ~/.thomas/cloud.json after a successful login. 0600 mode.
export type CloudIdentity = {
  baseUrl: string;
  deviceToken: string;
  deviceId: string;
  workspaceId: string;
  loggedInAt: string;
  // Optional, set after first /v1/sync.
  lastSyncAt?: string;
};

// Saved at ~/.thomas/cloud-cache.json after each successful /v1/sync.
export type CloudSnapshot = {
  schemaVersion: 1;
  policies: unknown[];
  bundles: unknown[];
  bindings: unknown[];
  providers: unknown[];
  redactRulesVersion: string | null;
  // Local timestamp of when this snapshot was pulled. Used to flag staleness.
  syncedAt: string;
};
