import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AuditEntry } from "@stackdeck/shared";
import { config } from "./config.js";
import { eventBus } from "./event-bus.js";

interface AuthStore {
  passwordHash?: string;
  createdAt?: string;
}

const authFile = path.join(config.dataDir, "auth.json");
const auditFile = path.join(config.dataDir, "audit.jsonl");

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
  fs.appendFileSync(auditFile, `${JSON.stringify(full)}\n`, { mode: 0o600 });
  trimAudit();
  eventBus.publish("audit.created", full);
  return full;
}

function readAllAudit(): AuditEntry[] {
  try {
    return fs
      .readFileSync(auditFile, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as AuditEntry)
      .reverse();
  } catch {
    return [];
  }
}

function trimAudit(): void {
  const all = readAllAudit();
  if (all.length <= config.auditMaxEntries) return;
  const kept = all.slice(0, config.auditMaxEntries).reverse();
  fs.writeFileSync(auditFile, `${kept.map((e) => JSON.stringify(e)).join("\n")}\n`, {
    mode: 0o600,
  });
}

export function readAudit(limit = 50, offset = 0): { entries: AuditEntry[]; total: number } {
  const all = readAllAudit();
  return {
    entries: all.slice(offset, offset + limit),
    total: all.length,
  };
}
