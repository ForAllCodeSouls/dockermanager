export const API = {
  health: "/api/health",
  setup: "/api/auth/setup",
  login: "/api/auth/login",
  logout: "/api/auth/logout",
  snapshot: "/api/stacks",
  stack: (name: string) => `/api/stacks/${encodeURIComponent(name)}`,
  stackAction: (name: string, action: string) =>
    `/api/stacks/${encodeURIComponent(name)}/${action}`,
  batch: "/api/stacks/batch",
  events: "/api/events",
  audit: "/api/audit",
  terminal: "/api/terminal",
  logs: (name: string, service: string) =>
    `/api/stacks/${encodeURIComponent(name)}/logs?service=${encodeURIComponent(service)}`,
  systemVersion: "/api/system/version",
  systemUpdate: "/api/system/update",
  systemLogs: "/api/system/logs",
  systemDiagnostics: "/api/system/diagnostics",
  updateCheck: "/api/system/update/check",
  updateApply: "/api/system/update/apply",
  debugToken: "/api/system/debug-token",
} as const;

export const STACK_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/;

export function isValidStackName(name: string): boolean {
  return STACK_NAME_PATTERN.test(name) && name !== "." && name !== "..";
}

export function eventId(seq: number): string {
  return String(seq);
}
