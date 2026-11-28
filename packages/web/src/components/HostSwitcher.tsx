import { useEffect } from "react";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { API, type HostsResponse } from "@dockermanager/shared";
import { apiFetchLocal } from "../api";

interface Props {
  host: string;
  onHostChange: (host: string) => void;
}

/** 只重置随主机变化的数据；health/hosts 属于主实例，清掉会导致闪回启动页。 */
function resetHostScopedQueries(queryClient: QueryClient): void {
  queryClient.resetQueries({
    predicate: (query) => {
      const key = query.queryKey[0];
      return key !== "health" && key !== "hosts";
    },
  });
}

export function HostSwitcher({ host, onHostChange }: Props) {
  const queryClient = useQueryClient();
  const hosts = useQuery({
    queryKey: ["hosts"],
    queryFn: () => apiFetchLocal<HostsResponse>(API.hosts),
    refetchInterval: 15000,
  });

  // 首轮加载后，若当前选择的主机已不存在则回退到本地
  useEffect(() => {
    if (!hosts.data) return;
    const exists = hosts.data.hosts.some((item) => item.id === host);
    if (!exists && host !== "local") {
      onHostChange("local");
      resetHostScopedQueries(queryClient);
    }
  }, [hosts.data, host, onHostChange, queryClient]);

  function change(value: string) {
    onHostChange(value);
    resetHostScopedQueries(queryClient);
  }

  return (
    <label className="host-switcher" title="切换管理的 Docker 主机">
      <span className="muted small">主机</span>
      <select value={host} onChange={(e) => change(e.target.value)}>
        {(hosts.data?.hosts ?? [{ id: "local", name: "本机", local: true, online: true }]).map(
          (item) => (
            <option key={item.id} value={item.id}>
              {item.name}{item.online ? "" : "（离线）"}
            </option>
          ),
        )}
      </select>
    </label>
  );
}
