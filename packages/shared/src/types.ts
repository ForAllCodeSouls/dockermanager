export type StackStatus = "unknown" | "created" | "running" | "exited" | "partial" | "error";

export interface ContainerInfo {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
  ports: string;
}

export interface StackInfo {
  name: string;
  status: StackStatus;
  services: ContainerInfo[];
  composeModifiedAt: string;
  envModifiedAt: string | null;
  error: string | null;
}

export interface EngineInfo {
  reachable: boolean;
  version: string | null;
  message: string | null;
}

export interface Snapshot {
  seq: number;
  generatedAt: string;
  stacks: StackInfo[];
  engine: EngineInfo;
}

export type ServerEventType =
  | "stack.upserted"
  | "stack.deleted"
  | "stack.status"
  | "audit.created"
  | "system.health"
  | "update.available"
  | "update.applied"
  | "update.failed";

export interface ServerEvent<T = unknown> {
  seq: number;
  type: ServerEventType;
  at: string;
  payload: T;
}

export interface AuditEntry {
  id: string;
  at: string;
  actor: string;
  action: string;
  target: string;
  detail: string;
  ok: boolean;
}

export interface ApiError {
  error: string;
}

export interface LoginRequest {
  password: string;
}

export interface SetupRequest {
  password: string;
}

export interface ComposePayload {
  compose: string;
  env?: string;
}

export type StackAction = "start" | "stop" | "restart" | "update" | "down" | "pull";

export interface BatchRequest {
  names: string[];
  action: StackAction;
}

export interface ActionResult {
  name: string;
  ok: boolean;
  message: string;
}

export interface HealthResponse {
  ok: boolean;
  authenticated: boolean;
  needsSetup: boolean;
  seq: number;
  serverTime: string;
}

export interface AuditPage {
  entries: AuditEntry[];
  total: number;
}

export interface SystemVersion {
  version: string;
  commit: string;
  buildTime: string;
  image: string;
  imageId: string | null;
  startedAt: string;
  node: string;
}

export interface UpdateStatus {
  enabled: boolean;
  autoApply: boolean;
  intervalSeconds: number;
  checking: boolean;
  lastCheckAt: string | null;
  lastError: string | null;
  updateAvailable: boolean;
  appliedAt: string | null;
  currentImageId: string | null;
  latestImageId: string | null;
}

export interface DiagnosticsBundle {
  generatedAt: string;
  version: SystemVersion;
  update: UpdateStatus;
  health: HealthResponse;
  snapshot: Snapshot;
  audit: AuditPage;
  logs: string[];
  note: string;
}

export interface DebugTokenResponse {
  url: string;
  expiresAt: string;
}

/** 实时任务（compose pull/up/down 等）的一条流式输出 */
export interface TaskLine {
  stream: "stdout" | "stderr";
  text: string;
}

export interface TaskStarted {
  id: string;
  stack: string;
  action: string;
}

export interface TaskFinished {
  ok: boolean;
  exitCode: number | null;
}

export interface ConvertRunRequest {
  command: string;
}

export interface ConvertRunResponse {
  compose: string;
  warnings: string[];
}

