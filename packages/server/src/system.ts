import fs from "node:fs";
import path from "node:path";
import Docker from "dockerode";
import type {
  BackupData,
  BackupRestoreRequest,
  BackupRestoreResult,
  PruneRequest,
  PruneResult,
} from "@dockermanager/shared";
import { config } from "./config.js";
import { eventBus } from "./event-bus.js";
import { stacks } from "./stacks.js";

const docker = new Docker();

export async function systemPrune(body: PruneRequest): Promise<PruneResult[]> {
  const scope = body.scope;
  const results: PruneResult[] = [];
  if (scope === "containers" || scope === "all") {
    const result = await docker.pruneContainers({ filters: { until: [] } });
    results.push({
      scope: "containers",
      reclaimedBytes: result.SpaceReclaimed ?? 0,
      deleted: result.ContainersDeleted ?? [],
      message: `已清理 ${(result.ContainersDeleted ?? []).length} 个停止的容器`,
    });
  }
  if (scope === "networks" || scope === "all") {
    const result = await docker.pruneNetworks();
    results.push({
      scope: "networks",
      reclaimedBytes: 0,
      deleted: result.NetworksDeleted ?? [],
      message: `已清理 ${(result.NetworksDeleted ?? []).length} 个未使用的网络`,
    });
  }
  if (scope === "buildCache" || scope === "all") {
    const pruneCache = (
      docker as unknown as {
        pruneBuildCache: (options: { force: boolean }) => Promise<{ SpaceReclaimed?: number }>;
      }
    ).pruneBuildCache;
    const result = await pruneCache.call(docker, { force: true });
    results.push({
      scope: "buildCache",
      reclaimedBytes: result.SpaceReclaimed ?? 0,
      deleted: [],
      message: "已清理构建缓存",
    });
  }
  if (scope === "volumes" || scope === "all") {
    const result = await docker.pruneVolumes();
    results.push({
      scope: "volumes",
      reclaimedBytes: result.SpaceReclaimed ?? 0,
      deleted: result.VolumesDeleted ?? [],
      message: `已清理 ${(result.VolumesDeleted ?? []).length} 个未使用的卷`,
    });
  }
  return results;
}

/** 导出所有项目的 compose 与 env，以及卷的名称、驱动和标签（不含卷内数据） */
export async function exportBackup(): Promise<BackupData> {
  const backupStacks = [];
  for (const entry of fs.readdirSync(config.stacksDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(config.stacksDir, entry.name);
    let compose = "";
    for (const name of config.composeFileNames) {
      const file = path.join(dir, name);
      if (fs.existsSync(file)) {
        compose = fs.readFileSync(file, "utf8");
        break;
      }
    }
    if (!compose) continue;
    const envFile = path.join(dir, ".env");
    const env = fs.existsSync(envFile) ? fs.readFileSync(envFile, "utf8") : "";
    backupStacks.push({ name: entry.name, compose, env });
  }
  const listed = await docker.listVolumes().catch(() => ({ Volumes: [] }));
  return {
    format: "dockermanager-backup",
    version: 1,
    createdAt: new Date().toISOString(),
    stacks: backupStacks,
    volumes: (listed.Volumes ?? []).map((volume) => ({
      name: volume.Name,
      driver: volume.Driver ?? "local",
      labels: volume.Labels ?? {},
    })),
    note: "包含所有项目的 compose 与 .env，以及卷的名称/驱动/标签；卷内实际数据不包含，请另行备份。",
  };
}

export async function restoreBackup(body: BackupRestoreRequest): Promise<BackupRestoreResult> {
  const data = body.data;
  if (data?.format !== "dockermanager-backup" || !Array.isArray(data.stacks)) {
    throw new Error("备份文件格式不正确");
  }
  const restored: string[] = [];
  const skipped: string[] = [];
  const current = await stacks.snapshot();
  const existing = new Set(current.stacks.map((item) => item.name));
  for (const item of data.stacks) {
    if (!item?.name || typeof item.compose !== "string") continue;
    if (existing.has(item.name) && !body.overwrite) {
      skipped.push(item.name);
      continue;
    }
    stacks.write(item.name, { compose: item.compose, env: item.env ?? "" });
    restored.push(item.name);
  }
  let volumesCreated = 0;
  for (const volume of data.volumes ?? []) {
    if (!volume?.name) continue;
    try {
      await docker.createVolume({ Name: volume.name, Driver: volume.driver || "local", Labels: volume.labels ?? {} });
      volumesCreated += 1;
    } catch {
      // 已存在则跳过
    }
  }
  eventBus.publish("backup.restored", { restored, volumesCreated });
  return {
    restored,
    skipped,
    volumesCreated,
    message: `恢复 ${restored.length} 个项目${skipped.length ? `，跳过 ${skipped.length} 个同名项目` : ""}`,
  };
}
