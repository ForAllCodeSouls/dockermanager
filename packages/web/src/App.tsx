import { useQuery } from "@tanstack/react-query";
import { API, type HealthResponse } from "@dockermanager/shared";
import { apiFetchLocal } from "./api";
import { useLiveConnection } from "./live";
import { AuthScreen } from "./components/AuthScreen";
import { Dashboard } from "./components/Dashboard";

export default function App() {
  const health = useQuery({
    queryKey: ["health"],
    queryFn: () => apiFetchLocal<HealthResponse>(API.health),
    retry: 1,
  });
  const authenticated = health.data?.authenticated ?? false;
  const live = useLiveConnection(authenticated);

  if (health.isLoading) return <div className="splash">正在连接 DockerManager…</div>;
  if (health.error) {
    return <div className="splash error">无法连接服务端：{String(health.error)}</div>;
  }
  if (health.data?.needsSetup) return <AuthScreen mode="setup" />;
  if (!authenticated) return <AuthScreen mode="login" />;
  return <Dashboard live={live} health={health.data} />;
}
