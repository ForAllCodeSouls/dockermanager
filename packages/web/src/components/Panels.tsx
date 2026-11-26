import { useQuery } from "@tanstack/react-query";
import { API, type AuditPage, type HealthResponse, type Snapshot } from "@stackdeck/shared";
import { apiFetch } from "../api";
import type { LiveState } from "../live";

export function AuditPanel() {
  const audit = useQuery({
    queryKey: ["audit"],
    queryFn: () => apiFetch<AuditPage>(`${API.audit}?limit=100`),
  });
  return (
    <div className="panel-body">
      <h2>操作审计</h2>
      {audit.isLoading && <p className="muted">加载中…</p>}
      {audit.data?.entries.length === 0 && <p className="muted">暂无记录</p>}
      <div className="audit-list">
        {audit.data?.entries.map((entry) => (
          <div className="audit-row" key={entry.id}>
            <span className={entry.ok ? "dot ok" : "dot bad"} />
            <span className="audit-time">{new Date(entry.at).toLocaleString("zh-CN")}</span>
            <span className="audit-action">{entry.action}</span>
            <span className="audit-target">{entry.target}</span>
            <span className="muted">{entry.detail}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

interface DiagnosticsProps {
  live: LiveState;
  snapshot: Snapshot | undefined;
  health: HealthResponse | undefined;
}

export function DiagnosticsPanel({ live, snapshot, health }: DiagnosticsProps) {
  const rows: [string, string][] = [
    ["连接状态", live.status],
    ["事件累计", String(live.eventCount)],
    ["重连次数", String(live.reconnectCount)],
    ["最近事件", live.lastEventAt ? new Date(live.lastEventAt).toLocaleTimeString("zh-CN") : "—"],
    ["快照序号", String(snapshot?.seq ?? 0)],
    ["服务端序号", String(health?.seq ?? 0)],
    ["最近同步", snapshot ? new Date(snapshot.generatedAt).toLocaleTimeString("zh-CN") : "—"],
    ["Docker 引擎", snapshot?.engine.version ?? (snapshot?.engine.reachable ? "未知" : "不可达")],
    ["最后错误", live.lastError ?? "—"],
  ];
  return (
    <div className="panel-body">
      <h2>连接诊断</h2>
      <p className="muted">控制面使用 SSE 自动续传；断线时界面继续读取本地快照。</p>
      <table className="diag-table">
        <tbody>
          {rows.map(([key, value]) => (
            <tr key={key}>
              <th>{key}</th>
              <td>{value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
