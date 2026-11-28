import fs from "node:fs";
import path from "node:path";
import type {
  LogCategory,
  LogCleanupResult,
  LogFileContent,
  LogFileInfo,
  LogRetention,
  LogSettingsResponse,
} from "@dockermanager/shared";
import { config } from "./config.js";

const CATEGORIES: LogCategory[] = ["container", "task", "audit", "server"];
const DEFAULT_RETENTION: LogRetention = { container: 7, task: 14, audit: 30, server: 7 };

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}

/** 把时间转成可作文件名的形式：2026-11-28_09-04-57_123 */
function stampAt(date: Date): string {
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}` +
    `_${pad(date.getMilliseconds(), 3)}`
  );
}

/** 本次进程启动时间。进程重启后自然换一个新文件，历史不再混在一起。 */
export const sessionStamp = stampAt(new Date());

/** 把 ISO 时间转成文件名片段；无效时间回退到本次进程启动时间 */
export function stampForDate(value: string | Date): string {
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return sessionStamp;
  return stampAt(date);
}

const logsRoot = path.join(config.dataDir, "logs");
const settingsFile = path.join(config.dataDir, "log-settings.json");
fs.mkdirSync(logsRoot, { recursive: true });

function categoryDir(category: LogCategory): string {
  return path.join(logsRoot, category);
}

const SAFE_SCOPE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}(\/[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62})?$/;

function fileFor(category: LogCategory, scope: string, stamp: string): string {
  const extension = category === "audit" ? "jsonl" : "log";
  const name = `${stamp}.${extension}`;
  // 容器与任务日志都按「项目/服务」或「项目/动作」分层，审计与运行日志平铺
  if ((category === "container" || category === "task") && SAFE_SCOPE.test(scope)) {
    return path.join(categoryDir(category), ...scope.split("/"), name);
  }
  return path.join(categoryDir(category), name);
}

/** 打开中的文件句柄。逐行追加而不是整文件重写，断电时最多丢最后一次未刷盘的内容。 */
interface Handle {
  fd: number;
  dirty: boolean;
}
const handles = new Map<string, Handle>();

function handleFor(file: string): Handle {
  let handle = handles.get(file);
  if (!handle) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    handle = { fd: fs.openSync(file, "a", 0o600), dirty: false };
    handles.set(file, handle);
  }
  return handle;
}

/** 追加一条日志；text 可以是一行或多行文本。 */
export function appendLog(
  category: LogCategory,
  scope: string,
  text: string,
  stamp: string = sessionStamp,
): void {
  if (!text) return;
  const handle = handleFor(fileFor(category, scope, stamp));
  const payload = text.endsWith("\n") ? text : `${text}\n`;
  fs.writeSync(handle.fd, payload);
  handle.dirty = true;
}

/** 把缓冲内容刷到磁盘。定时器 + 进程退出双重保证。 */
export function flushLogs(): void {
  for (const handle of handles.values()) {
    if (!handle.dirty) continue;
    try {
      fs.fsyncSync(handle.fd);
      handle.dirty = false;
    } catch {
      // 文件系统不支持 fsync 时保留 dirty，下次再试
    }
  }
}

const flusher = setInterval(flushLogs, 1000);
flusher.unref();
process.on("exit", flushLogs);

function readRetention(): LogRetention {
  const result: LogRetention = { ...DEFAULT_RETENTION };
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsFile, "utf8")) as Partial<LogRetention>;
    for (const category of CATEGORIES) {
      const value = parsed[category];
      if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
        result[category] = Math.min(Math.floor(value), 3650);
      }
    }
  } catch {
    // 首次运行或文件损坏，用默认值
  }
  return result;
}

function writeRetention(retention: LogRetention): void {
  const temp = `${settingsFile}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(retention, null, 2), { mode: 0o600 });
  fs.renameSync(temp, settingsFile);
}

export function getLogSettings(): LogSettingsResponse {
  return { retention: readRetention() };
}

export function updateLogSettings(input: Partial<LogRetention>): LogSettingsResponse {
  const next = readRetention();
  for (const category of CATEGORIES) {
    const value = input?.[category];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      next[category] = Math.min(Math.floor(value), 3650);
    }
  }
  writeRetention(next);
  return { retention: next };
}

export function cleanupLogs(): LogCleanupResult {
  const retention = readRetention();
  const result: LogCleanupResult = { removed: 0, failed: 0 };
  const now = Date.now();

  const tryRemove = (file: string, cutoff: number): void => {
    try {
      if (fs.statSync(file).mtimeMs >= cutoff) return;
      // 正在写入的文件跳过，避免句柄指向已删除 inode
      for (const active of handles.keys()) if (active === file) return;
      fs.unlinkSync(file);
      result.removed += 1;
    } catch {
      result.failed += 1;
    }
  };

  for (const category of CATEGORIES) {
    const days = retention[category];
    if (days <= 0) continue;
    const cutoff = now - days * 86_400_000;
    const root = categoryDir(category);
    if (!fs.existsSync(root)) continue;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      const full = path.join(root, entry.name);
      if (entry.isDirectory()) {
        // 容器与任务日志多一层「项目/服务（动作）」目录
        for (const sub of fs.readdirSync(full, { withFileTypes: true })) {
          if (sub.isFile()) tryRemove(path.join(full, sub.name), cutoff);
        }
      } else if (entry.isFile()) {
        tryRemove(full, cutoff);
      }
    }
  }
  return result;
}

function startCleaner(): void {
  try {
    cleanupLogs();
  } catch {
    // 清理失败不影响启动
  }
  const timer = setInterval(() => {
    try {
      cleanupLogs();
    } catch {
      // 同上
    }
  }, 60 * 60 * 1000);
  timer.unref();
}
startCleaner();

/** 只接受日志根目录内的路径，防止通过 .. 读到任意文件 */
function safeResolve(relativePath: string): string | null {
  if (!relativePath || relativePath.includes("\0")) return null;
  const full = path.resolve(logsRoot, relativePath);
  if (full !== logsRoot && !full.startsWith(logsRoot + path.sep)) return null;
  return full;
}

function startedAtFromName(name: string): string {
  const match = name.match(
    /^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})_(\d{3})\.(?:log|jsonl)$/,
  );
  if (!match) return "";
  return `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}.${match[7]}`;
}

export function listLogFiles(category?: LogCategory, scope?: string): LogFileInfo[] {
  const files: LogFileInfo[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.isFile() || !/\.(log|jsonl)$/.test(entry.name)) continue;
      const parts = path.relative(logsRoot, full).split(path.sep);
      const fileCategory = parts[0] as LogCategory;
      if (!CATEGORIES.includes(fileCategory)) continue;
      const fileScope =
        fileCategory === "container" || fileCategory === "task"
          ? parts.slice(1, -1).join("/")
          : "";
      if (category && fileCategory !== category) continue;
      if (scope && fileScope !== scope) continue;
      let size = 0;
      let modifiedAt = "";
      try {
        const stat = fs.statSync(full);
        size = stat.size;
        modifiedAt = stat.mtime.toISOString();
      } catch {
        continue;
      }
      files.push({
        category: fileCategory,
        scope: fileScope,
        name: entry.name,
        relativePath: path.relative(logsRoot, full).split(path.sep).join("/"),
        startedAt: startedAtFromName(entry.name),
        size,
        modifiedAt,
      });
    }
  };
  walk(logsRoot);
  return files.sort((a, b) => b.name.localeCompare(a.name));
}

export function readLogFile(relativePath: string, limit = 500): LogFileContent | null {
  const full = safeResolve(relativePath);
  if (!full) return null;
  try {
    if (!fs.statSync(full).isFile()) return null;
    const raw = fs.readFileSync(full, "utf8");
    const all = raw.split("\n");
    if (all[all.length - 1] === "") all.pop();
    const parts = path.relative(logsRoot, full).split(path.sep);
    const category = parts[0] as LogCategory;
    return {
      name: parts[parts.length - 1],
      category,
      scope: category === "container" || category === "task" ? parts.slice(1, -1).join("/") : "",
      lines: all.slice(-Math.min(Math.max(limit, 1), 2000)),
      totalLines: all.length,
      truncated: all.length > limit,
    };
  } catch {
    return null;
  }
}

/** 读取完整日志文件用于下载；不做截断，保留原始换行。 */
export function readLogFileRaw(relativePath: string): { name: string; content: string } | null {
  const full = safeResolve(relativePath);
  if (!full) return null;
  try {
    if (!fs.statSync(full).isFile()) return null;
    return { name: path.basename(full), content: fs.readFileSync(full, "utf8") };
  } catch {
    return null;
  }
}

export function deleteLogFile(relativePath: string): boolean {
  const full = safeResolve(relativePath);
  if (!full) return false;
  try {
    if (!fs.statSync(full).isFile()) return false;
  } catch {
    return false;
  }
  for (const active of handles.keys()) if (active === full) return false;
  try {
    fs.unlinkSync(full);
    return true;
  } catch {
    return false;
  }
}
