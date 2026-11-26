import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { API, type HostsResponse } from "@dockermanager/shared";
import { apiFetch, getCurrentHost, setCurrentHost } from "../api";

interface Props {
  onHostChanged: () => void;
}

export function HostSwitcher({ onHostChanged }: Props) {
  const queryClient = useQueryClient();
  const [host, setHost] = useState(getCurrentHost());
  const hosts = useQuery({
    queryKey: ["hosts"],
    queryFn: () => apiFetch<HostsResponse>(API.hosts),
    refetchInterval: 15000,
  });

  // 首轮加载后，若当前选择的主机已不存在则回退到本地
  useEffect(() => {
    if (!hosts.data) return;
    const exists = hosts.data.hosts.some((item) => item.id === host);
    if (!exists) {
      setHost("local");
      setCurrentHost("local");
      onHostChanged();
    }
  }, [hosts.data, host, onHostChanged]);

  function change(value: string) {
    setHost(value);
    setCurrentHost(value);
    // 主机数据完全不同，清空所有缓存后重新拉取
    queryClient.clear();
    onHostChanged();
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
