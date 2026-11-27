import { useEffect, useMemo, useRef, useState } from "react";
import {
  API,
  type ContainerInfo,
  type StackInfo,
  type TaskFinished,
  type TaskLine,
  type TaskStarted,
} from "@dockermanager/shared";
import { getCurrentHost, scopedUrl } from "../api";
import { TerminalView } from "./Terminal";

interface Props {
  stack: StackInfo | null;
  selectedService: string | null;
  task: TaskStarted | null;
  onSelectService: (service: string) => void;
  onTaskFinished: (result: TaskFinished) => void;
  onTaskClear: () => void;
}

interface LogLine {
  text: string;
  at: Date;
}

function LogView({ stack, service, host }: { stack: string; service: string; host: string }) {
  const [lines, setLines] = useState<LogLine[]>([]);
  const [filter, setFilter] = useState("");
  const [showTime, setShowTime] = useState(false);
  const bodyRef = useRef<HTMLPreElement>(null);
  const followRef = useRef(true);
  const lastTextRef = useRef("");
  const reconnectedRef = useRef(false);

  useEffect(() => {
    setLines([]);
    lastTextRef.current = "";
    reconnectedRef.current = false;
    followRef.current = true;
    const source = new EventSource(scopedUrl(API.logs(stack, service)));
    source.onopen = () => {
      // 重连后服务端会重新发送 --tail 历史，清空一次避免重复刷屏
      if (reconnectedRef.current) {
        setLines([]);
        lastTextRef.current = "";
        reconnectedRef.current = false;
      }
    };
    source.onerror = () => {
      reconnectedRef.current = true;
    };
    source.onmessage = (event) => {
      try {
        const text = JSON.parse(event.data) as string;
        if (!text || text === lastTextRef.current) return;
        lastTextRef.current = text;
        setLines((old) => [...old.slice(-1200), { text, at: new Date() }]);
      } catch {
        // ignore malformed frames
      }
    };
    return () => source.close();
  }, [stack, service, host]);

  const visible = useMemo(() => {
    const keyword = filter.trim().toLowerCase();
    if (!keyword) return lines;
    return lines.filter((line) => line.text.toLowerCase().includes(keyword));
  }, [lines, filter]);

  const logText = visible
    .map((line) => (showTime ? `${line.at.toLocaleTimeString("zh-CN")} ${line.text}` : line.text))
    .join("\n");

  useEffect(() => {
    const el = bodyRef.current;
    if (el && followRef.current) el.scrollTop = el.scrollHeight;
  }, [visible]);

  function download() {
    const content = lines.map((line) =>
      showTime ? `${line.at.toISOString()} ${line.text}` : line.text,
    ).join("\n");
    const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${stack}-${service}-logs.txt`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  return (
    <>
      <div className="log-toolbar">
        <input
          placeholder="过滤日志…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <button
          className={`ghost ${showTime ? "active" : ""}`}
          title="切换时间戳"
          onClick={() => setShowTime((v) => !v)}
        >
          时间
        </button>
        <button className="ghost" title="下载日志" onClick={download}>下载</button>
        <button
          className="ghost"
          title="清空当前显示"
          onClick={() => {
            setLines([]);
            lastTextRef.current = "";
          }}
        >
          清空
        </button>
      </div>
      <pre
        className="log-view"
        ref={bodyRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          followRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {visible.length === 0
          ? filter ? "没有匹配的日志行。" : "等待日志输出…"
          : logText}
      </pre>
    </>
  );
}

function TaskView({
  task,
  onFinished,
  onClear,
}: {
  task: TaskStarted;
  onFinished: (result: TaskFinished) => void;
  onClear: () => void;
}) {
  const [lines, setLines] = useState<TaskLine[]>([]);
  const [done, setDone] = useState<TaskFinished | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const actionLabel = task.action.startsWith("service:")
    ? `服务 ${task.action.slice("service:".length)}`
    : task.action;

  useEffect(() => {
    setLines([]);
    setDone(null);
    const source = new EventSource(scopedUrl(API.taskStream(task.id)));
    source.onmessage = (event) => {
      try {
        const line = JSON.parse(event.data) as TaskLine;
        setLines((old) => {
          if (line.replace) {
            if (old.length === 0) return [line];
            const next = [...old];
            next[next.length - 1] = line;
            return next;
          }
          return [...old.slice(-2000), line];
        });
      } catch {
        // ignore malformed frames
      }
    };
    source.addEventListener("done", (event) => {
      try {
        const result = JSON.parse((event as MessageEvent).data) as TaskFinished;
        setDone(result);
        onFinished(result);
      } catch {
        // ignore
      }
      source.close();
    });
    return () => source.close();
  }, [task.id, onFinished]);

  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);

  return (
    <>
      <div className="task-toolbar">
        <span className="muted small" title={`${actionLabel} · ${task.stack}`}>
          {done ? (done.ok ? "完成" : `失败（退出码 ${done.exitCode}）`) : "执行中"} · {actionLabel} · {task.stack}
        </span>
        {done && <button className="ghost" onClick={onClear}>清空</button>}
      </div>
      <div className="task-inline" ref={bodyRef}>
        {lines.length === 0 ? (
          <p className="muted">正在连接任务输出…</p>
        ) : (
          lines.map((line, index) => (
            <div key={index} className={line.stream === "stderr" ? "task-line err" : "task-line"}>
              {line.text}
            </div>
          ))
        )}
      </div>
    </>
  );
}

export function DetailPane({
  stack,
  selectedService,
  task,
  onSelectService,
  onTaskFinished,
  onTaskClear,
}: Props) {
  const [tab, setTab] = useState<"logs" | "terminal" | "task">("logs");
  const host = getCurrentHost();
  const services: ContainerInfo[] = stack?.services ?? [];

  useEffect(() => {
    if (task) setTab("task");
    else setTab((current) => (current === "task" ? "logs" : current));
  }, [task]);

  return (
    <aside className="detail-pane">
      <header className="detail-head">
        <strong>容器</strong>
        <span className="muted">{stack ? stack.name : "未选择项目"}</span>
      </header>

      <div className="container-list">
        {services.length === 0 ? (
          <span className="muted small" style={{ padding: "8px 4px" }}>
            {stack ? "这个项目暂无容器" : "请从左侧选择一个项目"}
          </span>
        ) : (
          services.map((container) => (
            <div
              key={container.id}
              className={`container-item ${(container.service || container.name) === selectedService ? "selected" : ""}`}
              onClick={() => onSelectService(container.service || container.name)}
              title={`${container.image} · ${container.ports}`}
            >
              <span className={`status-dot ${container.state}`} />
              <span className="c-name">{container.name}</span>
              <span className="c-state">{container.state}</span>
            </div>
          ))
        )}
      </div>

      <nav className="detail-tabs">
        <button className={tab === "logs" ? "active" : ""} onClick={() => setTab("logs")}>
          日志
        </button>
        <button className={tab === "terminal" ? "active" : ""} onClick={() => setTab("terminal")}>
          终端
        </button>
        <button className={tab === "task" ? "active" : ""} onClick={() => setTab("task")}>
          任务
        </button>
      </nav>

      <div className="detail-content">
        {tab === "task" ? (
          task ? (
            <TaskView task={task} onFinished={onTaskFinished} onClear={onTaskClear} />
          ) : (
            <div className="detail-empty">暂无任务输出。执行启动、拉取等操作后，这里会显示实时进度。</div>
          )
        ) : !stack ? (
          <div className="detail-empty">选择一个项目后，可在这里查看容器日志与终端。</div>
        ) : !selectedService ? (
          <div className="detail-empty">点击上方容器，查看日志或打开终端。</div>
        ) : tab === "logs" ? (
          <LogView stack={stack.name} service={selectedService} host={host} />
        ) : (
          <TerminalView host={host} stack={stack.name} service={selectedService} />
        )}
      </div>
    </aside>
  );
}
