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
} as const;

export type Config = typeof config;
