import { useQuery } from "@tanstack/react-query";
import { API, type StatsResponse } from "@dockermanager/shared";
import { apiFetch } from "../api";

interface Props {
  stackName: string;
  serviceNames: string[];
}

/** 项目卡片上的轻量资源占用条：CPU% 与内存% */
export function StatsStrip({ stackName, serviceNames }: Props) {
  const stats = useQuery({
    queryKey: ["stats"],
    queryFn: () => apiFetch<StatsResponse>(API.stats),
    refetchInterval: 3500,
  });

  const relevant = (stats.data?.containers ?? []).filter((item) =>
    serviceNames.some((service) => item.name.includes(service) || service.includes(item.name)),
  );
  if (relevant.length === 0) return null;

  const cpu = relevant.reduce((sum, item) => sum + item.cpuPercent, 0);
  const mem = relevant.reduce((sum, item) => sum + item.memoryPercent, 0) / relevant.length;
  const memMb = relevant.reduce((sum, item) => sum + item.memoryUsageMb, 0);

  return (
    <div className="stats-strip" title={`${stackName} 资源占用（每 3.5 秒刷新）`}>
      <span className="stat-chip">CPU {cpu.toFixed(1)}%</span>
      <span className="stat-chip">内存 {mem.toFixed(1)}% · {memMb.toFixed(0)}MB</span>
    </div>
  );
}
