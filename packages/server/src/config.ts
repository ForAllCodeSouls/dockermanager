import path from "node:path";
import fs from "node:fs";

function resolveDir(value: string | undefined, fallback: string): string {
  return path.resolve(process.cwd(), value ?? fallback);
}

const dataDir = resolveDir(process.env.DATA_DIR, "data");
const stacksDir = resolveDir(process.env.STACKS_DIR, "stacks");

fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(stacksDir, { recursive: true });

function loadSecret(): string {
  const secretFile = path.join(dataDir, "session-secret");
  try {
    const existing = fs.readFileSync(secretFile, "utf8").trim();
    if (existing) return existing;
  } catch {
    // first run
  }
  const generated = crypto.randomUUID() + crypto.randomUUID();
  fs.writeFileSync(secretFile, generated, { mode: 0o600 });
  return generated;
}

export const config = {
  port: Number(process.env.PORT ?? 5001),
  host: process.env.HOST ?? "0.0.0.0",
  dataDir,
  stacksDir,
  secret: process.env.SESSION_SECRET ?? loadSecret(),
  setupToken: process.env.SETUP_TOKEN || null,
  composeFileNames: [
    "compose.yaml",
    "compose.yml",
    "docker-compose.yaml",
    "docker-compose.yml",
  ],
  eventBufferSize: 500,
  auditMaxEntries: 5000,
  terminalReplayLines: 200,
  sessionMaxAgeSeconds: 60 * 60 * 24 * 30,
  cookieName: "dockermanager_session",
  autoUpdate: process.env.AUTO_UPDATE !== "false",
  autoUpdateApply: process.env.AUTO_UPDATE_APPLY !== "false",
  autoUpdateIntervalSeconds: Math.max(
    60,
    Number(process.env.UPDATE_INTERVAL_SECONDS ?? 600),
  ),
  imageName: process.env.IMAGE_NAME ?? "",

  // 容器性能监控（CPU/内存/网络/磁盘 IO 采样）。默认关闭：采样尚未完善，
  // 需要时设置 STATS_ENABLED=true 显式开启。
  statsEnabled: process.env.STATS_ENABLED === "true",

  // 多主机：agent 模式开关与共享密钥。
  // 主实例通过 AGENTS（JSON 数组）配置远程 agent：[{id,name,url,token}]
  mode: (process.env.MODE ?? "server") as "server" | "agent",
  agentToken: process.env.AGENT_TOKEN ?? "",
  agents: (() => {
    try {
      const raw = process.env.AGENTS;
      if (!raw) return [] as { id: string; name: string; url: string; token: string }[];
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return [] as { id: string; name: string; url: string; token: string }[];
      return parsed
        .filter(
          (item): item is { id: string; name: string; url: string; token: string } =>
            typeof item === "object" &&
            item !== null &&
            typeof (item as { id?: unknown }).id === "string" &&
            typeof (item as { url?: unknown }).url === "string",
        )
        .map((item) => ({
          id: item.id,
          name: item.name || item.id,
          url: item.url.replace(/\/$/, ""),
          token: item.token || "",
        }));
    } catch {
      return [] as { id: string; name: string; url: string; token: string }[];
    }
  })(),
} as const;

export type Config = typeof config;
