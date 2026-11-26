import { useEffect, useMemo, useRef, useState } from "react";
import type { ContainerInfo, StackInfo } from "@dockermanager/shared";
import { getCurrentHost, scopedUrl } from "../api";
import { API } from "@dockermanager/shared";
import { TerminalView } from "./Terminal";

interface Props {
  stack: StackInfo | null;
  selectedService: string | null;
  onSelectService: (service: string) => void;
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

  useEffect(() => {
    setLines([]);
    followRef.current = true;
    const source = new EventSource(scopedUrl(API.logs(stack, service)));
    source.onmessage = (event) => {
      try {
        const line = JSON.parse(event.data) as string;
        setLines((old) => [...old.slice(-1200), { text: line, at: new Date() }]);
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
        <button className="ghost" title="清空当前显示" onClick={() => setLines([])}>清空</button>
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

export function DetailPane({ stack, selectedService, onSelectService }: Props) {
  const [tab, setTab] = useState<"terminal" | "logs">("logs");
  const host = getCurrentHost();
  const services: ContainerInfo[] = stack?.services ?? [];
  const selectedContainer = services.find(
    (c) => (c.service || c.name) === selectedService,
  );

  return (
    <aside className="detail-pane">
      <header className="detail-head">
        <strong>容器</strong>
        <span className="muted">{stack ? stack.name : "未选择栈"}</span>
      </header>

      <div className="container-list">
        {services.length === 0 ? (
          <span className="muted small" style={{ padding: "8px 4px" }}>
            {stack ? "该栈暂无容器" : "请从左侧选择一个栈"}
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
      </nav>

      <div className="detail-content">
        {!stack ? (
          <div className="detail-empty">选择一个栈后，可在这里查看容器日志与终端。</div>
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
