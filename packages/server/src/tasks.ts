import { spawn } from "node:child_process";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { TaskFinished, TaskLine, TaskStarted } from "@dockermanager/shared";
import { config } from "./config.js";
import { composeFileFor } from "./docker.js";
import { eventBus } from "./event-bus.js";
import { appendAudit } from "./store.js";

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

  const composeFile = composeFileFor(stack);
  const emit = (stream: TaskLine["stream"], text: string) => {
    if (!text) return;
    // 拆分多行，去掉 docker 进度回车的控制字符但保留可读内容
    for (const raw of text.split("\n")) {
      const line = raw.replace(/\r/g, "");
      if (!line.trim()) continue;
      const entry: TaskLine = { stream, text: line.slice(0, 4000) };
      task.lines.push(entry);
      if (task.lines.length > 5000) task.lines.shift();
      for (const listener of task.listeners) {
        try {
          listener(entry);
        } catch {
          // ignore broken listener
        }
      }
    }
  };

  void (async () => {
    let exitCode = 0;
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

    task.done = true;
    task.exitCode = exitCode;
    task.ok = exitCode === 0;
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
