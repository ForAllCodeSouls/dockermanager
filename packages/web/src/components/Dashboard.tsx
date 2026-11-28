import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  Box,
  ChevronDown,
  ClipboardList,
  FileText,
  Images,
  LogOut,
  RefreshCw,
  ScrollText,
  Terminal,
  Wrench,
} from "lucide-react";
import {
  API,
  type ActionResult,
  type BatchRequest,
  type HealthResponse,
  type LogCategory,
  type ServerEvent,
  type Snapshot,
  type StackAction,
  type StackInfo,
  type TaskFinished,
  type TaskStarted,
} from "@dockermanager/shared";
import { apiFetch, del, post, postLocal, put } from "../api";
import type { LiveState } from "../live";
import { AuditPanel, DiagnosticsPanel } from "./Panels";
import { ImagesPanel } from "./ImagesPanel";
import { MaintenancePanel, ResourcesPanel } from "./ResourcePanels";
import { LogsPanel } from "./LogsPanel";
import { Sidebar } from "./Sidebar";
import { StackEditor } from "./StackEditor";
import { DetailPane } from "./DetailPane";
import { NewProject } from "./NewProject";
import { HostSwitcher } from "./HostSwitcher";
import { ConfirmDialog } from "./ConfirmDialog";
import { DEFAULT_COMPOSE } from "../defaults";

interface Props {
  live: LiveState;
  health: HealthResponse | undefined;
  host: string;
  onHostChange: (host: string) => void;
}

const connectionLabel: Record<LiveState["status"], string> = {
  live: "实时连接",
  connecting: "正在连接",
  reconnecting: "重连中",
  offline: "网络离线",
};

const batchLabel: Record<StackAction, string> = {
  start: "启动",
  stop: "停止",
  restart: "重启",
  pull: "拉取镜像",
  update: "拉取并重启",
  down: "停止并删除容器",
};

export function Dashboard({ live, health, host, onHostChange }: Props) {
  const queryClient = useQueryClient();
  const snapshot = useQuery({
    queryKey: ["snapshot", host],
    queryFn: () => apiFetch<Snapshot>(API.snapshot),
  });
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [activeName, setActiveName] = useState<string | null>(null);
  const [selectedService, setSelectedService] = useState<string | null>(null);
  const [panel, setPanel] = useState<"none" | "audit" | "diagnostics" | "images" | "logs" | "resources" | "maintenance">("none");
  const [toolMenuOpen, setToolMenuOpen] = useState(false);
  const toolMenuRef = useRef<HTMLDivElement>(null);
  const [logFocus, setLogFocus] = useState<{ category?: LogCategory; scope?: string }>({});
  const openLogs = useCallback((category?: LogCategory, scope?: string) => {
    setLogFocus({ category, scope });
    setPanel("logs");
    setToolMenuOpen(false);
  }, []);
  const closePanel = useCallback(() => {
    setPanel("none");
    setMobileView((view) => (view === "logs" ? "detail" : view));
  }, []);
  const [notice, setNotice] = useState("");
  const [creating, setCreating] = useState(false);
  const [task, setTask] = useState<TaskStarted | null>(null);
  const [busy, setBusy] = useState(false);
  const [taskBusy, setTaskBusy] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [pendingBatch, setPendingBatch] = useState<{ action: StackAction; names: string[] } | null>(null);
  // 手机屏只有一列，用底部导航在「项目 / 配置 / 容器 / 日志」之间切换；桌面端由 CSS 忽略。
  const [mobileView, setMobileView] = useState<"projects" | "editor" | "detail" | "logs">("projects");

  const stacks = useMemo(() => {
    const all = snapshot.data?.stacks ?? [];
    const keyword = search.trim().toLowerCase();
    return keyword ? all.filter((s) => s.name.toLowerCase().includes(keyword)) : all;
  }, [snapshot.data, search]);

  const active = useMemo(
    () => stacks.find((s) => s.name === activeName) ?? null,
    [stacks, activeName],
  );

  // 选中项目变化时，默认选中第一个容器；容器列表变化时修正失效的服务名
  useEffect(() => {
    if (!active) {
      setSelectedService(null);
      return;
    }
    const names = active.services.map((c) => c.service || c.name);
    if (!selectedService || !names.includes(selectedService)) {
      setSelectedService(names[0] ?? null);
    }
  }, [active, selectedService]);

  function notify(message: string) {
    setNotice(message);
    setTimeout(() => setNotice(""), 5000);
  }

  // Esc 关闭侧边面板或工具菜单；确认框打开时由确认框自己处理 Esc
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || document.querySelector(".modal-backdrop")) return;
      if (toolMenuOpen) setToolMenuOpen(false);
      else if (panel !== "none") closePanel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [panel, toolMenuOpen, closePanel]);

  // 点击工具菜单外部时收起菜单
  useEffect(() => {
    if (!toolMenuOpen) return;
    const onDocClick = (event: MouseEvent) => {
      if (toolMenuRef.current && !toolMenuRef.current.contains(event.target as Node)) {
        setToolMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [toolMenuOpen]);

  useEffect(() => {
    const onUpdate = (event: Event) => {
      const detail = (event as CustomEvent<ServerEvent>).detail;
      if (detail.type === "update.applied") {
        setNotice("已发现新版本，容器正在重启；页面将自动恢复连接");
      } else if (detail.type === "update.available") {
        setNotice("发现新版本，即将自动更新");
      } else if (detail.type === "update.failed") {
        setNotice("更新检查失败，请在诊断面板查看原因");
      }
    };
    window.addEventListener("dockermanager:update", onUpdate);
    return () => window.removeEventListener("dockermanager:update", onUpdate);
  }, []);

  const refresh = useCallback(() => {
    void queryClient.invalidateQueries();
  }, [queryClient]);

  // 主机切换后重置当前选中项，避免旧主机的项目名/容器名带到新主机。
  useEffect(() => {
    setActiveName(null);
    setSelected([]);
    setSelectedService(null);
    setCreating(false);
    setPanel("none");
    setToolMenuOpen(false);
    setMobileView("projects");
    refresh();
  }, [host, refresh]);

  const onTaskFinished = useCallback(
    (result: TaskFinished) => {
      setTaskBusy(false);
      notify(result.ok ? "操作完成" : `操作失败（退出码 ${result.exitCode}）`);
      refresh();
    },
    [refresh],
  );

  async function runAction(name: string, action: StackAction) {
    setTaskBusy(true);
    try {
      const started = await post<TaskStarted>(API.stackAction(name, action));
      setTask(started);
    } catch (error) {
      setTaskBusy(false);
      notify(error instanceof Error ? error.message : "操作启动失败");
    }
  }

  async function runBatch(action: StackAction, names: string[] = selected) {
    if (names.length === 0) return;
    setBusy(true);
    try {
      const result = await post<{ results: ActionResult[] }>(API.batch, {
        names: [...names],
        action,
      } satisfies BatchRequest);
      const failed = result.results.filter((r) => !r.ok).length;
      notify(`批量 ${action}：${result.results.length - failed} 成功，${failed} 失败`);
      refresh();
    } catch (error) {
      notify(error instanceof Error ? error.message : "批量操作失败");
    } finally {
      setBusy(false);
    }
  }

  function requestBatch(action: StackAction, names: string[] = selected) {
    if (names.length === 0) return;
    setPendingBatch({ action, names });
  }

  function runAll(action: StackAction) {
    // “全部”针对当前主机的所有项目，而不是搜索框过滤后的结果。
    const allNames = (snapshot.data?.stacks ?? []).map((item) => item.name);
    requestBatch(action, allNames);
  }

  function nextProjectName(): string {
    const existing = new Set((snapshot.data?.stacks ?? []).map((item) => item.name));
    let index = 1;
    while (existing.has(`project-${index}`)) index += 1;
    return `project-${index}`;
  }

  async function createProject(
    compose: string = DEFAULT_COMPOSE,
    start = false,
  ): Promise<string | null> {
    const name = nextProjectName();
    setBusy(true);
    try {
      await put(API.stack(name), { compose, env: "" });
      const now = new Date().toISOString();
      const created: StackInfo = {
        name,
        status: "unknown",
        services: [],
        composeModifiedAt: now,
        envModifiedAt: null,
        error: null,
      };
      queryClient.setQueryData<Snapshot>(["snapshot", host], (old) =>
        old
          ? { ...old, stacks: [...old.stacks.filter((item) => item.name !== name), created] }
          : old,
      );
      setSearch("");
      setActiveName(name);
      setSelectedService(null);
      setCreating(false);
      if (start) {
        await runAction(name, "start");
        notify(`已创建并启动项目 ${name}`);
      } else {
        notify(`已创建项目 ${name}`);
      }
      refresh();
      return name;
    } catch (error) {
      notify(error instanceof Error ? error.message : "创建失败");
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function removeStack(name: string) {
    setBusy(true);
    try {
      await del(API.stack(name));
      setActiveName(null);
      setSelectedService(null);
      setPendingDelete(null);
      notify(`已删除项目 ${name}`);
      refresh();
    } catch (error) {
      notify(error instanceof Error ? error.message : "删除失败");
    } finally {
      setBusy(false);
    }
  }

  async function logout() {
    await postLocal(API.logout);
    onHostChange("local");
    // 退出后整页重载：Cookie 已失效，重新拉取 health 必然返回未认证，
    // 由 App 统一跳回登录页。仅靠 queryClient.clear + invalidate 在已清空的
    // 查询上不会重新请求，会停在旧的已认证界面（项目变空但不跳登录）。
    window.location.href = "/";
  }

  const toolPanelActive =
    panel === "resources" || panel === "maintenance" || panel === "diagnostics" || panel === "audit";

  function togglePanel(next: typeof panel) {
    setToolMenuOpen(false);
    setPanel((current) => (current === next ? "none" : next));
  }

  return (
    <div className="workbench">
      <header className="topbar">
        <div className="brand">
          <img className="brand-mark small" src="/favicon.svg" alt="DockerManager" />
          <div className="brand-copy">
            <strong>DockerManager</strong>
            <span className="muted small">
              {active ? `当前项目 · ${active.name}` : "Docker 项目管理"}
            </span>
          </div>
        </div>
        <div className="top-context">
          <HostSwitcher host={host} onHostChange={onHostChange} />
          <span
            className={`connection ${live.status}`}
            title={
              live.status === "live"
                ? "实时连接正常，数据自动更新"
                : "连接暂时不可用，当前显示已缓存数据，页面会自动恢复"
            }
          >
            <span className="dot" /> {connectionLabel[live.status]}
          </span>
        </div>
        <div className="top-actions">
          <button
            className={`top-action ${panel === "logs" ? "active" : ""}`}
            onClick={() => (panel === "logs" ? closePanel() : openLogs())}
          >
            <ScrollText size={15} /> <span>日志</span>
          </button>
          <button
            className={`top-action ${panel === "images" ? "active" : ""}`}
            onClick={() => togglePanel("images")}
          >
            <Images size={15} /> <span>镜像</span>
          </button>
          <div className="tool-menu" ref={toolMenuRef}>
            <button
              className={`top-action ${toolPanelActive || toolMenuOpen ? "active" : ""}`}
              aria-expanded={toolMenuOpen}
              onClick={() => setToolMenuOpen((open) => !open)}
            >
              <Wrench size={15} /> <span>工具</span> <ChevronDown size={12} />
            </button>
            {toolMenuOpen && (
              <div className="tool-menu-list">
                <div className="tool-menu-label">管理</div>
                <button onClick={() => togglePanel("resources")}>
                  <Box size={14} /> 卷与网络
                </button>
                <button onClick={() => togglePanel("maintenance")}>
                  <Wrench size={14} /> 清理与备份
                </button>
                <button onClick={() => togglePanel("diagnostics")}>
                  <Activity size={14} /> 诊断信息
                </button>
                <button onClick={() => togglePanel("audit")}>
                  <ClipboardList size={14} /> 操作审计
                </button>
                <div className="tool-menu-label">批量</div>
                <button disabled={busy || stacks.length === 0} onClick={() => { runAll("pull"); setToolMenuOpen(false); }}>
                  <RefreshCw size={14} /> 全部拉取
                </button>
                <button disabled={busy || stacks.length === 0} onClick={() => { runAll("update"); setToolMenuOpen(false); }}>
                  <RefreshCw size={14} /> 全部更新
                </button>
                <div className="tool-menu-label">会话</div>
                <button onClick={logout}>
                  <LogOut size={14} /> 退出登录
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      <div className={`workbench-body ${active ? "" : "no-selection"}`} data-mobile={mobileView}>
        <Sidebar
          stacks={stacks}
          activeName={activeName}
          selected={selected}
          search={search}
          busy={busy}
          onSearch={setSearch}
          onSelectStack={(name) => { setActiveName(name); setMobileView("editor"); }}
          onToggleCheck={(name, checked) =>
            setSelected((old) =>
              checked ? [...old.filter((n) => n !== name), name] : old.filter((n) => n !== name),
            )
          }
          onBatch={(action) => requestBatch(action)}
          onNewProject={() => {
            setCreating(true);
            setActiveName(null);
            setSelectedService(null);
            setSearch("");
            setMobileView("editor");
          }}
        />

        {creating ? (
          <NewProject
            saving={busy}
            onCancel={() => setCreating(false)}
            onCreate={(compose) => void createProject(compose, true)}
            onNotice={notify}
          />
        ) : active ? (
          <StackEditor
            stack={active}
            selectedService={selectedService}
            onServiceSelect={(service) => { setSelectedService(service); setMobileView("detail"); }}
            onStackAction={(name, action) => void runAction(name, action)}
            onServiceAction={(service, action) => {
              if (!activeName) return;
              setTaskBusy(true);
              const started = API.stackServiceAction(activeName, service, action);
              void post<TaskStarted>(started)
                .then(setTask)
                .catch((error: unknown) => {
                  setTaskBusy(false);
                  notify(error instanceof Error ? error.message : "服务操作启动失败");
                });
            }}
            onRemove={(name) => setPendingDelete(name)}
            onChanged={refresh}
            onNotice={notify}
            busy={busy || taskBusy}
          />
        ) : (
          <section className="editor-pane">
            <div className="editor-empty">
              <div>
                <img className="empty-logo" src="/favicon.svg" alt="" />
                <h2>欢迎使用 DockerManager</h2>
                <p>从左侧选择一个项目开始管理，或点击“+ 新建项目”粘贴 docker run 命令快速创建。</p>
              </div>
            </div>
          </section>
        )}

        <DetailPane
          stack={active}
          selectedService={selectedService}
          task={task}
          onSelectService={setSelectedService}
          onTaskFinished={onTaskFinished}
          onTaskClear={() => setTask(null)}
          onOpenLogHistory={(scope) => openLogs("container", scope)}
          onOpenTaskHistory={(scope) => openLogs("task", scope)}
        />
      </div>

      <nav className="mobile-tabs" aria-label="主导航">
        <button
          className={mobileView === "projects" ? "active" : ""}
          onClick={() => setMobileView("projects")}
        >
          <Box size={19} /> <span>项目</span>
        </button>
        <button
          className={mobileView === "editor" ? "active" : ""}
          onClick={() => setMobileView("editor")}
        >
          <FileText size={19} /> <span>配置</span>
        </button>
        <button
          className={mobileView === "detail" ? "active" : ""}
          onClick={() => setMobileView("detail")}
        >
          <Terminal size={19} /> <span>容器</span>
        </button>
        <button
          className={mobileView === "logs" || panel === "logs" ? "active" : ""}
          onClick={() => { setMobileView("logs"); openLogs(); }}
        >
          <ScrollText size={19} /> <span>日志</span>
        </button>
      </nav>

      {panel !== "none" && (
        <>
        <div className="side-panel-backdrop" onClick={closePanel} />
        <div className={`side-panel ${panel === "logs" ? "wide" : ""}`}>
          {panel === "audit" ? (
            <AuditPanel onClose={closePanel} onOpenHistory={() => openLogs("audit")} />
          ) : panel === "images" ? (
            <ImagesPanel onClose={closePanel} onNotice={notify} />
          ) : panel === "resources" ? (
            <ResourcesPanel onClose={closePanel} onNotice={notify} />
          ) : panel === "maintenance" ? (
            <MaintenancePanel onClose={closePanel} onNotice={notify} />
          ) : panel === "logs" ? (
            <LogsPanel
              key={`${logFocus.category ?? "all"}-${logFocus.scope ?? ""}`}
              onClose={closePanel}
              onNotice={notify}
              initialCategory={logFocus.category}
              initialScope={logFocus.scope}
            />
          ) : (
            <DiagnosticsPanel
              onClose={closePanel}
              live={live}
              snapshot={snapshot.data}
              health={health}
              onNotice={notify}
              onOpenServerLogs={() => openLogs("server")}
            />
          )}
        </div>
        </>
      )}

      {pendingDelete && (
        <ConfirmDialog
          title="删除项目"
          message={`将删除「${pendingDelete}」的项目目录和容器，镜像不会被删除。此操作不可撤销。`}
          confirmLabel="确认删除"
          danger
          busy={busy}
          requireText={pendingDelete}
          onCancel={() => setPendingDelete(null)}
          onConfirm={() => void removeStack(pendingDelete)}
        />
      )}

      {pendingBatch && (
        <ConfirmDialog
          title="批量操作"
          message={`确定对 ${pendingBatch.names.length} 个项目执行「${batchLabel[pendingBatch.action]}」吗？${pendingBatch.action === "down" ? "容器会被删除，镜像保留。" : ""}`}
          confirmLabel={batchLabel[pendingBatch.action]}
          danger={pendingBatch.action === "down" || pendingBatch.action === "stop"}
          busy={busy}
          onCancel={() => setPendingBatch(null)}
          onConfirm={() => {
            const request = pendingBatch;
            setPendingBatch(null);
            void runBatch(request.action, request.names);
          }}
        />
      )}

      {notice && <div className="toast" role="status" aria-live="polite">{notice}</div>}
    </div>
  );
}
