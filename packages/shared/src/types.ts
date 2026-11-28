export type StackStatus = "unknown" | "created" | "running" | "exited" | "partial" | "error";

export interface ContainerInfo {
  id: string;
  /** 容器名（container_name 或 Docker 自动生成的名字），仅用于显示 */
  name: string;
  /** compose 服务名（com.docker.compose.service），用于日志/终端/单服务操作 */
  service: string;
  image: string;
  state: string;
  status: string;
  ports: string;
}

/** 单个容器的实时资源占用快照 */
export interface ContainerStats {
  id: string;
  name: string;
  cpuPercent: number;
  memoryPercent: number;
  memoryUsageMb: number;
  memoryLimitMb: number;
  netRxMb: number;
  netTxMb: number;
  blockReadMb: number;
  blockWriteMb: number;
  error: string | null;
}

export interface StatsResponse {
  generatedAt: string;
  containers: ContainerStats[];
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
  | "update.failed"
  | "image.changed";

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

export type ServiceAction = "start" | "stop" | "restart" | "pull";

export interface ValidateResponse {
  ok: boolean;
  message: string;
}

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

export interface HelperDiagnostic {
  name: string;
  state: string;
  status: string;
  exitCode: number | null;
  logs: string[];
}

export interface DiagnosticsBundle {
  generatedAt: string;
  version: SystemVersion;
  update: UpdateStatus;
  health: HealthResponse;
  snapshot: Snapshot;
  audit: AuditPage;
  logs: string[];
  helpers: HelperDiagnostic[];
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
  /** true 表示覆盖上一行，用于 docker 进度条的回车刷新 */
  replace?: boolean;
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

/** 多主机：一个可管理的 Docker 主机 */
export interface AgentHost {
  id: string;
  name: string;
  local: boolean;
  online: boolean;
}

export interface HostsResponse {
  hosts: AgentHost[];
}

/** 镜像的使用状态：使用中 / 被项目声明但未运行 / 未使用 / 悬空 */
export type ImageUsage = "used" | "declared" | "unused" | "dangling";

/** 镜像的引用来源：容器（含已停止）或项目 compose 声明 */
export interface ImageReference {
  kind: "container" | "compose";
  name: string;
  state?: string;
  project?: string;
}

export interface ImageInfo {
  /** 短 ID，用于展示 */
  id: string;
  /** 完整 ID（sha256:...），用于删除 */
  fullId: string;
  /** 仓库标签，过滤掉 <none> */
  tags: string[];
  /** 字节数 */
  size: number;
  sizeLabel: string;
  createdAt: string;
  usage: ImageUsage;
  /** 是否可安全清理：悬空或未使用 */
  cleanable: boolean;
  references: ImageReference[];
}

export interface ImagesResponse {
  generatedAt: string;
  images: ImageInfo[];
  summary: {
    total: number;
    used: number;
    declared: number;
    unused: number;
    dangling: number;
    reclaimableBytes: number;
  };
}

export interface ImageRemoveRequest {
  ids: string[];
}

export interface ImageRemoveResult {
  id: string;
  ok: boolean;
  message: string;
}

export type ImagePruneScope = "dangling" | "unused" | "all";

export interface ImagePruneRequest {
  scope: ImagePruneScope;
}

export interface ImagePruneResult {
  removed: string[];
  failed: ImageRemoveResult[];
  reclaimedBytes: number;
}

