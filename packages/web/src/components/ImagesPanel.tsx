import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  API,
  type ImageInfo,
  type ImagePruneScope,
  type ImagePruneResult,
  type ImageRemoveRequest,
  type ImageRemoveResult,
  type ImagesResponse,
  type ImageUsage,
} from "@dockermanager/shared";
import { apiFetch, post } from "../api";
import { ConfirmDialog } from "./ConfirmDialog";
import { PanelHeader } from "./Panels";

const usageLabel: Record<ImageUsage, string> = {
  used: "使用中",
  declared: "项目声明",
  unused: "未使用",
  dangling: "悬空",
};

const usageOrder: ImageUsage[] = ["used", "declared", "unused", "dangling"];

interface Props {
  onClose: () => void;
  onNotice: (message: string) => void;
  /** 项目页点击镜像标签时可预先聚焦某个镜像 */
  focusTag?: string | null;
}

export function ImagesPanel({ onClose, onNotice, focusTag }: Props) {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [confirm, setConfirm] = useState<
    | { kind: "remove"; ids: string[] }
    | { kind: "prune"; scope: ImagePruneScope }
    | null
  >(null);
  const [warning, setWarning] = useState("");

  const images = useQuery({
    queryKey: ["images"],
    queryFn: () => apiFetch<ImagesResponse>(API.images),
  });

  const refresh = () => void queryClient.invalidateQueries({ queryKey: ["images"] });

  const remove = useMutation({
    mutationFn: (ids: string[]) =>
      post<{ results: ImageRemoveResult[] }>(API.imageRemove, {
        ids,
      } satisfies ImageRemoveRequest),
    onSuccess: (result) => {
      const ok = result.results.filter((item) => item.ok).length;
      const failed = result.results.filter((item) => !item.ok);
      setConfirm(null);
      setSelected([]);
      setWarning(failed.map((item) => `${item.id}: ${item.message}`).join("\n"));
      onNotice(failed.length ? `已删除 ${ok} 个，失败 ${failed.length} 个` : `已删除 ${ok} 个镜像`);
      refresh();
    },
    onError: (error) => onNotice(error instanceof Error ? error.message : "删除失败"),
  });

  const prune = useMutation({
    mutationFn: (scope: ImagePruneScope) => post<ImagePruneResult>(API.imagePrune, { scope }),
    onSuccess: (result) => {
      setConfirm(null);
      setSelected([]);
      setWarning(result.failed.map((item) => `${item.id}: ${item.message}`).join("\n"));
      onNotice(
        `已清理 ${result.removed.length} 个镜像，释放 ${formatBytes(result.reclaimedBytes)}` +
          (result.failed.length ? `，失败 ${result.failed.length} 个` : ""),
      );
      refresh();
    },
    onError: (error) => onNotice(error instanceof Error ? error.message : "清理失败"),
  });

  const filtered = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    return (images.data?.images ?? []).filter((image) => {
      if (keyword) {
        const haystack = [
          ...image.tags,
          image.id,
          ...image.references.map((ref) => `${ref.name} ${ref.project ?? ""}`),
        ]
          .join(" ")
          .toLowerCase();
        if (!haystack.includes(keyword)) return false;
      }
      return true;
    });
  }, [images.data, search]);

  const grouped = useMemo(() => {
    const map = new Map<ImageUsage, ImageInfo[]>();
    for (const usage of usageOrder) map.set(usage, []);
    for (const image of filtered) map.get(image.usage)?.push(image);
    return map;
  }, [filtered]);

  const cleanableSelected = selected.filter((id) =>
    images.data?.images.some((image) => image.id === id && image.cleanable),
  );
  const usedSelected = selected.filter((id) =>
    images.data?.images.some((image) => image.id === id && !image.cleanable),
  );

  function toggle(id: string) {
    setSelected((old) => (old.includes(id) ? old.filter((item) => item !== id) : [...old, id]));
  }

  const summary = images.data?.summary;

  return (
    <div className="panel-body images-panel">
      <PanelHeader
        title="镜像管理"
        description="镜像引用包含运行中和已停止的容器；删除后下次启动会重新拉取。"
        onClose={onClose}
      />
      <div className="panel-actions compact">
        <button className="ghost small-btn" onClick={refresh} disabled={images.isFetching}>
          {images.isFetching ? "正在刷新…" : "刷新"}
        </button>
      </div>

      <div className="image-summary">
        <div><strong>{summary?.total ?? "—"}</strong><span>全部镜像</span></div>
        <div><strong>{summary?.used ?? "—"}</strong><span>使用中</span></div>
        <div><strong>{summary?.declared ?? "—"}</strong><span>项目声明</span></div>
        <div><strong>{summary?.unused ?? "—"}</strong><span>未使用</span></div>
        <div><strong>{summary?.dangling ?? "—"}</strong><span>悬空</span></div>
        <div><strong>{summary ? formatBytes(summary.reclaimableBytes) : "—"}</strong><span>可释放(估算)</span></div>
      </div>

      <div className="image-toolbar">
        <input
          className="search"
          placeholder="搜索镜像名 / ID / 项目…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="image-toolbar-actions">
          <button
            className="ghost"
            disabled={cleanableSelected.length === 0 || remove.isPending}
            onClick={() => setConfirm({ kind: "remove", ids: cleanableSelected })}
          >
            删除选中 ({cleanableSelected.length})
          </button>
          <button
            className="ghost"
            disabled={!summary?.dangling || prune.isPending}
            onClick={() => setConfirm({ kind: "prune", scope: "dangling" })}
          >
            清理悬空
          </button>
          <button
            className="ghost"
            disabled={!summary?.unused || prune.isPending}
            onClick={() => setConfirm({ kind: "prune", scope: "unused" })}
          >
            清理未使用
          </button>
        </div>
      </div>

      {usedSelected.length > 0 && (
        <p className="image-warning">
          已选 {usedSelected.length} 个使用中的镜像，已自动跳过删除。
        </p>
      )}
      {warning && (
        <pre className="image-warning" style={{ whiteSpace: "pre-wrap" }}>{warning}</pre>
      )}

      {images.isLoading && <p className="muted" role="status">正在读取镜像…</p>}
      {images.isError && <p className="inline-error">{String(images.error)}</p>}
      {!images.isLoading && filtered.length === 0 && (
        <p className="muted">
          {search ? "没有匹配的镜像，换个关键词试试。" : "本机还没有镜像。拉取或构建一个镜像后会出现在这里。"}
        </p>
      )}

      {usageOrder.map((usage) => {
        const group = grouped.get(usage) ?? [];
        if (group.length === 0) return null;
        return (
          <div className="image-group" key={usage}>
            <div className="image-group-head">
              <span className={`image-tag usage-${usage}`}>{usageLabel[usage]}</span>
              <span className="muted small">{group.length} 个</span>
            </div>
            {group.map((image) => {
              const checked = selected.includes(image.id);
              const highlight = focusTag && image.tags.some((tag) => tag.includes(focusTag));
              return (
                <div className={`image-row ${highlight ? "focused" : ""}`} key={image.id}>
                  <label className="image-check" onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={!image.cleanable}
                      title={image.cleanable ? "选择删除" : "容器正在使用，不能删除"}
                      onChange={() => toggle(image.id)}
                    />
                  </label>
                  <div className="image-main">
                    <div className="image-tags">
                      {image.tags.length ? (
                        image.tags.map((tag) => <code key={tag}>{tag}</code>)
                      ) : (
                        <code className="muted">&lt;none&gt;</code>
                      )}
                    </div>
                    <div className="image-meta muted small">
                      ID {image.id} · {image.sizeLabel} · {new Date(image.createdAt).toLocaleDateString("zh-CN")}
                    </div>
                    {image.references.length > 0 && (
                      <div className="image-refs small">
                        {image.references.map((ref, index) => (
                          <span key={`${ref.kind}-${ref.name}-${index}`}>
                            {ref.kind === "container" ? "容器" : "项目"} {ref.name}
                            {ref.state ? `(${ref.state})` : ""}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                  {image.cleanable && (
                    <button
                      className="ghost image-delete"
                      disabled={remove.isPending}
                      onClick={() => setConfirm({ kind: "remove", ids: [image.id] })}
                    >
                      删除
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        );
      })}

      {confirm?.kind === "remove" && (
        <ConfirmDialog
          title="删除镜像"
          message={`确定删除选中的 ${confirm.ids.length} 个镜像吗？被容器使用的镜像会自动跳过，此操作不可撤销。`}
          confirmLabel="删除"
          danger
          busy={remove.isPending}
          onCancel={() => setConfirm(null)}
          onConfirm={() => remove.mutate(confirm.ids)}
        />
      )}
      {confirm?.kind === "prune" && (
        <ConfirmDialog
          title="清理镜像"
          message={
            confirm.scope === "dangling"
              ? "确定清理所有悬空镜像吗？悬空镜像没有标签且未被容器使用。"
              : "确定清理所有未使用的镜像吗？被项目 compose 声明的镜像下次启动会重新拉取。"
          }
          confirmLabel="清理"
          danger
          busy={prune.isPending}
          onCancel={() => setConfirm(null)}
          onConfirm={() => prune.mutate(confirm.scope)}
        />
      )}
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 ? 0 : value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits).replace(/\.?0+$/, "")} ${units[unit]}`;
}
