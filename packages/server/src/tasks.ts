import { spawn } from "node:child_process";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { TaskFinished, TaskLine, TaskStarted } from "@dockermanager/shared";
import { config } from "./config.js";
import { composeFileFor } from "./docker.js";
import { eventBus } from "./event-bus.js";
import { appendLog, stampForDate } from "./log-store.js";
import { appendAudit } from "./store.js";
import { acquireStack, releaseStack } from "./task-lock.js";

interface Task {
  id: string;
  stack: string;
  action: string;
  lines: TaskLine[];
  done: boolean;
  ok: boolean;
  exitCode: number | null;
  startedAt: number;
  listeners: Set<(line: TaskLine) => void>;
  finishListeners: Set<(result: TaskFinished) => void>;
}

const tasks = new Map<string, Task>();
const MAX_TASKS = 50;
const TASK_TTL_MS = 1000 * 60 * 30;

function trimTasks(): void {
  const now = Date.now();
  for (const [id, task] of tasks) {
    if (task.done && now - task.startedAt > TASK_TTL_MS) tasks.delete(id);
  }
  while (tasks.size > MAX_TASKS) {
    const oldest = [...tasks.entries()].sort((a, b) => a[1].startedAt - b[1].startedAt)[0];
    if (!oldest || !oldest[1].done) break;
    tasks.delete(oldest[0]);
  }
}

export function getTask(id: string): Task | undefined {
  return tasks.get(id);
}

export interface StartTaskOptions {
  stack: string;
  action: string;
  args: string[][];
}

/** 启动一串 compose 命令，返回任务 ID；输出实时缓存并广播给订阅者。 */
export function startTask({ stack, action, args }: StartTaskOptions): TaskStarted {
  trimTasks();
  // 服务端按项目互斥：同一项目已有未结束任务时直接拒绝，避免多端并发把 compose 命令打乱。
  acquireStack(stack, action);
  const id = randomUUID();
  const task: Task = {
    id,
    stack,
    action,
    lines: [],
    done: false,
    ok: true,
    exitCode: null,
    startedAt: Date.now(),
    listeners: new Set(),
    finishListeners: new Set(),
  };
  tasks.set(id, task);

  // 任务输出单独落盘：scope 为「项目/动作」，例如 demo/start、demo/service:restart app
  const taskScope = `${stack}/${action.replace(/[^\w.\-]/g, "_")}`;
  const taskStamp = stampForDate(new Date(task.startedAt));
  appendLog("task", taskScope, `任务 ${id} · ${action} · 开始`, taskStamp);

  const composeFile = composeFileFor(stack);
  const pending: Record<TaskLine["stream"], string> = { stdout: "", stderr: "" };
  const push = (stream: TaskLine["stream"], text: string, replace: boolean) => {
    const clean = text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "").trim();
    if (!clean) return;
    const entry: TaskLine = { stream, text: clean.slice(0, 4000), replace };
    task.lines.push(entry);
    if (task.lines.length > 5000) task.lines.shift();
    // \r 刷新的中间进度不落盘，只保存最终行，避免日志文件被进度条刷屏
    if (!replace) {
      appendLog("task", taskScope, `${stream === "stderr" ? "[错误] " : ""}${clean}`, taskStamp);
    }
    for (const listener of task.listeners) {
      try {
        listener(entry);
      } catch {
        // ignore broken listener
      }
    }
  };
  // docker pull 用 \r 原地刷新进度；按终端语义处理，\r 覆盖上一行，\n 才产生新行。
  const emit = (stream: TaskLine["stream"], text: string) => {
    if (!text) return;
    const buffer = (pending[stream] + text).replace(/\r\n/g, "\n");
    pending[stream] = "";
    let current = "";
    for (const char of buffer) {
      if (char === "\r" || char === "\n") {
        if (current.trim()) push(stream, current, char === "\r");
        current = "";
      } else {
        current += char;
      }
    }
    pending[stream] = current;
  };
  const flushPending = () => {
    for (const stream of ["stdout", "stderr"] as const) {
      if (pending[stream].trim()) push(stream, pending[stream], false);
      pending[stream] = "";
    }
  };

  void (async () => {
    let exitCode = 0;
    try {
      if (!composeFile) {
        emit("stderr", "未找到 compose 文件");
        exitCode = 1;
      } else {
        for (const argv of args) {
          exitCode = await new Promise<number>((resolve) => {
            const child = spawn(
              "docker",
              ["compose", "-f", composeFile, "-p", stack, ...argv],
              {
                cwd: path.dirname(composeFile),
                env: { ...process.env, COMPOSE_INTERACTIVE_NO_CLI: "1" },
                stdio: ["ignore", "pipe", "pipe"],
              },
            );
            child.stdout?.on("data", (chunk: Buffer) => emit("stdout", chunk.toString("utf8")));
            child.stderr?.on("data", (chunk: Buffer) => emit("stderr", chunk.toString("utf8")));
            child.on("error", (error) => {
              emit("stderr", error.message);
              resolve(1);
            });
            child.on("close", (code) => resolve(code ?? 1));
          });
          if (exitCode !== 0) break;
        }
      }
    } catch (error) {
      emit("stderr", error instanceof Error ? error.message : String(error));
      exitCode = 1;
    } finally {
      flushPending();
      task.done = true;
      task.exitCode = exitCode;
      task.ok = exitCode === 0;
      // 无论成功失败都释放项目锁，避免异常时锁永久占用。
      releaseStack(stack);
    }

    appendLog(
      "task",
      taskScope,
      `任务 ${id} · ${exitCode === 0 ? "完成" : `失败（退出码 ${exitCode}）`}`,
      taskStamp,
    );
    const result: TaskFinished = { ok: task.ok, exitCode };
    for (const listener of task.finishListeners) {
      try {
        listener(result);
      } catch {
        // ignore
      }
    }
    eventBus.publish("stack.status", { name: stack, action, ok: task.ok, taskId: id });
    appendAudit({
      actor: "admin",
      action: `stack.${action}`,
      target: stack,
      detail: `任务 ${id} 退出码 ${exitCode}`,
      ok: task.ok,
    });
  })();

  return { id, stack, action };
}

export function subscribeTask(
  id: string,
  onLine: (line: TaskLine) => void,
  onFinish: (result: TaskFinished) => void,
): (() => void) | null {
  const task = tasks.get(id);
  if (!task) return null;
  task.listeners.add(onLine);
  task.finishListeners.add(onFinish);
  return () => {
    task.listeners.delete(onLine);
    task.finishListeners.delete(onFinish);
  };
}

export function taskSnapshot(id: string): { lines: TaskLine[]; task: Task } | null {
  const task = tasks.get(id);
  return task ? { lines: [...task.lines], task } : null;
}

export function actionArgsForTask(action: string): string[][] {
  switch (action) {
    case "start":
      return [["up", "-d", "--remove-orphans"]];
    case "stop":
      return [["stop"]];
    case "restart":
      return [["restart"]];
    case "down":
      return [["down", "--remove-orphans"]];
    case "pull":
      return [["pull"]];
    case "update":
      return [["pull"], ["up", "-d", "--remove-orphans"]];
    default:
      return [];
  }
}
