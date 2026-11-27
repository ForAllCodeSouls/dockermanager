import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  API,
  type AuditPage,
  type DebugTokenResponse,
  type HealthResponse,
  type Snapshot,
  type SystemVersion,
  type UpdateStatus,
} from "@dockermanager/shared";
import { apiFetch, post } from "../api";
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
  onNotice: (message: string) => void;
}

export function DiagnosticsPanel({ live, snapshot, health, onNotice }: DiagnosticsProps) {
  const queryClient = useQueryClient();
  const version = useQuery({
    queryKey: ["version"],
    queryFn: () => apiFetch<SystemVersion>(API.systemVersion),
  });
  const update = useQuery({
    queryKey: ["update"],
    queryFn: () => apiFetch<UpdateStatus>(API.systemUpdate),
  });
  const [debugUrl, setDebugUrl] = useState("");

  const check = useMutation({
    mutationFn: () => post<UpdateStatus>(API.updateCheck),
    onSuccess: (data) => {
      void queryClient.invalidateQueries({ queryKey: ["update"] });
      onNotice(data.updateAvailable ? "发现新版本" : "已是最新版本");
    },
    onError: (error) => onNotice(error instanceof Error ? error.message : "检查失败"),
  });
  const apply = useMutation({
    mutationFn: () => post<{ ok: boolean; message: string }>(API.updateApply),
    onSuccess: (data) => onNotice(data.message),
    onError: (error) => onNotice(error instanceof Error ? error.message : "更新失败"),
  });
  const debug = useMutation({
    mutationFn: () => post<DebugTokenResponse>(API.debugToken, { minutes: 60 }),
    onSuccess: (data) => {
      setDebugUrl(data.url);
      onNotice("调试链接已生成，有效期 1 小时，仅含只读权限");
    },
    onError: (error) => onNotice(error instanceof Error ? error.message : "生成失败"),
  });

  const rows: [string, string][] = [
    ["连接状态", live.status],
    ["事件累计", String(live.eventCount)],
    ["重连次数", String(live.reconnectCount)],
    ["最近事件", live.lastEventAt ? new Date(live.lastEventAt).toLocaleTimeString("zh-CN") : "—"],
    ["快照序号", String(snapshot?.seq ?? 0)],
    ["服务端序号", String(health?.seq ?? 0)],
    ["最近同步", snapshot ? new Date(snapshot.generatedAt).toLocaleTimeString("zh-CN") : "—"],
    ["Docker 引擎", snapshot?.engine.version ?? (snapshot?.engine.reachable ? "未知" : "不可达")],
    ["应用版本", version.data?.version ?? "—"],
    ["构建提交", version.data?.commit ?? "—"],
    ["构建时间", version.data?.buildTime ?? "—"],
    ["运行镜像", version.data?.image || "—"],
    ["镜像 ID", version.data?.imageId ?? "—"],
    ["启动时间", version.data ? new Date(version.data.startedAt).toLocaleString("zh-CN") : "—"],
    ["自动更新", update.data ? `${update.data.enabled ? "开启" : "关闭"} / ${update.data.intervalSeconds}s` : "—"],
    ["更新可用", update.data?.updateAvailable ? "是" : "否"],
    ["上次检查更新", update.data?.lastCheckAt ? new Date(update.data.lastCheckAt).toLocaleString("zh-CN") : "—"],
    ["最近更新错误", update.data?.lastError || "无错误"],
    ["最近连接错误", live.lastError || "无错误"],
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
      <div className="panel-actions">
        <button className="ghost" disabled={check.isPending} onClick={() => check.mutate()}>
          检查更新
        </button>
        <button
          className="ghost"
          disabled={apply.isPending}
          onClick={() => {
            if (window.confirm("确认立即更新？容器会重启自身，页面将自动恢复连接。")) {
              apply.mutate();
            }
          }}
        >
          立即更新
        </button>
        <button className="ghost" disabled={debug.isPending} onClick={() => debug.mutate()}>
          生成调试链接
        </button>
      </div>
      {debugUrl && (
        <div className="debug-link">
          <input readOnly value={debugUrl} onFocus={(e) => e.currentTarget.select()} />
          <button
            className="ghost"
            onClick={() => {
              void navigator.clipboard?.writeText(debugUrl).catch(() => undefined);
            }}
          >
            复制
          </button>
          <a href={debugUrl} target="_blank" rel="noreferrer">打开诊断包</a>
        </div>
      )}
      <p className="hint">调试链接为 HMAC 签名的短期只读凭证，不包含密码或会话 Token。</p>
    </div>
  );
}
