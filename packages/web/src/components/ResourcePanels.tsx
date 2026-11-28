import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  API,
  type BackupData,
  type BackupRestoreResult,
  type NetworkConnectRequest,
  type NetworkCreate,
  type NetworkInfo,
  type NetworksResponse,
  type PruneRequest,
  type PruneResult,
  type VolumeCreate,
  type VolumesResponse,
} from "@dockermanager/shared";
import { apiFetch, del, post } from "../api";
import { ConfirmDialog } from "./ConfirmDialog";
import { PanelHeader } from "./Panels";

function formatDate(value: string): string {
  if (!value || value.startsWith("0001-")) return "—";
  return new Date(value).toLocaleString("zh-CN");
}

export function ResourcesPanel({ onClose, onNotice }: { onClose: () => void; onNotice: (message: string) => void }) {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<"volumes" | "networks">("volumes");
  const [manageNetwork, setManageNetwork] = useState<string | null>(null);
  const [volumeName, setVolumeName] = useState("");
  const [networkName, setNetworkName] = useState("");
  const [networkInternal, setNetworkInternal] = useState(false);
  const [pendingVolume, setPendingVolume] = useState<string | null>(null);
  const [pendingNetwork, setPendingNetwork] = useState<NetworkInfo | null>(null);
  const [connectTarget, setConnectTarget] = useState<Record<string, string>>({});

  const volumes = useQuery({
    queryKey: ["volumes"],
    queryFn: () => apiFetch<VolumesResponse>(API.volumes),
    enabled: tab === "volumes",
  });
  const networks = useQuery({
    queryKey: ["networks"],
    queryFn: () => apiFetch<NetworksResponse>(API.networks),
    enabled: tab === "networks",
  });

  const mutate = useMutation({
    mutationFn: ({ path, method, body }: { path: string; method: "POST" | "DELETE"; body?: unknown }) =>
      method === "DELETE" ? del(path) : post(path, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["volumes"] });
      void queryClient.invalidateQueries({ queryKey: ["networks"] });
      void queryClient.invalidateQueries({ queryKey: ["snapshot"] });
    },
    onError: (error) => onNotice(error instanceof Error ? error.message : "操作失败"),
  });

  async function createVolume() {
    if (!volumeName.trim()) return;
    try {
      await post(API.volumes, { name: volumeName.trim() } satisfies VolumeCreate);
      setVolumeName("");
      onNotice("卷已创建");
      await queryClient.invalidateQueries({ queryKey: ["volumes"] });
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "创建失败");
    }
  }

  async function createNetwork() {
    if (!networkName.trim()) return;
    try {
      await post(API.networks, { name: networkName.trim(), internal: networkInternal } satisfies NetworkCreate);
      setNetworkName("");
      onNotice("网络已创建");
      await queryClient.invalidateQueries({ queryKey: ["networks"] });
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "创建失败");
    }
  }

  async function changeConnection(network: NetworkInfo, connected: boolean) {
    const container = (connectTarget[network.id] ?? "").trim();
    if (!container) {
      onNotice("请先填写容器名或容器 ID");
      return;
    }
    const body: NetworkConnectRequest = { id: network.id, container };
    try {
      await post(connected ? API.networkConnect : API.networkDisconnect, body);
      setManageNetwork(null);
      onNotice(connected ? "已连接容器" : "已断开容器");
      await queryClient.invalidateQueries({ queryKey: ["networks"] });
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "操作失败");
    }
  }

  return (
    <div className="panel-body">
      <PanelHeader
        title="资源管理"
        description="卷保存数据，网络让容器互相通信。删除前请确认没有容器在用。"
        onClose={onClose}
      />
      <div className="panel-tabs">
        <button className={tab === "volumes" ? "active" : ""} onClick={() => setTab("volumes")}>卷</button>
        <button className={tab === "networks" ? "active" : ""} onClick={() => setTab("networks")}>网络</button>
      </div>

      {tab === "volumes" ? (
        <>
          <section className="resource-section">
            <h4 className="section-heading">新建卷</h4>
            <div className="resource-create">
              <input value={volumeName} placeholder="新卷名称，例如 backup-data" onChange={(e) => setVolumeName(e.target.value)} />
              <button className="ghost" disabled={!volumeName.trim()} onClick={() => void createVolume()}>创建卷</button>
              <button
                className="ghost"
                disabled={!volumes.data?.summary.unused}
                onClick={() => mutate.mutate({ path: API.volumePrune, method: "POST" })}
              >
                清理未使用
              </button>
            </div>
          </section>
          <section className="resource-section">
            <h4 className="section-heading">
              卷列表
              <span className="muted small">
                共 {volumes.data?.summary.total ?? "—"} 个，未使用 {volumes.data?.summary.unused ?? "—"} 个
              </span>
            </h4>
            {volumes.isLoading && <p className="muted" role="status">正在读取卷…</p>}
            {volumes.isError && <p className="inline-error">{String(volumes.error)}</p>}
            {!volumes.isLoading && volumes.data?.volumes.length === 0 && (
              <p className="muted">还没有卷。可以在上方新建一个。</p>
            )}
            <div className="resource-list">
              {volumes.data?.volumes.map((volume) => (
                <div className="resource-row" key={volume.name}>
                  <div className="resource-main">
                    <strong>{volume.name}</strong>
                    <div className="muted small">
                      {volume.driver} · 创建于 {formatDate(volume.createdAt)}
                    </div>
                    <div className="resource-refs">
                      {volume.usedBy.length ? volume.usedBy.map((name) => <span key={name}>{name}</span>) : <span className="idle">未使用</span>}
                    </div>
                    <div className="muted small" title={volume.mountpoint}>{volume.mountpoint}</div>
                  </div>
                  <button
                    className="ghost danger small-btn"
                    title={volume.inUse ? "有容器正在使用，删除可能失败" : "删除卷"}
                    onClick={() => setPendingVolume(volume.name)}
                  >
                    删除
                  </button>
                </div>
              ))}
            </div>
          </section>
        </>
      ) : (
        <>
          <section className="resource-section">
            <h4 className="section-heading">新建网络</h4>
            <div className="resource-create">
              <input value={networkName} placeholder="新网络名称，例如 my-net" onChange={(e) => setNetworkName(e.target.value)} />
              <label className="inline-check"><input type="checkbox" checked={networkInternal} onChange={(e) => setNetworkInternal(e.target.checked)} /> 内部网络</label>
              <button className="ghost" disabled={!networkName.trim()} onClick={() => void createNetwork()}>创建网络</button>
              <button className="ghost" onClick={() => mutate.mutate({ path: API.networkPrune, method: "POST" })}>清理未使用</button>
            </div>
          </section>
          <section className="resource-section">
            <h4 className="section-heading">网络列表</h4>
            {networks.isLoading && <p className="muted" role="status">正在读取网络…</p>}
            {networks.isError && <p className="inline-error">{String(networks.error)}</p>}
            {!networks.isLoading && networks.data?.networks.length === 0 && (
              <p className="muted">还没有自定义网络。可以在上方新建一个。</p>
            )}
            <div className="resource-list">
              {networks.data?.networks.map((network) => (
                <div className="resource-row" key={network.id}>
                  <div className="resource-main">
                    <strong>{network.name}</strong>
                    <div className="muted small">
                      {network.driver} · {network.scope} · {network.subnet || "无子网"}
                    </div>
                    <div className="resource-refs">
                      {network.containers.length
                        ? network.containers.map((container) => <span key={container.name}>{container.name}</span>)
                        : <span className="idle">无容器</span>}
                    </div>
                    {manageNetwork === network.id && (
                      <div className="resource-connect">
                        <input
                          aria-label="要连接的容器名或 ID"
                          value={connectTarget[network.id] ?? ""}
                          placeholder="容器名或 ID"
                          onChange={(e) => setConnectTarget((old) => ({ ...old, [network.id]: e.target.value }))}
                        />
                        <button className="ghost small-btn" onClick={() => void changeConnection(network, true)}>连接</button>
                        <button className="ghost small-btn" onClick={() => void changeConnection(network, false)}>断开</button>
                        <button className="ghost small-btn" onClick={() => setManageNetwork(null)}>收起</button>
                      </div>
                    )}
                  </div>
                  <div className="resource-row-actions">
                    <button
                      className="ghost small-btn"
                      onClick={() => setManageNetwork((id) => (id === network.id ? null : network.id))}
                    >
                      {manageNetwork === network.id ? "收起" : "管理"}
                    </button>
                    <button className="ghost danger small-btn" onClick={() => setPendingNetwork(network)}>删除</button>
                  </div>
                </div>
              ))}
            </div>
          </section>
        </>
      )}

      {pendingVolume && (
        <ConfirmDialog
          title="删除卷"
          message={`确定删除卷「${pendingVolume}」吗？卷内数据会一起消失，此操作不可撤销。`}
          confirmLabel="删除卷"
          danger
          busy={mutate.isPending}
          onCancel={() => setPendingVolume(null)}
          onConfirm={() => { mutate.mutate({ path: API.volume(pendingVolume), method: "DELETE" }); setPendingVolume(null); }}
        />
      )}
      {pendingNetwork && (
        <ConfirmDialog
          title="删除网络"
          message={`确定删除网络「${pendingNetwork.name}」吗？连接在这个网络上的容器会失去连接。`}
          confirmLabel="删除网络"
          danger
          busy={mutate.isPending}
          onCancel={() => setPendingNetwork(null)}
          onConfirm={() => { mutate.mutate({ path: API.network(pendingNetwork.id), method: "DELETE" }); setPendingNetwork(null); }}
        />
      )}
    </div>
  );
}

const pruneLabels: { scope: PruneRequest["scope"]; label: string; hint: string }[] = [
  { scope: "containers", label: "停止的容器", hint: "只清理已经停止的容器" },
  { scope: "networks", label: "未使用的网络", hint: "没有容器连接的自定义网络" },
  { scope: "buildCache", label: "构建缓存", hint: "镜像构建产生的临时缓存" },
  { scope: "volumes", label: "未使用的卷", hint: "注意：会删除卷内数据" },
  { scope: "all", label: "全部清理", hint: "以上全部，不包括镜像" },
];

const lowRiskScopes: PruneRequest["scope"][] = ["containers", "networks", "buildCache"];
const highRiskScopes: PruneRequest["scope"][] = ["volumes", "all"];

export function MaintenancePanel({ onClose, onNotice }: { onClose: () => void; onNotice: (message: string) => void }) {
  const queryClient = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [pendingPrune, setPendingPrune] = useState<PruneRequest["scope"] | null>(null);
  const [backup, setBackup] = useState<BackupData | null>(null);
  const [overwrite, setOverwrite] = useState(false);
  const [pruneResult, setPruneResult] = useState<PruneResult[] | null>(null);

  const backupData = useQuery({
    queryKey: ["backup"],
    queryFn: () => apiFetch<BackupData>(API.backup),
  });

  const prune = useMutation({
    mutationFn: (scope: PruneRequest["scope"]) => post<{ results: PruneResult[] }>(API.systemPrune, { scope }),
    onSuccess: (result) => {
      setPruneResult(result.results);
      setPendingPrune(null);
      onNotice("清理完成");
      void queryClient.invalidateQueries();
    },
    onError: (error) => onNotice(error instanceof Error ? error.message : "清理失败"),
  });

  const restore = useMutation({
    mutationFn: () => post<BackupRestoreResult>(API.backupRestore, { data: backup as BackupData, overwrite }),
    onSuccess: (result) => {
      onNotice(result.message);
      setBackup(null);
      void queryClient.invalidateQueries();
    },
    onError: (error) => onNotice(error instanceof Error ? error.message : "恢复失败"),
  });

  function downloadBackup() {
    if (!backupData.data) return;
    const blob = new Blob([JSON.stringify(backupData.data, null, 2)], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `dockermanager-backup-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    onNotice("备份文件已下载");
  }

  async function pickFile(file: File | undefined) {
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text()) as BackupData;
      if (parsed.format !== "dockermanager-backup") throw new Error("不是 DockerManager 备份文件");
      setBackup(parsed);
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "备份文件读取失败");
    }
  }

  return (
    <div className="panel-body">
      <PanelHeader
        title="维护与备份"
        description="清理无用资源，或备份项目配置与卷信息。镜像清理请到「镜像」面板。"
        onClose={onClose}
      />
      <section className="maintenance-section">
        <h4 className="section-heading">低危清理</h4>
        <p className="muted small">只清理明确不再使用的临时对象，不影响卷内数据。</p>
        <div className="prune-grid">
          {pruneLabels
            .filter((item) => lowRiskScopes.includes(item.scope))
            .map((item) => (
              <button key={item.scope} className="ghost" title={item.hint} onClick={() => setPendingPrune(item.scope)}>
                {item.label}
              </button>
            ))}
        </div>
      </section>
      <section className="maintenance-section">
        <h4 className="section-heading danger">高危清理</h4>
        <p className="muted small">会删除卷内数据或一次性清理多类资源，执行前请确认已经备份。</p>
        <div className="prune-grid">
          {pruneLabels
            .filter((item) => highRiskScopes.includes(item.scope))
            .map((item) => (
              <button key={item.scope} className="ghost danger" title={item.hint} onClick={() => setPendingPrune(item.scope)}>
                {item.label}
              </button>
            ))}
        </div>
      </section>
      {pruneResult && (
        <div className="prune-result">
          {pruneResult.map((item) => (
            <p key={item.scope} className="muted small">• {item.message}（释放 {(item.reclaimedBytes / 1024 / 1024).toFixed(1)} MB）</p>
          ))}
          <button className="ghost small-btn" onClick={() => setPruneResult(null)}>收起</button>
        </div>
      )}

      <section className="maintenance-section">
        <h4 className="section-heading">备份恢复</h4>
        <p className="muted small">
          备份包含所有项目的 compose 和 .env，以及卷的名称/驱动/标签。卷内实际数据不在备份中，请另行备份。
        </p>
        <div className="panel-actions">
          <button className="ghost" disabled={!backupData.data} onClick={downloadBackup}>下载备份</button>
          <button className="ghost" onClick={() => fileRef.current?.click()}>选择备份文件</button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={(event) => void pickFile(event.target.files?.[0])}
          />
        </div>
        {backupData.data && (
          <p className="muted small">
            当前有 {backupData.data.stacks.length} 个项目、{backupData.data.volumes.length} 个卷可备份。
          </p>
        )}
        {backup && (
          <div className="restore-box">
            <p className="small">已选择备份：{backup.stacks.length} 个项目，生成于 {formatDate(backup.createdAt)}</p>
            <label className="inline-check">
              <input type="checkbox" checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)} />
              覆盖同名项目
            </label>
            <button className="primary" disabled={restore.isPending} onClick={() => restore.mutate()}>
              {restore.isPending ? "正在恢复…" : "开始恢复"}
            </button>
            <button className="ghost" onClick={() => setBackup(null)}>取消</button>
          </div>
        )}
      </section>

      {pendingPrune && (
        <ConfirmDialog
          title="系统清理"
          message={`确定执行「${pruneLabels.find((item) => item.scope === pendingPrune)?.label}」吗？${pruneLabels.find((item) => item.scope === pendingPrune)?.hint}。此操作不可撤销。`}
          confirmLabel="开始清理"
          danger={pendingPrune === "volumes" || pendingPrune === "all"}
          busy={prune.isPending}
          onCancel={() => setPendingPrune(null)}
          onConfirm={() => prune.mutate(pendingPrune)}
        />
      )}
    </div>
  );
}
