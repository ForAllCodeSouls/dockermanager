import { useEffect, useMemo, useState } from "react";
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
} from "@dockermanager/shared";
import { apiFetch, del, post, put } from "../api";
import type { LiveState } from "../live";
import { AuditPanel, DiagnosticsPanel } from "./Panels";
import { StackEditor } from "./StackEditor";

interface Props {
  live: LiveState;
  health: HealthResponse | undefined;
}

const statusLabel: Record<string, string> = {
  running: "运行中",
  exited: "已停止",
  partial: "部分运行",
  created: "已创建",
  unknown: "未知",
  error: "异常",
};

const connectionLabel: Record<LiveState["status"], string> = {
  live: "实时连接",
  connecting: "正在连接",
  reconnecting: "重连中",
  offline: "网络离线",
};

export function Dashboard({ live, health }: Props) {
  const queryClient = useQueryClient();
  const snapshot = useQuery({
    queryKey: ["snapshot"],
    queryFn: () => apiFetch<Snapshot>(API.snapshot),
  });
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [active, setActive] = useState<StackInfo | null>(null);
  const [panel, setPanel] = useState<"none" | "audit" | "diagnostics">("none");
  const [notice, setNotice] = useState("");
  const [newName, setNewName] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [busy, setBusy] = useState(false);

  const stacks = useMemo(() => {
    const all = snapshot.data?.stacks ?? [];
    const keyword = search.trim().toLowerCase();
    return keyword ? all.filter((s) => s.name.toLowerCase().includes(keyword)) : all;
  }, [snapshot.data, search]);

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

  function refresh() {
    void queryClient.invalidateQueries({ queryKey: ["snapshot"] });
  }

  async function runAction(name: string, action: StackAction) {
    setBusy(true);
    try {
      const result = await post<ActionResult>(API.stackAction(name, action));
      notify(`${name} · ${action}：${result.ok ? "成功" : "失败"} ${result.message.slice(0, 100)}`);
      refresh();
    } catch (error) {
      notify(error instanceof Error ? error.message : "操作失败");
    } finally {
      setBusy(false);
    }
  }

  async function runBatch(action: StackAction) {
    if (selected.length === 0) return;
    setBusy(true);
    try {
      const result = await post<{ results: ActionResult[] }>(API.batch, {
        names: selected,
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

  async function createStack() {
    if (!newName.trim()) return;
    setBusy(true);
    try {
      await put(API.stack(newName.trim()), {
        compose: 'services:\n  app:\n    image: nginx:alpine\n    ports:\n      - "8080:80"\n',
        env: "",
      });
      notify(`已创建 ${newName.trim()}，请检查并保存配置`);
      setShowCreate(false);
      setNewName("");
      refresh();
    } catch (error) {
      notify(error instanceof Error ? error.message : "创建失败");
    } finally {
      setBusy(false);
    }
  }

  async function removeStack(name: string) {
    if (!window.confirm(`确认删除栈 ${name}？该操作会移除栈目录。`)) return;
    try {
      await del(API.stack(name));
      setActive(null);
      notify(`已删除 ${name}`);
      refresh();
    } catch (error) {
      notify(error instanceof Error ? error.message : "删除失败");
    }
  }

  async function logout() {
    await post(API.logout);
    await queryClient.invalidateQueries({ queryKey: ["health"] });
  }

  const liveEnough = live.status === "live";

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark small">SD</span>
          <div>
            <strong>DockerManager</strong>
            <span className="muted">Compose 管理器</span>
          </div>
        </div>
        <div className="top-actions">
          <span className={`connection ${live.status}`}>
            <span className="dot" /> {connectionLabel[live.status]}
            {!liveEnough && <em> · 显示缓存数据</em>}
          </span>
          <button className="ghost" onClick={refresh} disabled={snapshot.isFetching}>刷新</button>
          <button className="ghost" onClick={() => setPanel(panel === "diagnostics" ? "none" : "diagnostics")}>诊断</button>
          <button className="ghost" onClick={() => setPanel(panel === "audit" ? "none" : "audit")}>审计</button>
          <button className="ghost" onClick={logout}>退出</button>
        </div>
      </header>

      {!snapshot.data?.engine.reachable && (
        <div className="engine-warning">
          Docker 引擎不可达：{snapshot.data?.engine.message ?? "正在检测…"}。界面仍可读取已缓存的栈配置。
        </div>
      )}

      <main className="main">
        <div className="toolbar">
          <input
            className="search"
            placeholder="搜索栈…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <div className="batch-bar">
            <span className="muted">已选 {selected.length}</span>
            {(["start", "stop", "restart", "update"] as StackAction[]).map((action) => (
              <button key={action} className="ghost" disabled={busy || selected.length === 0} onClick={() => runBatch(action)}>
                {action === "start" ? "批量启动" : action === "stop" ? "批量停止" : action === "restart" ? "批量重启" : "批量更新"}
              </button>
            ))}
          </div>
          <button className="primary" onClick={() => setShowCreate(true)}>新建栈</button>
        </div>

        {showCreate && (
          <div className="inline-create">
            <input
              autoFocus
              placeholder="栈名称（字母、数字、_ - .）"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
            />
            <button className="primary" onClick={createStack} disabled={busy}>创建</button>
            <button className="ghost" onClick={() => setShowCreate(false)}>取消</button>
          </div>
        )}

        {snapshot.isLoading && <p className="muted">加载快照…</p>}
        {snapshot.error && <div className="inline-error">{String(snapshot.error)}</div>}

        <div className="stack-grid">
          {stacks.map((stack) => (
            <article className="stack-card" key={stack.name}>
              <label className="card-check">
                <input
                  type="checkbox"
                  checked={selected.includes(stack.name)}
                  onChange={(e) =>
                    setSelected((old) =>
                      e.target.checked ? [...old, stack.name] : old.filter((n) => n !== stack.name),
                    )
                  }
                />
              </label>
              <div className="card-main" onClick={() => setActive(stack)}>
                <div className="card-title">
                  <strong>{stack.name}</strong>
                  <span className={`status ${stack.status}`}>{statusLabel[stack.status] ?? stack.status}</span>
                </div>
                <div className="muted small">
                  {stack.services.length} 个服务 · 更新于 {new Date(stack.composeModifiedAt).toLocaleString("zh-CN")}
                </div>
                <div className="service-list">
                  {stack.services.map((c) => (
                    <span key={c.id} className={c.state === "running" ? "chip ok" : "chip"}>
                      {c.name}
                    </span>
                  ))}
                </div>
              </div>
              <div className="card-actions">
                <button className="ghost" disabled={busy} onClick={() => runAction(stack.name, "start")}>启动</button>
                <button className="ghost" disabled={busy} onClick={() => runAction(stack.name, "stop")}>停止</button>
                <button className="ghost" disabled={busy} onClick={() => runAction(stack.name, "restart")}>重启</button>
                <button className="ghost danger" onClick={() => removeStack(stack.name)}>删除</button>
              </div>
            </article>
          ))}
          {stacks.length === 0 && !snapshot.isLoading && <p className="muted empty">暂无栈。点击“新建栈”开始。</p>}
        </div>
      </main>

      {panel !== "none" && (
        <div className="side-panel">
          <button className="ghost close-panel" onClick={() => setPanel("none")}>关闭</button>
          {panel === "audit" ? <AuditPanel /> : (
            <DiagnosticsPanel live={live} snapshot={snapshot.data} health={health} onNotice={notify} />
          )}
        </div>
      )}

      {active && (
        <StackEditor
          stack={active}
          onClose={() => setActive(null)}
          onChanged={refresh}
          onNotice={notify}
        />
      )}
      {notice && <div className="toast">{notice}</div>}
    </div>
  );
}
