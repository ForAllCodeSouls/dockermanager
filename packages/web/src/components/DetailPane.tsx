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

/** docker compose 输出着色：[] 蓝色、✓ 绿色、状态词分色、行尾耗时蓝色靠右 */
function colorizeTaskLine(text: string, isError: boolean): { body: string; time: string } {
  let main = text;
  let time = "";
  const timed = main.match(/\s+([\d.]+(?:ms|s|m|h))\s*$/);
  if (timed && timed.index !== undefined) {
    time = timed[1];
    main = main.slice(0, timed.index);
  }
  const escapeHtml = (value: string) =>
    value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const pattern =
    /(\[[+-]\]|✔|✓|✘|\b(?:Pulling|Pulled|Running|Recreated|Created|Started|Stopped|Removed|Downloading|Downloaded|Waiting|Building|Built|Error|Failed|error|failed)\b|\d+\/\d+)/g;
  let body = "";
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(main)) !== null) {
    body += escapeHtml(main.slice(last, match.index));
    const token = match[0];
    let cls = "";
    if (token === "[+]" || token === "[-]") cls = "tok-info";
    else if (token === "✔" || token === "✓") cls = "tok-ok";
    else if (token === "✘") cls = "tok-err";
    else if (/^(Pulled|Recreated|Created|Started|Stopped|Removed|Downloaded|Built)$/.test(token)) cls = "tok-ok";
    else if (/^(Pulling|Running|Downloading|Waiting|Building)$/.test(token)) cls = "tok-info";
    else if (/^(Error|Failed|error|failed)$/.test(token)) cls = "tok-err";
    else if (/^\d+\/\d+$/.test(token)) cls = "tok-info";
    body += cls ? `<span class="${cls}">${escapeHtml(token)}</span>` : escapeHtml(token);
    last = match.index + token.length;
  }
  body += escapeHtml(main.slice(last));
  if (isError && !body.includes("tok-err")) {
    body = `<span class="tok-err">${body}</span>`;
  }
  return { body, time };
}

/** 日志按级别着色：错误红、警告黄、信息蓝 */
function logLevelClass(text: string): string {
  if (/\b(ERROR|FATAL|CRITICAL|Exception|Traceback|panic|错误|失败)\b/i.test(text)) return "log-error";
  if (/\b(WARN|WARNING|warn|warning|警告)\b/i.test(text)) return "log-warn";
  if (/\b(INFO|DEBUG|info|debug)\b/i.test(text)) return "log-info";
  return "";
}

/** 去掉 docker compose logs 给每行加的 "容器名 | " 前缀 */
function stripLogPrefix(text: string): string {
  return text.replace(/^[\w.\-]+\s+\|\s?/, "");
}

const ANSI_FG: Record<number, string> = {
  30: "#1a1a1a", 31: "#f2636b", 32: "#5fd39a", 33: "#f5b74e",
  34: "#7dcfff", 35: "#c792ea", 36: "#56d4dd", 37: "#d7e0ef",
  90: "#7a8699", 91: "#ff7b7b", 92: "#7ee2a8", 93: "#ffd479",
  94: "#8ab4ff", 95: "#d8a6ff", 96: "#7fe1ea", 97: "#ffffff",
};

/** 把 ANSI 转义序列转成内联样式的 HTML，同时做 HTML 转义，保留容器原始的彩色输出 */
function ansiToHtml(text: string): string {
  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  let html = "";
  let style = "";
  let last = 0;
  const re = /\x1b\[([0-9;]*)m/g;
  const flush = (to: number) => {
    const chunk = text.slice(last, to);
    if (chunk) html += style ? `<span style="${style}">${esc(chunk)}</span>` : esc(chunk);
  };
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    flush(match.index);
    const codes = match[1] ? match[1].split(";").map(Number) : [0];
    for (const code of codes) {
      if (code === 0) style = "";
      else if (code === 1) style += "font-weight:bold;";
      else if (ANSI_FG[code]) style = style.replace(/color:[^;]+;?/, "") + `color:${ANSI_FG[code]};`;
    }
    last = match.index + match[0].length;
  }
  flush(text.length);
  return html;
}

function LogView({ stack, service, host }: { stack: string; service: string; host: string }) {
  const [lines, setLines] = useState<LogLine[]>([]);
  const [filter, setFilter] = useState("");
  const [showTime, setShowTime] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
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
    return lines.filter((line) => stripLogPrefix(line.text).toLowerCase().includes(keyword));
  }, [lines, filter]);

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
      <div
        className="log-view"
        ref={bodyRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          followRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {visible.length === 0 ? (
          <div className="log-placeholder">{filter ? "没有匹配的日志行。" : "等待日志输出…"}</div>
        ) : (
          visible.map((line, index) => {
            const body = stripLogPrefix(line.text);
            return (
              <div key={index} className={`log-line ${logLevelClass(body)}`}>
                {showTime && <span className="log-time">{line.at.toLocaleTimeString("zh-CN")}</span>}
                <span
                  className="log-body"
                  dangerouslySetInnerHTML={{ __html: ansiToHtml(body) }}
                />
              </div>
            );
          })
        )}
      </div>
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
          lines.map((line, index) => {
            const colored = colorizeTaskLine(line.text, line.stream === "stderr");
            return (
              <div
                key={index}
                className={`task-line ${line.stream === "stderr" ? "err" : ""}`}
              >
                <span className="task-line-body" dangerouslySetInnerHTML={{ __html: colored.body }} />
                {colored.time && <span className="task-line-time">{colored.time}</span>}
              </div>
            );
          })
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
