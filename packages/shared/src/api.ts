export const API = {
  health: "/api/health",
  setup: "/api/auth/setup",
  login: "/api/auth/login",
  logout: "/api/auth/logout",
  snapshot: "/api/stacks",
  stack: (name: string) => `/api/stacks/${encodeURIComponent(name)}`,
  stackAction: (name: string, action: string) =>
    `/api/stacks/${encodeURIComponent(name)}/${action}`,
  stackValidate: (name: string) =>
    `/api/stacks/${encodeURIComponent(name)}/validate`,
  stackServiceAction: (name: string, service: string, action: string) =>
    `/api/stacks/${encodeURIComponent(name)}/services/${encodeURIComponent(service)}/${action}`,
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
  systemUpdateHelper: "/api/system/update-helper",
  updateCheck: "/api/system/update/check",
  updateApply: "/api/system/update/apply",
  debugToken: "/api/system/debug-token",
  taskStream: (id: string) => `/api/tasks/${encodeURIComponent(id)}/stream`,
  convertRun: "/api/tools/convert-run",
  stats: "/api/stats",
  hosts: "/api/hosts",
  images: "/api/images",
  imageRemove: "/api/images/remove",
  imagePrune: "/api/images/prune",
  logFiles: "/api/logs/files",
  logFile: "/api/logs/file",
  logFileRaw: "/api/logs/file/raw",
  logSettings: "/api/logs/settings",
  logCleanup: "/api/logs/cleanup",
  containerInspect: (id: string) => `/api/containers/${encodeURIComponent(id)}/inspect`,
  containerFiles: (id: string, filePath: string) =>
    `/api/containers/${encodeURIComponent(id)}/files?path=${encodeURIComponent(filePath)}`,
  containerFile: (id: string, filePath: string) =>
    `/api/containers/${encodeURIComponent(id)}/file?path=${encodeURIComponent(filePath)}`,
  volumes: "/api/volumes",
  volume: (name: string) => `/api/volumes/${encodeURIComponent(name)}`,
  volumePrune: "/api/volumes/prune",
  networks: "/api/networks",
  network: (id: string) => `/api/networks/${encodeURIComponent(id)}`,
  networkPrune: "/api/networks/prune",
  networkConnect: "/api/networks/connect",
  networkDisconnect: "/api/networks/disconnect",
  systemPrune: "/api/system/prune",
  backup: "/api/backup",
  backupRestore: "/api/backup/restore",
  proxy: (hostId: string, path: string) => {
    const suffix = path.startsWith("/api/")
      ? path.slice(4)
      : path.startsWith("/")
        ? path
        : `/${path}`;
    return `/api/host/${encodeURIComponent(hostId)}${suffix}`;
  },
} as const;

export const STACK_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/;

export function isValidStackName(name: string): boolean {
  return STACK_NAME_PATTERN.test(name) && name !== "." && name !== "..";
}

export function eventId(seq: number): string {
  return String(seq);
}
