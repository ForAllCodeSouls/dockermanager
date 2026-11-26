import Docker from "dockerode";
import type { ContainerStats, StatsResponse } from "@dockermanager/shared";
import { config } from "./config.js";

const docker = new Docker();
const SAMPLE_INTERVAL_MS = 3000;

interface Sample {
  cpuUsage: number;
  systemUsage: number;
  at: number;
}

const previous = new Map<string, Sample>();
let cached: ContainerStats[] = [];
let lastGenerated = "";

function percent(cpuDelta: number, systemDelta: number, cores: number): number {
  if (systemDelta <= 0 || cpuDelta <= 0 || cores <= 0) return 0;
  const value = (cpuDelta / systemDelta) * cores * 100;
  return Math.max(0, Math.min(100, Number(value.toFixed(2))));
}

function mb(bytes: number | undefined): number {
  return Number(((bytes ?? 0) / 1024 / 1024).toFixed(2));
}

async function sampleOnce(): Promise<ContainerStats[]> {
  let containers: Docker.ContainerInfo[];
  try {
    containers = await docker.listContainers({ all: false });
  } catch {
    return [];
  }

  const results = await Promise.all(
    containers.map(async (item): Promise<ContainerStats> => {
      const id = item.Id;
      const name = item.Names[0]?.replace(/^\//, "") ?? id.slice(0, 12);
      const container = docker.getContainer(id);
      try {
        const raw = (await container.stats({ stream: false })) as Docker.ContainerStats;

        const cpuUsage = raw.cpu_stats.cpu_usage.total_usage;
        const systemUsage = raw.cpu_stats.system_cpu_usage ?? 0;
        const cores = raw.cpu_stats.online_cpus ?? raw.cpu_stats.cpu_usage.percpu_usage?.length ?? 1;
        const prev = previous.get(id);
        const cpuPct = prev
          ? percent(cpuUsage - prev.cpuUsage, systemUsage - prev.systemUsage, cores)
          : 0;
        previous.set(id, { cpuUsage, systemUsage, at: Date.now() });

        const memStats = raw.memory_stats;
        const usage = memStats?.usage ?? 0;
        const limit = memStats?.limit && memStats.limit > 0 ? memStats.limit : 0;
        const memPct = limit > 0 ? Math.min(100, Number(((usage / limit) * 100).toFixed(2))) : 0;

        // 网络：eth0 等所有网卡 RX/TX 之和
        let netRx = 0;
        let netTx = 0;
        for (const net of Object.values(raw.networks ?? {})) {
          netRx += net.rx_bytes ?? 0;
          netTx += net.tx_bytes ?? 0;
        }

        // 块设备 IO：统计所有设备的 read/write
        let read = 0;
        let write = 0;
        for (const entry of raw.blkio_stats?.io_service_bytes_recursive ?? []) {
          if (entry.op === "Read") read += entry.value;
          if (entry.op === "Write") write += entry.value;
        }

        return {
          id: id.slice(0, 12),
          name,
          cpuPercent: cpuPct,
          memoryPercent: memPct,
          memoryUsageMb: mb(usage),
          memoryLimitMb: mb(limit),
          netRxMb: mb(netRx),
          netTxMb: mb(netTx),
          blockReadMb: mb(read),
          blockWriteMb: mb(write),
          error: null,
        };
      } catch (error) {
        return {
          id: id.slice(0, 12),
          name,
          cpuPercent: 0,
          memoryPercent: 0,
          memoryUsageMb: 0,
          memoryLimitMb: 0,
          netRxMb: 0,
          netTxMb: 0,
          blockReadMb: 0,
          blockWriteMb: 0,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }),
  );

  // 清理已消失容器的历史样本
  const alive = new Set(results.map((r) => r.id));
  for (const key of previous.keys()) {
    if (![...alive].some((id) => id.startsWith(key.slice(0, 12)))) previous.delete(key);
  }

  return results;
}

export function currentStats(): StatsResponse {
  return { generatedAt: lastGenerated || new Date().toISOString(), containers: cached };
}

export function startStatsSampler(): void {
  const sample = async () => {
    cached = await sampleOnce();
    lastGenerated = new Date().toISOString();
  };
  void sample();
  const timer = setInterval(() => void sample(), SAMPLE_INTERVAL_MS);
  timer.unref();
}
