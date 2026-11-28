import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  API,
  type LogCategory,
  type LogCleanupResult,
  type LogFileContent,
  type LogFileInfo,
  type LogFilesResponse,
  type LogRetention,
  type LogSettingsResponse,
} from "@dockermanager/shared";
import { apiFetch, del, post, put, scopedUrl } from "../api";
import { ConfirmDialog } from "./ConfirmDialog";
import { PanelHeader } from "./Panels";

const CATEGORY_LABEL: Record<LogCategory, string> = {
  container: "项目服务",
  task: "任务输出",
  audit: "操作审计",
  server: "运行日志",
};

function formatBytes(value: number): string {
  if (!value) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  const scaled = value / 1024 ** index;
  const digits = index === 0 || scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2;
  return `${scaled.toFixed(digits)} ${units[index]}`;
}

function formatTime(value: string): string {
  if (!value) return "旧版记录";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN");
}

interface LogsPanelProps {
  onClose: () => void;
  onNotice: (message: string) => void;
  initialCategory?: LogCategory;
  initialScope?: string;
}

/** 所有历史日志的总入口：按分类筛选、点开细看、下载、删除，并配置各类保留天数 */
export function LogsPanel({ onClose, onNotice, initialCategory, initialScope }: LogsPanelProps) {
  const queryClient = useQueryClient();
  const [category, setCategory] = useState<LogCategory | "all">(initialCategory ?? "all");
  const [scope, setScope] = useState(initialScope ?? "");
  const [fileSearch, setFileSearch] = useState("");
  const [retentionOpen, setRetentionOpen] = useState(false);
  const [selected, setSelected] = useState<LogFileInfo | null>(null);
  const [pendingDelete, setPendingDelete] = useState<LogFileInfo | null>(null);
  const [confirmCleanup, setConfirmCleanup] = useState(false);
  const [draft, setDraft] = useState<LogRetention | null>(null);

  const files = useQuery({
    queryKey: ["logFiles", category, scope],
    queryFn: () => {
      const params = new URLSearchParams();
      if (category !== "all") params.set("category", category);
      if (scope) params.set("scope", scope);
      const query = params.toString();
      return apiFetch<LogFilesResponse>(`${API.logFiles}${query ? `?${query}` : ""}`);
    },
  });

  const settings = useQuery({
    queryKey: ["logSettings"],
    queryFn: () => apiFetch<LogSettingsResponse>(API.logSettings),
  });

  useEffect(() => {
    if (settings.data?.retention) setDraft(settings.data.retention);
  }, [settings.data]);

  const content = useQuery({
    queryKey: ["logFile", selected?.relativePath],
    queryFn: () =>
      apiFetch<LogFileContent>(
        `${API.logFile}?path=${encodeURIComponent(selected?.relativePath ?? "")}&limit=500`,
      ),
    enabled: Boolean(selected),
  });

  const visibleFiles = useMemo(() => {
    let list = files.data?.files ?? [];
    if (scope) list = list.filter((file) => file.scope === scope);
    const keyword = fileSearch.trim().toLowerCase();
    if (keyword) {
      list = list.filter((file) =>
        `${file.scope} ${file.name} ${CATEGORY_LABEL[file.category]}`.toLowerCase().includes(keyword),
      );
    }
    return list;
  }, [files.data, scope, fileSearch]);

  const saveSettings = useMutation({
    mutationFn: (retention: LogRetention) => put<LogSettingsResponse>(API.logSettings, retention),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["logSettings"] });
      onNotice("保留设置已保存，下次清理时生效");
    },
    onError: (error) => onNotice(error instanceof Error ? error.message : "保存失败"),
  });

  const removeFile = useMutation({
    mutationFn: (file: LogFileInfo) =>
      del<{ ok: boolean }>(`${API.logFile}?path=${encodeURIComponent(file.relativePath)}`),
    onSuccess: () => {
      setPendingDelete(null);
      if (selected?.relativePath === pendingDelete?.relativePath) setSelected(null);
      void queryClient.invalidateQueries({ queryKey: ["logFiles"] });
      onNotice("日志文件已删除");
    },
    onError: (error) => onNotice(error instanceof Error ? error.message : "删除失败"),
  });

  const cleanup = useMutation({
    mutationFn: () => post<LogCleanupResult>(API.logCleanup),
    onSuccess: (result) => {
      setConfirmCleanup(false);
      void queryClient.invalidateQueries({ queryKey: ["logFiles"] });
      onNotice(`已清理 ${result.removed} 个过期日志文件`);
    },
    onError: (error) => onNotice(error instanceof Error ? error.message : "清理失败"),
  });

  function download(): void {
    if (!selected) return;
    // 直接走服务端原始文件接口，避免只下载页面预览的末尾 500 行。
    const url = scopedUrl(`${API.logFileRaw}?path=${encodeURIComponent(selected.relativePath)}`);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${selected.scope ? `${selected.scope.replace(/\//g, "-")}-` : ""}${selected.name}`;
    document.body.appendChild(link);
    link.click();
    link.remove();
  }

  return (
    <div className="panel-body logs-center">
      <PanelHeader
        title="日志中心"
        description="每次启动单独存一个文件，历史不再混在一起。点开任意文件可查看当时的完整输出。"
        onClose={onClose}
      />

      <div className="log-filter-bar">
        {(["all", "container", "task", "audit", "server"] as const).map((item) => (
          <button
            key={item}
            className={`ghost ${category === item ? "active" : ""}`}
            onClick={() => {
              setCategory(item);
              setSelected(null);
            }}
          >
            {item === "all" ? "全部" : CATEGORY_LABEL[item]}
          </button>
        ))}
        {scope && (
          <button className="ghost" onClick={() => setScope("")}>
            清除范围：{scope}
          </button>
        )}
        <input
          className="search log-file-search"
          aria-label="搜索日志文件"
          placeholder="搜索日志文件…"
          value={fileSearch}
          onChange={(event) => setFileSearch(event.target.value)}
        />
      </div>

      <div className="log-retention">
        <button
          className="ghost small-btn"
          aria-expanded={retentionOpen}
          onClick={() => setRetentionOpen((open) => !open)}
        >
          保留设置 {retentionOpen ? "收起" : "展开"}
        </button>
        {retentionOpen && (
          <div className="log-retention-box">
            <div className="log-retention-title">0 表示永久保留，修改后下次清理时生效</div>
            <div className="log-retention-fields">
              {(["container", "task", "audit", "server"] as LogCategory[]).map((item) => (
                <label key={item}>
                  <span>{CATEGORY_LABEL[item]}</span>
                  <input
                    type="number"
                    min={0}
                    max={3650}
                    value={draft?.[item] ?? 0}
                    onChange={(event) =>
                      setDraft((old) => (old ? { ...old, [item]: Number(event.target.value) } : old))
                    }
                  />
                  <span>天</span>
                </label>
              ))}
              <button
                className="ghost"
                disabled={saveSettings.isPending || !draft}
                onClick={() => draft && saveSettings.mutate(draft)}
              >
                保存设置
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="log-files-layout">
        <div className="log-file-list">
          {files.isLoading && <p className="muted" role="status">正在读取日志文件…</p>}
          {visibleFiles.length === 0 && !files.isLoading && (
            <p className="muted">
              {fileSearch ? "没有匹配的日志文件，换个关键词试试。" : "这个分类下还没有日志文件。启动一次服务后会自动生成。"}
            </p>
          )}
          {visibleFiles.map((file) => (
            <button
              key={file.relativePath}
              className={`log-file-row ${selected?.relativePath === file.relativePath ? "active" : ""}`}
              onClick={() => setSelected(file)}
            >
              <span className={`log-kind kind-${file.category}`}>{CATEGORY_LABEL[file.category]}</span>
              <span className="log-file-scope">{file.scope || "全局"}</span>
              <span className="log-file-name">{formatTime(file.startedAt)}</span>
              <span className="log-file-size">{formatBytes(file.size)}</span>
            </button>
          ))}
        </div>

        <div className={`log-file-view ${selected?.category === "task" ? "view-task" : ""}`}>
          {!selected ? (
            <div className="muted log-file-empty">从左侧选择一个日志文件，查看当时保存的完整输出。</div>
          ) : (
            <>
              <div className="log-file-head">
                <div>
                  <strong>{selected.scope || CATEGORY_LABEL[selected.category]}</strong>
                  <div className="muted">{selected.name}</div>
                </div>
                <div className="log-file-actions">
                  <button
                    className="ghost"
                    disabled={content.isFetching}
                    onClick={() => void content.refetch()}
                  >
                    刷新
                  </button>
                  <button className="ghost" onClick={download}>下载</button>
                  <button className="ghost danger" onClick={() => setPendingDelete(selected)}>
                    删除
                  </button>
                </div>
              </div>
              {content.isLoading && <p className="muted" role="status">正在读取文件内容…</p>}
              {content.data && (
                <>
                  <div className="muted log-file-meta">
                    共 {content.data.totalLines} 行
                    {content.data.truncated ? "，仅显示末尾 500 行" : ""}
                  </div>
                  <pre
                    className={`log-file-content ${selected.category === "task" ? "task-content" : ""}`}
                  >
                    {content.data.lines.join("\n")}
                  </pre>
                </>
              )}
            </>
          )}
        </div>
      </div>

      <div className="panel-actions">
        <button className="ghost" onClick={() => setConfirmCleanup(true)}>
          清理过期日志
        </button>
      </div>

      {pendingDelete && (
        <ConfirmDialog
          title="删除日志文件"
          message={`确定删除「${pendingDelete.scope || CATEGORY_LABEL[pendingDelete.category]} ${formatTime(pendingDelete.startedAt)}」吗？删除后无法恢复。`}
          confirmLabel="删除"
          danger
          busy={removeFile.isPending}
          onCancel={() => setPendingDelete(null)}
          onConfirm={() => removeFile.mutate(pendingDelete)}
        />
      )}
      {confirmCleanup && (
        <ConfirmDialog
          title="清理过期日志"
          message="按上面的保留天数清理全部历史日志，过期文件会被永久删除。"
          confirmLabel="开始清理"
          danger
          busy={cleanup.isPending}
          onCancel={() => setConfirmCleanup(false)}
          onConfirm={() => cleanup.mutate()}
        />
      )}
    </div>
  );
}
