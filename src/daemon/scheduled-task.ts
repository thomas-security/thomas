import type { ServiceStatus, ThomasService } from "./service.js";

export class ScheduledTaskService implements ThomasService {
  readonly platformLabel = "Scheduled Task";

  constructor(public readonly label: string) {}

  install(): Promise<void> {
    throw new Error(
      "Windows daemon supervision is not implemented in v0.1.0. Run `thomas proxy ensure` after each login, or use Task Scheduler manually.",
    );
  }

  uninstall(): Promise<void> {
    return Promise.resolve();
  }

  status(): Promise<ServiceStatus> {
    return Promise.resolve({ installed: false, running: false, detail: "not implemented" });
  }

  start(): Promise<void> {
    return Promise.resolve();
  }

  stop(): Promise<void> {
    return Promise.resolve();
  }
}
