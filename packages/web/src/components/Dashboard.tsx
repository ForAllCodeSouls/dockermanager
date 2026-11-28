import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  API,
  type ActionResult,
  type BatchRequest,
  type HealthResponse,
  type ServerEvent,
  type Snapshot,
  type StackAction,
  type StackInfo,
  type TaskFinished,
  type TaskStarted,
} from "@dockermanager/shared";
import { apiFetch, del, getCurrentHost, post, postLocal, put, setCurrentHost } from "../api";
import type { LiveState } from "../live";
import { AuditPanel, DiagnosticsPanel } from "./Panels";
import { ImagesPanel } from "./ImagesPanel";
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
}

const connectionLabel: Record<LiveState["status"], string> = {
  live: "实时连接",
  connecting: "正在连接",
  reconnecting: "重连中",
  offline: "网络离线",
};

export function Dashboard({ live, health }: Props) {
  const queryClient = useQueryClient();
  const host = getCurrentHost();
  const snapshot = useQuery({
    queryKey: ["snapshot", host],
    queryFn: () => apiFetch<Snapshot>(API.snapshot),
  });
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [activeName, setActiveName] = useState<string | null>(null);
  const [selectedService, setSelectedService] = useState<string | null>(null);
  const [panel, setPanel] = useState<"none" | "audit" | "diagnostics" | "images">("none");
  const [notice, setNotice] = useState("");
  const [creating, setCreating] = useState(false);
  const [task, setTask] = useState<TaskStarted | null>(null);
  const [busy, setBusy] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);

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

  const onTaskFinished = useCallback(
    (result: TaskFinished) => {
      notify(result.ok ? "操作完成" : `操作失败（退出码 ${result.exitCode}）`);
      refresh();
    },
    [refresh],
  );

  async function runAction(name: string, action: StackAction) {
    try {
      const started = await post<TaskStarted>(API.stackAction(name, action));
      setTask(started);
    } catch (error) {
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

  function runAll(action: StackAction) {
    // “全部”针对当前主机的所有项目，而不是搜索框过滤后的结果。
    const allNames = (snapshot.data?.stacks ?? []).map((item) => item.name);
    void runBatch(action, allNames);
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
    setCurrentHost("local");
    queryClient.clear();
    await queryClient.invalidateQueries({ queryKey: ["health"] });
  }

  return (
    <div className="workbench">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark small">DM</span>
          <div>
            <strong>DockerManager</strong>
            <span className="muted small">Docker 项目管理</span>
          </div>
        </div>
        <div className="top-actions">
          <HostSwitcher onHostChanged={() => { setActiveName(null); setSelectedService(null); refresh(); }} />
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
          <button className="ghost" onClick={() => runAll("pull")} disabled={busy || stacks.length === 0}>
            全部拉取
          </button>
          <button className="ghost" onClick={() => runAll("update")} disabled={busy || stacks.length === 0}>
            全部更新
          </button>
          <button className="ghost" onClick={() => setPanel(panel === "images" ? "none" : "images")}>镜像</button>
          <button className="ghost" onClick={() => setPanel(panel === "diagnostics" ? "none" : "diagnostics")}>诊断</button>
          <button className="ghost" onClick={() => setPanel(panel === "audit" ? "none" : "audit")}>审计</button>
          <button className="ghost" onClick={logout}>退出</button>
        </div>
      </header>

      <div className={`workbench-body ${active ? "" : "no-selection"}`}>
        <Sidebar
          stacks={stacks}
          activeName={activeName}
          selected={selected}
          search={search}
          busy={busy}
          onSearch={setSearch}
          onSelectStack={(name) => setActiveName(name)}
          onToggleCheck={(name, checked) =>
            setSelected((old) =>
              checked ? [...old.filter((n) => n !== name), name] : old.filter((n) => n !== name),
            )
          }
          onBatch={(action) => void runBatch(action)}
          onNewProject={() => {
            setCreating(true);
            setActiveName(null);
            setSelectedService(null);
            setSearch("");
          }}
          onOpenPanel={(p) => setPanel(p)}
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
            onServiceSelect={setSelectedService}
            onStackAction={(name, action) => void runAction(name, action)}
            onServiceAction={(service, action) => {
              if (!activeName) return;
              const started = API.stackServiceAction(activeName, service, action);
              void post<TaskStarted>(started)
                .then(setTask)
                .catch((error: unknown) =>
                  notify(error instanceof Error ? error.message : "服务操作启动失败"),
                );
            }}
            onRemove={(name) => setPendingDelete(name)}
            onChanged={refresh}
            onNotice={notify}
          />
        ) : (
          <section className="editor-pane">
            <div className="editor-empty">
              <div>
                <div className="empty-logo">DM</div>
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
        />
      </div>

      {panel !== "none" && (
        <div className="side-panel">
          <button className="ghost close-panel" onClick={() => setPanel("none")}>关闭</button>
          {panel === "audit" ? (
            <AuditPanel />
          ) : panel === "images" ? (
            <ImagesPanel onNotice={notify} />
          ) : (
            <DiagnosticsPanel live={live} snapshot={snapshot.data} health={health} onNotice={notify} />
          )}
        </div>
      )}

      {pendingDelete && (
        <ConfirmDialog
          title="删除项目"
          message={`确定删除「${pendingDelete}」吗？项目目录和其中的配置文件会被移除，此操作不可撤销。`}
          confirmLabel="删除"
          danger
          busy={busy}
          onCancel={() => setPendingDelete(null)}
          onConfirm={() => void removeStack(pendingDelete)}
        />
      )}

      {notice && <div className="toast">{notice}</div>}
    </div>
  );
}
