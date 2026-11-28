import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import Docker from "dockerode";
import { composeFileFor } from "./docker.js";
import { appendLog, sessionStamp, stampForDate } from "./log-store.js";

const docker = new Docker();

interface Collector {
  child: ChildProcess;
  stamp: string;
}

/** key 为「项目/服务」，值为正在跟随的 docker logs 进程 */
const collectors = new Map<string, Collector>();

interface Discovered {
  key: string;
  project: string;
  service: string;
  id: string;
}

async function discover(): Promise<Discovered[]> {
  const containers = await docker.listContainers({ all: true });
  const found = new Map<string, Discovered>();
  for (const container of containers) {
    const project = container.Labels?.["com.docker.compose.project"];
    const service = container.Labels?.["com.docker.compose.service"];
    if (!project || !service || container.State !== "running") continue;
    const key = `${project}/${service}`;
    if (found.has(key)) continue;
    found.set(key, { key, project, service, id: container.Id });
  }
  return [...found.values()];
}

async function startStampFor(item: Discovered): Promise<string> {
  let stamp = sessionStamp;
  try {
    // 容器 restart 后 ID 不变但 StartedAt 会变，所以每次都读取，确保换新文件
    const detail = await docker.getContainer(item.id).inspect();
    const startedAt = detail.State?.StartedAt;
    if (startedAt && !startedAt.startsWith("0001-")) stamp = stampForDate(startedAt);
  } catch {
    // 容器可能刚好被移除，用进程启动时间兜底
  }
  return stamp;
}

function startCollector(item: Discovered, stamp: string): void {
  const composeFile = composeFileFor(item.project);
  if (!composeFile) return;
  const child = spawn(
    "docker",
    ["compose", "-f", composeFile, "-p", item.project, "logs", "-f", "--tail", "0", item.service],
    { cwd: path.dirname(composeFile), stdio: ["ignore", "pipe", "pipe"] },
  );
  const emit = (data: Buffer) => {
    for (const line of data.toString("utf8").split("\n")) {
      if (line) appendLog("container", item.key, line, stamp);
    }
  };
  child.stdout?.on("data", emit);
  child.stderr?.on("data", emit);
  child.on("close", () => {
    if (collectors.get(item.key)?.child === child) collectors.delete(item.key);
  });
  collectors.set(item.key, { child, stamp });
}

/** 后台跟随所有 compose 容器的日志并落盘。页面是否打开都不影响采集。 */
export async function syncLogCollectors(): Promise<void> {
  let items: Discovered[];
  try {
    items = await discover();
  } catch {
    return;
  }
  const seen = new Set<string>();
  for (const item of items) {
    seen.add(item.key);
    const stamp = await startStampFor(item);
    const active = collectors.get(item.key);
    // 容器重启后 StartedAt 变化：换文件，避免新旧日志混在一起
    if (active && active.stamp !== stamp) {
      active.child.kill();
      collectors.delete(item.key);
    }
    if (!collectors.has(item.key)) startCollector(item, stamp);
  }
  // 容器已删除：停掉对应采集进程
  for (const [key, collector] of collectors) {
    if (!seen.has(key)) {
      collector.child.kill();
      collectors.delete(key);
    }
  }
}

export function startLogCollector(): void {
  void syncLogCollectors();
  const timer = setInterval(() => void syncLogCollectors(), 10_000);
  timer.unref();
}
