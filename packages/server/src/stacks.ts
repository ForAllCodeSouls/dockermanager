import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import {
  isValidStackName,
  type ActionResult,
  type BatchRequest,
  type ComposePayload,
  type ContainerInfo,
  type Snapshot,
  type StackAction,
  type StackInfo,
  type StackStatus,
} from "@stackdeck/shared";
import { config } from "./config.js";
import {
  composeFileFor,
  containersForProject,
  engineInfo,
  runCompose,
} from "./docker.js";
import { eventBus } from "./event-bus.js";
import { appendAudit } from "./store.js";

function determineStatus(containers: ContainerInfo[]): StackStatus {
  if (containers.length === 0) return "unknown";
  const running = containers.filter((c) => c.state === "running").length;
  if (running === containers.length) return "running";
  if (running === 0) return "exited";
  return "partial";
}

function actionArgs(action: StackAction): string[][] {
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
  }
}

export class StackManager {
  async snapshot(): Promise<Snapshot> {
    const engine = await engineInfo();
    const stacks = await this.list();
    return {
      seq: eventBus.currentSeq,
      generatedAt: new Date().toISOString(),
      stacks,
      engine,
    };
  }

  async list(): Promise<StackInfo[]> {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(config.stacksDir, { withFileTypes: true });
    } catch {
      return [];
    }
    const candidates = entries
      .filter((entry) => entry.isDirectory() && isValidStackName(entry.name))
      .map((entry) => entry.name);

    return Promise.all(
      candidates.map(async (name): Promise<StackInfo | null> => {
        const composeFile = composeFileFor(name);
        if (!composeFile) return null;
        const dir = path.join(config.stacksDir, name);
        const envPath = path.join(dir, ".env");
        try {
          const containers = await containersForProject(name);
          return {
            name,
            status: determineStatus(containers),
            services: containers,
            composeModifiedAt: fs.statSync(composeFile).mtime.toISOString(),
            envModifiedAt: fs.existsSync(envPath)
              ? fs.statSync(envPath).mtime.toISOString()
              : null,
            error: null,
          };
        } catch (error) {
          return {
            name,
            status: "error",
            services: [],
            composeModifiedAt: new Date().toISOString(),
            envModifiedAt: null,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }),
    ).then((items) => items.filter((item): item is StackInfo => item !== null));
  }

  read(name: string): { compose: string; env: string } {
    this.assertName(name);
    const composeFile = composeFileFor(name);
    if (!composeFile) throw new Error("未找到 compose 文件");
    const envPath = path.join(config.stacksDir, name, ".env");
    return {
      compose: fs.readFileSync(composeFile, "utf8"),
      env: fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "",
    };
  }

  write(name: string, payload: ComposePayload): void {
    this.assertName(name);
    if (!payload.compose?.trim()) throw new Error("compose 内容不能为空");
    try {
      YAML.parse(payload.compose);
    } catch (error) {
      throw new Error(`YAML 解析失败：${error instanceof Error ? error.message : String(error)}`);
    }
    const dir = path.join(config.stacksDir, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "compose.yaml"), payload.compose, "utf8");
    if (payload.env !== undefined) {
      fs.writeFileSync(path.join(dir, ".env"), payload.env, "utf8");
    }
    eventBus.publish("stack.upserted", { name });
    appendAudit({ actor: "admin", action: "stack.write", target: name, detail: "保存 compose 配置", ok: true });
  }

  remove(name: string): void {
    this.assertName(name);
    const dir = path.join(config.stacksDir, name);
    if (!fs.existsSync(dir)) throw new Error("栈不存在");
    eventBus.publish("stack.deleted", { name });
    fs.rmSync(dir, { recursive: true, force: true });
    appendAudit({ actor: "admin", action: "stack.delete", target: name, detail: "删除栈目录", ok: true });
  }

  async action(name: string, action: StackAction): Promise<ActionResult> {
    this.assertName(name);
    if (!composeFileFor(name)) {
      return { name, ok: false, message: "未找到 compose 文件" };
    }
    let output = "";
    let ok = true;
    for (const args of actionArgs(action)) {
      const result = await runCompose(name, args);
      output += `${result.output}\n`;
      if (!result.ok) {
        ok = false;
        break;
      }
    }
    eventBus.publish("stack.status", { name, action, ok });
    appendAudit({
      actor: "admin",
      action: `stack.${action}`,
      target: name,
      detail: output.slice(0, 500),
      ok,
    });
    return { name, ok, message: output.trim().slice(0, 2000) };
  }

  async batch(request: BatchRequest): Promise<ActionResult[]> {
    const names = [...new Set(request.names)].filter(isValidStackName);
    return Promise.all(names.map((name) => this.action(name, request.action)));
  }

  private assertName(name: string): void {
    if (!isValidStackName(name)) throw new Error("非法的栈名称");
  }
}

export const stacks = new StackManager();
