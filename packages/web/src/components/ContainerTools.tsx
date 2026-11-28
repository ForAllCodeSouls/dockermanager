import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, FilePlus2, FolderOpen, Save, Trash2 } from "lucide-react";
import {
  API,
  type ContainerDetail,
  type ContainerFileContent,
  type ContainerFilesResponse,
} from "@dockermanager/shared";
import { apiFetch, del, getCurrentHost, put } from "../api";
import { ConfirmDialog } from "./ConfirmDialog";

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="inspect-row">
      <span>{label}</span>
      <span title={value}>{value || "—"}</span>
    </div>
  );
}

export function ContainerInspector({ id }: { id: string }) {
  const host = getCurrentHost();
  const query = useQuery({
    queryKey: ["container-inspect", host, id],
    queryFn: () => apiFetch<ContainerDetail>(API.containerInspect(id)),
  });
  if (query.isLoading) return <p className="muted">读取容器详情…</p>;
  if (query.isError) return <p className="inline-error">{String(query.error)}</p>;
  const detail = query.data;
  if (!detail) return null;

  const formatDate = (value: string) => {
    if (!value || value.startsWith("0001-")) return "—";
    return new Date(value).toLocaleString("zh-CN");
  };
  return (
    <div className="inspect-body">
      <p className="inspect-note">{detail.note}</p>
      <h4>基本信息</h4>
      <div className="inspect-list">
        <Row label="名称" value={detail.name} />
        <Row label="ID" value={detail.id} />
        <Row label="镜像" value={detail.image} />
        <Row label="状态" value={detail.state} />
        <Row label="健康检查" value={detail.health ?? "未配置"} />
        <Row label="启动命令" value={detail.command} />
        <Row label="创建时间" value={formatDate(detail.createdAt)} />
        <Row label="启动时间" value={formatDate(detail.startedAt)} />
        <Row label="重启策略" value={detail.restartPolicy} />
      </div>
      <h4>挂载</h4>
      {detail.mounts.length === 0 ? (
        <p className="muted small">无挂载</p>
      ) : (
        <div className="inspect-list">
          {detail.mounts.map((mount, index) => (
            <Row key={index} label={mount.type} value={`${mount.source} → ${mount.destination} ${mount.mode}`} />
          ))}
        </div>
      )}
      <h4>端口与网络</h4>
      <div className="inspect-list">
        {detail.ports.length === 0 ? (
          <Row label="端口" value="无" />
        ) : (
          detail.ports.map((port, index) => (
            <Row
              key={index}
              label={port.type}
              value={port.publicPort ? `${port.ip || "0.0.0.0"}:${port.publicPort} → ${port.privatePort}` : `${port.privatePort}（未映射）`}
            />
          ))
        )}
        <Row label="网络" value={detail.networks.join(", ") || "无"} />
      </div>
      <h4>环境变量（已脱敏）</h4>
      {detail.env.length === 0 ? (
        <p className="muted small">无环境变量</p>
      ) : (
        <pre className="inspect-env">{detail.env.join("\n")}</pre>
      )}
      <h4>标签</h4>
      {Object.keys(detail.labels).length === 0 ? (
        <p className="muted small">无标签</p>
      ) : (
        <div className="inspect-list">
          {Object.entries(detail.labels).map(([key, value]) => (
            <Row key={key} label={key} value={value} />
          ))}
        </div>
      )}
    </div>
  );
}

export function ContainerFiles({ id }: { id: string }) {
  const host = getCurrentHost();
  const queryClient = useQueryClient();
  const [dir, setDir] = useState("/");
  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [newFile, setNewFile] = useState("");
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);

  const files = useQuery({
    queryKey: ["container-files", host, id, dir],
    queryFn: () => apiFetch<ContainerFilesResponse>(API.containerFiles(id, dir)),
  });
  const content = useQuery({
    queryKey: ["container-file", host, id, selected],
    enabled: Boolean(selected),
    queryFn: () => apiFetch<ContainerFileContent>(API.containerFile(id, selected ?? "")),
  });

  const save = useMutation({
    mutationFn: () => put(API.containerFile(id, selected ?? ""), { path: selected, content: draft ?? "" }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["container-file", host, id, selected] });
    },
  });
  const remove = useMutation({
    mutationFn: (filePath: string) => del(API.containerFile(id, filePath)),
    onSuccess: () => {
      setSelected(null);
      setPendingDelete(null);
      void queryClient.invalidateQueries({ queryKey: ["container-files", host, id, dir] });
    },
  });

  function openFile(path: string) {
    setSelected(path);
    setDraft(null);
  }

  function goUp() {
    const parent = dir.replace(/\/+$/, "").split("/").slice(0, -1).join("/") || "/";
    setDir(parent);
    setSelected(null);
  }

  async function createFile() {
    const name = newFile.trim();
    if (!name || name.includes("/")) return;
    const path = dir === "/" ? `/${name}` : `${dir.replace(/\/+$/, "")}/${name}`;
    await put(API.containerFile(id, path), { path, content: "" });
    setNewFile("");
    setSelected(path);
    setDraft(null);
    void queryClient.invalidateQueries({ queryKey: ["container-files", host, id, dir] });
  }

  const segments = dir.split("/").filter(Boolean);

  return (
    <div className="files-body">
      <div className="files-toolbar">
        <button className="ghost small-btn" onClick={goUp} disabled={dir === "/"}>
          <ArrowLeft size={14} /> 上级
        </button>
        <span className="files-path" title={dir}>/{segments.join(" / ")}</span>
      </div>
      {files.isLoading && <p className="muted">读取目录…</p>}
      {files.isError && <p className="inline-error">{String(files.error)}</p>}
      <div className="files-list">
        {files.data?.entries.map((entry) => (
          <button
            key={entry.path}
            className={`files-entry ${entry.type} ${selected === entry.path ? "active" : ""}`}
            onClick={() => (entry.type === "dir" ? (setDir(entry.path), setSelected(null)) : openFile(entry.path))}
          >
            <FolderOpen size={14} />
            <span className="files-name">{entry.name}</span>
            <span className="files-meta">{entry.type === "dir" ? "目录" : `${entry.size} B`}</span>
          </button>
        ))}
      </div>
      <div className="files-new">
        <input
          value={newFile}
          placeholder="新建空文件名"
          onChange={(event) => setNewFile(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter") void createFile(); }}
        />
        <button className="ghost small-btn" disabled={!newFile.trim()} onClick={() => void createFile()}>
          <FilePlus2 size={14} /> 新建
        </button>
      </div>
      {selected && (
        <div className="files-editor">
          <div className="files-editor-head">
            <strong title={selected}>{selected}</strong>
            <div className="files-editor-actions">
              <button className="ghost small-btn" disabled={!content.data || draft === null} onClick={() => void save.mutate()}>
                <Save size={14} /> {save.isPending ? "保存中…" : "保存"}
              </button>
              <button className="ghost small-btn danger" onClick={() => setPendingDelete(selected)}>
                <Trash2 size={14} /> 删除
              </button>
            </div>
          </div>
          {content.isLoading && <p className="muted">读取文件…</p>}
          {content.isError && <p className="inline-error">{String(content.error)}</p>}
          {content.data && (
            <>
              <textarea
                className="files-textarea"
                value={draft ?? content.data.content}
                onChange={(event) => setDraft(event.target.value)}
                spellCheck={false}
              />
              {content.data.truncated && <p className="muted small">文件过大，只显示前 2MB，保存会覆盖原文件。</p>}
            </>
          )}
        </div>
      )}
      {files.data?.note && <p className="hint">{files.data.note}</p>}
      {pendingDelete && (
        <ConfirmDialog
          title="删除容器文件"
          message={`确定删除容器里的 ${pendingDelete} 吗？此操作不可撤销。`}
          confirmLabel="删除文件"
          danger
          busy={remove.isPending}
          onCancel={() => setPendingDelete(null)}
          onConfirm={() => remove.mutate(pendingDelete)}
        />
      )}
    </div>
  );
}
