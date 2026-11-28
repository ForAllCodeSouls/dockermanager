import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

type LogStore = typeof import("../packages/server/src/log-store");
type SharedApi = typeof import("../packages/shared/src/api");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "dm-logstore-"));
let store: LogStore;
let api: SharedApi;

beforeAll(async () => {
  process.env.DATA_DIR = tempDir;
  store = await import("../packages/server/src/log-store");
  api = await import("../packages/shared/src/api");
});

afterAll(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("log store", () => {
  it("turns startup time into a safe file name", () => {
    const stamp = store.stampForDate("2026-11-28T01:04:57.123Z");
    expect(stamp).toMatch(/^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}_\d{3}$/);
    expect(store.stampForDate("not-a-date")).toBe(store.sessionStamp);
  });

  it("keeps each startup in its own file", () => {
    store.appendLog("container", "demo/app", "first line", "2026-11-28_09-00-00_000");
    store.appendLog("container", "demo/app", "second line", "2026-11-28_09-00-00_000");
    store.appendLog("container", "demo/app", "next boot", "2026-11-28_10-00-00_000");

    const files = store.listLogFiles("container", "demo/app");
    expect(files).toHaveLength(2);
    expect(files[0].name).toContain("10-00-00");
    const first = files.find((file) => file.name.includes("09-00-00"));
    expect(first).toBeDefined();
    const content = store.readLogFile(first!.relativePath);
    expect(content?.lines).toEqual(["first line", "second line"]);
    expect(content?.totalLines).toBe(2);
  });

  it("returns the complete log file for download", () => {
    for (let i = 1; i <= 50; i += 1) {
      store.appendLog("container", "demo/bulk", `line ${i}`, "2026-11-28_11-00-00_000");
    }
    const file = store.listLogFiles("container", "demo/bulk")[0];
    expect(file).toBeDefined();
    expect(store.readLogFile(file!.relativePath, 5)?.lines).toHaveLength(5);
    const raw = store.readLogFileRaw(file!.relativePath);
    expect(raw?.name).toContain("11-00-00");
    expect(raw?.content.trimEnd().split("\n")).toHaveLength(50);
    expect(store.readLogFileRaw("../../etc/passwd")).toBeNull();
  });

  it("separates audit and server logs from container logs", () => {
    store.appendLog("audit", "", '{"id":"a1"}', "2026-11-28_09-00-00_000");
    store.appendLog("server", "", "started", "2026-11-28_09-00-00_000");
    expect(store.listLogFiles("audit")).toHaveLength(1);
    expect(store.listLogFiles("server")).toHaveLength(1);
    expect(store.listLogFiles("container", "other/app")).toHaveLength(0);
  });

  it("rejects paths outside the log root", () => {
    expect(store.readLogFile("../../etc/passwd")).toBeNull();
    expect(store.deleteLogFile("../../etc/passwd")).toBe(false);
  });

  it("keeps task output in its own clearly separated category", () => {
    store.appendLog("task", "demo/start", "任务开始", "2026-11-28_09-00-00_000");
    store.appendLog("task", "demo/start", "Pulling image", "2026-11-28_09-00-00_000");
    const tasks = store.listLogFiles("task", "demo/start");
    expect(tasks).toHaveLength(1);
    expect(tasks[0].scope).toBe("demo/start");
    expect(store.readLogFile(tasks[0].relativePath)?.lines).toEqual(["任务开始", "Pulling image"]);
    // 任务日志不会混进容器日志（另外两个是 demo/app 的两次启动和 demo/bulk）
    expect(store.listLogFiles("container")).toHaveLength(3);
  });

  it("persists retention settings and clamps invalid values", () => {
    const saved = store.updateLogSettings({ container: 3, task: 5, audit: 0, server: -1 });
    expect(saved.retention).toEqual({ container: 3, task: 5, audit: 0, server: 7 });
    expect(store.getLogSettings().retention.container).toBe(3);
    expect(store.getLogSettings().retention.task).toBe(5);
  });

  it("exposes log endpoints", () => {
    expect(api.API.logFiles).toBe("/api/logs/files");
    expect(api.API.logFile).toBe("/api/logs/file");
    expect(api.API.logFileRaw).toBe("/api/logs/file/raw");
    expect(api.API.logSettings).toBe("/api/logs/settings");
    expect(api.API.logCleanup).toBe("/api/logs/cleanup");
  });
});
