import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AuditEntry } from "@dockermanager/shared";
import { config } from "./config.js";
import { eventBus } from "./event-bus.js";
import { appendLog, listLogFiles } from "./log-store.js";

interface AuthStore {
  passwordHash?: string;
  createdAt?: string;
}

const authFile = path.join(config.dataDir, "auth.json");
const legacyAuditFile = path.join(config.dataDir, "audit.jsonl");
const auditDir = path.join(config.dataDir, "logs", "audit");

function readAuth(): AuthStore {
  try {
    return JSON.parse(fs.readFileSync(authFile, "utf8")) as AuthStore;
  } catch {
    return {};
  }
}

function writeAuth(value: AuthStore): void {
  const temp = `${authFile}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(temp, authFile);
}

/** 旧版把全部审计写在一个 audit.jsonl；升级后挪进分片目录，保留历史且纳入保留策略。 */
function migrateLegacyAudit(): void {
  try {
    if (!fs.existsSync(legacyAuditFile)) return;
    fs.mkdirSync(auditDir, { recursive: true });
    const target = path.join(auditDir, "legacy.jsonl");
    if (fs.existsSync(target)) return;
    fs.renameSync(legacyAuditFile, target);
    const now = new Date();
    fs.utimesSync(target, now, now);
  } catch {
    // 迁移失败不影响新日志写入
  }
}
migrateLegacyAudit();

export function needsSetup(): boolean {
  return !readAuth().passwordHash;
}

export function setPassword(hash: string): void {
  writeAuth({ ...readAuth(), passwordHash: hash, createdAt: new Date().toISOString() });
}

export function getPasswordHash(): string | null {
  return readAuth().passwordHash ?? null;
}

export function appendAudit(entry: Omit<AuditEntry, "id" | "at">): AuditEntry {
  const full: AuditEntry = {
    id: randomUUID(),
    at: new Date().toISOString(),
    ...entry,
  };
  appendLog("audit", "", JSON.stringify(full));
  eventBus.publish("audit.created", full);
  return full;
}

function readAllAudit(): AuditEntry[] {
  const entries = new Map<string, AuditEntry>();
  for (const file of listLogFiles("audit")) {
    try {
      const raw = fs.readFileSync(path.join(config.dataDir, "logs", file.relativePath), "utf8");
      for (const line of raw.split("\n")) {
        if (!line) continue;
        const item = JSON.parse(line) as AuditEntry;
        if (item?.id) entries.set(item.id, item);
      }
    } catch {
      // 单条损坏不影响其他记录
    }
  }
  return [...entries.values()].sort((a, b) => b.at.localeCompare(a.at));
}

export function readAudit(limit = 50, offset = 0): { entries: AuditEntry[]; total: number } {
  const all = readAllAudit();
  return {
    entries: all.slice(offset, offset + limit),
    total: all.length,
  };
}
