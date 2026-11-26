import { useEffect, useRef, useState } from "react";
import { API, type TaskFinished, type TaskLine, type TaskStarted } from "@dockermanager/shared";
import { scopedUrl } from "../api";

interface Props {
  task: TaskStarted;
  onClose: () => void;
  onFinished: (result: TaskFinished) => void;
}

export function TaskProgress({ task, onClose, onFinished }: Props) {
  const actionLabel = task.action.startsWith("service:")
    ? `服务 ${task.action.slice("service:".length)}`
    : task.action;
  const [lines, setLines] = useState<TaskLine[]>([]);
  const [done, setDone] = useState<TaskFinished | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setLines([]);
    setDone(null);
    const source = new EventSource(scopedUrl(API.taskStream(task.id)));
    source.onmessage = (event) => {
      try {
        const line = JSON.parse(event.data) as TaskLine;
        setLines((old) => [...old.slice(-2000), line]);
      } catch {
        // ignore malformed
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
    source.onerror = () => {
      // SSE 断线自动重连；完成后由 done 事件关闭
    };
    return () => source.close();
  }, [task.id, onFinished]);

  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);

  return (
    <div className="drawer-backdrop" onClick={done ? onClose : undefined}>
      <aside className="drawer task-drawer" onClick={(e) => e.stopPropagation()}>
        <header className="drawer-head">
          <div>
            <h2>{actionLabel} · {task.stack}</h2>
            <span className={`status ${done ? (done.ok ? "running" : "error") : "partial"}`}>
              {done ? (done.ok ? "完成" : `失败 (${done.exitCode})`) : "执行中"}
            </span>
          </div>
          <button className="ghost" onClick={onClose} disabled={!done}>关闭</button>
        </header>
        <div className="task-output" ref={bodyRef}>
          {lines.length === 0 && <p className="muted">正在连接任务输出…</p>}
          {lines.map((line, index) => (
            <div key={index} className={line.stream === "stderr" ? "task-line err" : "task-line"}>
              {line.text}
            </div>
          ))}
        </div>
      </aside>
    </div>
  );
}
