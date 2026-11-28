import { spawn } from "node:child_process";
import path from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  API,
  type BackupRestoreRequest,
  type BatchRequest,
  type ComposePayload,
  type ContainerFileWrite,
  type ConvertRunRequest,
  type ConvertRunResponse,
  type DebugTokenResponse,
  type DiagnosticsBundle,
  type HealthResponse,
  type ImagePruneRequest,
  type NetworkConnectRequest,
  type NetworkCreate,
  type PruneRequest,
  type VolumeCreate,
  type ImageRemoveRequest,
  type LogCategory,
  type LogRetention,
  type LoginRequest,
  type ServerEvent,
  type SetupRequest,
  type StackAction,
  type SystemVersion,
  type UpdateStatus,
  isValidStackName,
} from "@dockermanager/shared";
import {
  clearSessionCookie,
  createDebugToken,
  createToken,
  hashPassword,
  isAuthenticated,
  setSessionCookie,
  verifyDebugToken,
  verifyPassword,
} from "./auth.js";
import { config } from "./config.js";
import { convertRunCommand } from "./convert-run.js";
import {
  deleteContainerFile,
  inspectContainer,
  listContainerFiles,
  readContainerFile,
  writeContainerFile,
} from "./container-files.js";
import { composeFileFor } from "./docker.js";
import { eventBus } from "./event-bus.js";
import { hostsResponse } from "./hosts.js";
import { inspectImages, pruneImages, removeImages } from "./images.js";
import {
  cleanupLogs,
  deleteLogFile,
  getLogSettings,
  listLogFiles,
  readLogFile,
  readLogFileRaw,
  updateLogSettings,
} from "./log-store.js";
import { connectNetwork, createNetwork, disconnectNetwork, inspectNetworks, pruneNetworks, removeNetwork } from "./networks.js";
import { registerProxy } from "./proxy.js";
import { exportBackup, restoreBackup, systemPrune } from "./system.js";
import { currentStats } from "./stats.js";
import { appendAudit, needsSetup, readAudit, setPassword } from "./store.js";
import { stacks } from "./stacks.js";
import { actionArgsForTask, startTask, subscribeTask, taskSnapshot } from "./tasks.js";
import { TaskBusyError } from "./task-lock.js";
import { applyUpdate, checkForUpdate, helperDiagnostics, selfLogs, updateStatus } from "./updater.js";
import { createVolume, inspectVolumes, pruneVolumes, removeVolume } from "./volumes.js";
import { version } from "./version.js";

const actions: StackAction[] = ["start", "stop", "restart", "update", "down", "pull"];
const serviceActions = ["start", "stop", "restart", "pull"] as const;
type ServiceActionName = (typeof serviceActions)[number];

function fail(reply: FastifyReply, status: number, message: string) {
  return reply.code(status).send({ error: message });
}

function writeEvent(reply: FastifyReply, event: ServerEvent): void {
  reply.raw.write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  // 多主机代理需在认证 hook 之前注册，由代理自身校验 agent token
  registerProxy(app);

  app.addHook("onRequest", async (request, reply) => {
    const pathname = request.url.split("?")[0];
    if (!pathname?.startsWith("/api/")) return;
    if (
      pathname === API.health ||
      pathname === API.systemVersion ||
      pathname === API.login ||
      pathname === API.setup
    ) {
      return;
    }
    if (
      pathname === API.systemDiagnostics ||
      pathname === API.systemLogs ||
      pathname === API.systemUpdate
    ) {
      const token = (request.query as { t?: string } | undefined)?.t;
      if (verifyDebugToken(token)) return;
    }
    if (!isAuthenticated(request)) {
      return fail(reply, 401, "未登录或会话已过期");
    }
  });

  app.get(API.health, async (request): Promise<HealthResponse> => ({
    ok: true,
    authenticated: isAuthenticated(request),
    needsSetup: needsSetup(),
    seq: eventBus.currentSeq,
    serverTime: new Date().toISOString(),
  }));

  app.post(API.setup, async (request, reply) => {
    if (!needsSetup()) return fail(reply, 409, "密码已设置");
    const { password, token } = (request.body ?? {}) as SetupRequest & { token?: string };
    if (config.setupToken && token !== config.setupToken) {
      return fail(reply, 403, "设置令牌不正确");
    }
    if (!password || password.length < 8) {
      return fail(reply, 400, "密码至少需要 8 个字符");
    }
    setPassword(await hashPassword(password));
    appendAudit({ actor: "system", action: "auth.setup", target: "admin", detail: "初始化密码", ok: true });
    setSessionCookie(reply, createToken());
    return { ok: true };
  });

  app.post(API.login, async (request, reply) => {
    const { password } = (request.body ?? {}) as LoginRequest;
    if (!(await verifyPassword(password ?? ""))) {
      appendAudit({ actor: "unknown", action: "auth.login", target: "admin", detail: "密码错误", ok: false });
      return fail(reply, 401, "密码错误");
    }
    setSessionCookie(reply, createToken());
    appendAudit({ actor: "admin", action: "auth.login", target: "admin", detail: "登录成功", ok: true });
    return { ok: true };
  });

  app.post(API.logout, async (_request, reply) => {
    clearSessionCookie(reply);
    return { ok: true };
  });

  app.get(API.snapshot, async () => stacks.snapshot());

  app.get(API.stats, async () => currentStats());

  app.get(API.hosts, async () => hostsResponse());

  app.get(API.images, async () => inspectImages());

  app.post(API.imageRemove, async (request, reply) => {
    const body = (request.body ?? {}) as ImageRemoveRequest;
    if (!Array.isArray(body.ids) || body.ids.length === 0) {
      return fail(reply, 400, "请选择要删除的镜像");
    }
    return { results: await removeImages(body.ids.filter((id) => typeof id === "string")) };
  });

  app.post(API.imagePrune, async (request, reply) => {
    const body = (request.body ?? {}) as ImagePruneRequest;
    if (!["dangling", "unused", "all"].includes(body.scope)) {
      return fail(reply, 400, "清理范围不合法");
    }
    return pruneImages(body.scope);
  });

  // ===== 容器详情与文件 =====
  app.get<{ Params: { id: string } }>("/api/containers/:id/inspect", async (request, reply) => {
    try {
      return await inspectContainer(request.params.id);
    } catch (error) {
      return fail(reply, 400, error instanceof Error ? error.message : "读取容器详情失败");
    }
  });

  app.get<{ Params: { id: string }; Querystring: { path?: string } }>(
    "/api/containers/:id/files",
    async (request, reply) => {
      try {
        return await listContainerFiles(request.params.id, request.query.path ?? "/");
      } catch (error) {
        return fail(reply, 400, error instanceof Error ? error.message : "读取目录失败");
      }
    },
  );

  app.get<{ Params: { id: string }; Querystring: { path?: string } }>(
    "/api/containers/:id/file",
    async (request, reply) => {
      if (!request.query.path) return fail(reply, 400, "请指定文件路径");
      try {
        return await readContainerFile(request.params.id, request.query.path);
      } catch (error) {
        return fail(reply, 400, error instanceof Error ? error.message : "读取文件失败");
      }
    },
  );

  app.put<{ Params: { id: string } }>("/api/containers/:id/file", async (request, reply) => {
    const body = request.body as ContainerFileWrite;
    if (!body?.path || typeof body.content !== "string") return fail(reply, 400, "参数不合法");
    try {
      await writeContainerFile(request.params.id, body.path, body.content);
      appendAudit({ actor: "admin", action: "container.file.write", target: body.path, detail: `容器 ${request.params.id}`, ok: true });
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : "写入失败";
      appendAudit({ actor: "admin", action: "container.file.write", target: body.path, detail: message, ok: false });
      return fail(reply, 400, message);
    }
  });

  app.delete<{ Params: { id: string }; Querystring: { path?: string } }>(
    "/api/containers/:id/file",
    async (request, reply) => {
      if (!request.query.path) return fail(reply, 400, "请指定文件路径");
      try {
        await deleteContainerFile(request.params.id, request.query.path);
        appendAudit({ actor: "admin", action: "container.file.delete", target: request.query.path, detail: `容器 ${request.params.id}`, ok: true });
        return { ok: true };
      } catch (error) {
        const message = error instanceof Error ? error.message : "删除失败";
        appendAudit({ actor: "admin", action: "container.file.delete", target: request.query.path, detail: message, ok: false });
        return fail(reply, 400, message);
      }
    },
  );

  // ===== 卷管理 =====
  app.get(API.volumes, async () => inspectVolumes());

  app.post(API.volumes, async (request, reply) => {
    const body = request.body as VolumeCreate;
    if (!body?.name) return fail(reply, 400, "请填写卷名称");
    try {
      await createVolume(body);
      appendAudit({ actor: "admin", action: "volume.create", target: body.name, detail: "创建卷", ok: true });
      eventBus.publish("volume.changed", { name: body.name });
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : "创建失败";
      appendAudit({ actor: "admin", action: "volume.create", target: body.name, detail: message, ok: false });
      return fail(reply, 400, message);
    }
  });

  app.delete("/api/volumes/:name", async (request, reply) => {
    const { name } = request.params as { name: string };
    try {
      await removeVolume(name, true);
      appendAudit({ actor: "admin", action: "volume.remove", target: name, detail: "删除卷", ok: true });
      eventBus.publish("volume.changed", { name });
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : "删除失败";
      appendAudit({ actor: "admin", action: "volume.remove", target: name, detail: message, ok: false });
      return fail(reply, 400, message);
    }
  });

  app.post(API.volumePrune, async () => {
    const deleted = await pruneVolumes();
    appendAudit({ actor: "admin", action: "volume.prune", target: "all", detail: `清理 ${deleted.length} 个卷`, ok: true });
    eventBus.publish("volume.changed", { deleted });
    return { deleted };
  });

  // ===== 网络管理 =====
  app.get(API.networks, async () => inspectNetworks());

  app.post(API.networks, async (request, reply) => {
    const body = request.body as NetworkCreate;
    if (!body?.name) return fail(reply, 400, "请填写网络名称");
    try {
      await createNetwork(body);
      appendAudit({ actor: "admin", action: "network.create", target: body.name, detail: "创建网络", ok: true });
      eventBus.publish("network.changed", { name: body.name });
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : "创建失败";
      appendAudit({ actor: "admin", action: "network.create", target: body.name, detail: message, ok: false });
      return fail(reply, 400, message);
    }
  });

  app.delete("/api/networks/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      await removeNetwork(id);
      appendAudit({ actor: "admin", action: "network.remove", target: id, detail: "删除网络", ok: true });
      eventBus.publish("network.changed", { id });
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : "删除失败";
      appendAudit({ actor: "admin", action: "network.remove", target: id, detail: message, ok: false });
      return fail(reply, 400, message);
    }
  });

  app.post(API.networkConnect, async (request, reply) => {
    const body = request.body as NetworkConnectRequest;
    if (!body?.id || !body?.container) return fail(reply, 400, "参数不合法");
    try {
      await connectNetwork(body);
      eventBus.publish("network.changed", { id: body.id });
      return { ok: true };
    } catch (error) {
      return fail(reply, 400, error instanceof Error ? error.message : "连接失败");
    }
  });

  app.post(API.networkDisconnect, async (request, reply) => {
    const body = request.body as NetworkConnectRequest;
    if (!body?.id || !body?.container) return fail(reply, 400, "参数不合法");
    try {
      await disconnectNetwork(body);
      eventBus.publish("network.changed", { id: body.id });
      return { ok: true };
    } catch (error) {
      return fail(reply, 400, error instanceof Error ? error.message : "断开失败");
    }
  });

  app.post(API.networkPrune, async () => {
    const deleted = await pruneNetworks();
    appendAudit({ actor: "admin", action: "network.prune", target: "all", detail: `清理 ${deleted.length} 个网络`, ok: true });
    eventBus.publish("network.changed", { deleted });
    return { deleted };
  });

  // ===== 系统清理与备份 =====
  app.post(API.systemPrune, async (request, reply) => {
    const body = request.body as PruneRequest;
    if (!["containers", "networks", "buildCache", "volumes", "all"].includes(body?.scope)) {
      return fail(reply, 400, "清理范围不合法");
    }
    const results = await systemPrune(body);
    appendAudit({ actor: "admin", action: "system.prune", target: body.scope, detail: results.map((item) => item.message).join("；"), ok: true });
    eventBus.publish("system.pruned", { scope: body.scope });
    return { results };
  });

  app.get(API.backup, async () => exportBackup());

  app.post(API.backupRestore, async (request, reply) => {
    try {
      const result = await restoreBackup(request.body as BackupRestoreRequest);
      appendAudit({ actor: "admin", action: "backup.restore", target: "all", detail: result.message, ok: true });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : "恢复失败";
      appendAudit({ actor: "admin", action: "backup.restore", target: "all", detail: message, ok: false });
      return fail(reply, 400, message);
    }
  });

  app.post(API.batch, async (request, reply) => {
    const body = request.body as BatchRequest;
    if (!body?.names || !Array.isArray(body.names) || !actions.includes(body.action)) {
      return fail(reply, 400, "批量参数不合法");
    }
    return { results: await stacks.batch(body) };
  });

  app.get<{ Params: { name: string } }>("/api/stacks/:name", async (request, reply) => {
    try {
      return stacks.read(request.params.name);
    } catch (error) {
      return fail(reply, 404, error instanceof Error ? error.message : "读取失败");
    }
  });

  app.put<{ Params: { name: string } }>("/api/stacks/:name", async (request, reply) => {
    try {
      stacks.write(request.params.name, request.body as ComposePayload);
      return { ok: true };
    } catch (error) {
      return fail(reply, 400, error instanceof Error ? error.message : "保存失败");
    }
  });

  app.delete<{ Params: { name: string } }>("/api/stacks/:name", async (request, reply) => {
    try {
      stacks.remove(request.params.name);
      return { ok: true };
    } catch (error) {
      return fail(reply, 400, error instanceof Error ? error.message : "删除失败");
    }
  });

  app.post<{ Params: { name: string } }>(
    "/api/stacks/:name/validate",
    async (request, reply) => {
      if (!isValidStackName(request.params.name)) {
        return fail(reply, 400, "非法的栈名称");
      }
      try {
        return await stacks.validate(
          request.params.name,
          (request.body ?? {}) as ComposePayload,
        );
      } catch (error) {
        return fail(reply, 400, error instanceof Error ? error.message : "校验失败");
      }
    },
  );

  app.post<{ Params: { name: string; service: string; action: string } }>(
    "/api/stacks/:name/services/:service/:action",
    async (request, reply) => {
      const { name, service, action } = request.params;
      if (
        !isValidStackName(name) ||
        !/^[A-Za-z0-9_.-]+$/.test(service) ||
        !serviceActions.includes(action as ServiceActionName)
      ) {
        return fail(reply, 400, "服务操作参数不合法");
      }
      const safeAction = action as ServiceActionName;
      const args: Record<ServiceActionName, string[]> = {
        start: ["up", "-d", "--no-deps", service],
        stop: ["stop", service],
        restart: ["restart", service],
        pull: ["pull", service],
      };
      try {
        return startTask({
          stack: name,
          action: `service:${safeAction} ${service}`,
          args: [args[safeAction]],
        });
      } catch (error) {
        if (error instanceof TaskBusyError) return fail(reply, 409, error.message);
        throw error;
      }
    },
  );

  for (const action of actions) {
    app.post<{ Params: { name: string } }>(
      `/api/stacks/:name/${action}`,
      async (request, reply) => {
        try {
          return startTask({
            stack: request.params.name,
            action,
            args: actionArgsForTask(action),
          });
        } catch (error) {
          if (error instanceof TaskBusyError) return fail(reply, 409, error.message);
          throw error;
        }
      },
    );
  }

  // 实时任务输出流：先回放已缓存的行，再推送后续增量
  app.get<{ Params: { id: string } }>("/api/tasks/:id/stream", async (request, reply) => {
    const snapshot = taskSnapshot(request.params.id);
    if (!snapshot) return fail(reply, 404, "任务不存在或已过期");

    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    reply.raw.write("retry: 2000\n\n");
    for (const line of snapshot.lines) {
      reply.raw.write(`data: ${JSON.stringify(line)}\n\n`);
    }

    let closed = false;
    const unsubscribe = subscribeTask(
      request.params.id,
      (line) => {
        if (!closed) reply.raw.write(`data: ${JSON.stringify(line)}\n\n`);
      },
      (result) => {
        if (closed) return;
        reply.raw.write(`event: done\ndata: ${JSON.stringify(result)}\n\n`);
        reply.raw.end();
        closed = true;
      },
    );
    // 任务在订阅前就已结束的情况
    if (snapshot.task.done && !closed) {
      reply.raw.write(
        `event: done\ndata: ${JSON.stringify({ ok: snapshot.task.ok, exitCode: snapshot.task.exitCode })}\n\n`,
      );
      reply.raw.end();
      closed = true;
    }
    request.raw.on("close", () => {
      closed = true;
      unsubscribe?.();
    });
  });

  app.post(API.convertRun, async (request): Promise<ConvertRunResponse> => {
    const body = (request.body ?? {}) as ConvertRunRequest;
    return convertRunCommand(body.command ?? "");
  });

  app.get<{ Params: { name: string }; Querystring: { service?: string } }>(
    "/api/stacks/:name/logs",
    async (request, reply) => {
      const { name } = request.params;
      const service = request.query.service ?? "";
      const composeFile = composeFileFor(name);
      if (!composeFile || !service) return fail(reply, 400, "参数不合法");

      reply.hijack();
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      reply.raw.write("retry: 3000\n\n");

      const child = spawn(
        "docker",
        // 只看新输出的日志；历史已按启动时间分片落盘，可在日志中心点开查看
        ["compose", "-f", composeFile, "-p", name, "logs", "-f", "--tail", "0", service],
        { cwd: path.dirname(composeFile), stdio: ["ignore", "pipe", "pipe"] },
      );
      const emit = (data: Buffer) => {
        for (const line of data.toString("utf8").split("\n")) {
          if (line) reply.raw.write(`data: ${JSON.stringify(line)}\n\n`);
        }
      };
      child.stdout?.on("data", emit);
      child.stderr?.on("data", emit);
      child.on("close", () => {
        reply.raw.write("event: end\ndata: {}\n\n");
        reply.raw.end();
      });
      request.raw.on("close", () => child.kill());
    },
  );

  app.get(API.events, async (request, reply) => {
    const lastSeq = Number(request.headers["last-event-id"] ?? 0) || 0;
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    reply.raw.write("retry: 2000\n\n");
    for (const event of eventBus.replayAfter(lastSeq)) writeEvent(reply, event);

    const unsubscribe = eventBus.subscribe((event) => writeEvent(reply, event));
    const heartbeat = setInterval(() => reply.raw.write(": ping\n\n"), 15000);
    request.raw.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  app.get<{ Querystring: { limit?: string; offset?: string } }>(API.audit, async (request) => {
    const limit = Math.min(Number(request.query.limit ?? 50) || 50, 200);
    const offset = Math.max(Number(request.query.offset ?? 0) || 0, 0);
    return readAudit(limit, offset);
  });

  app.get<{ Querystring: { category?: string; scope?: string } }>(API.logFiles, async (request) => {
    const raw = request.query.category;
    const category: LogCategory | undefined =
      raw === "container" || raw === "task" || raw === "audit" || raw === "server"
        ? raw
        : undefined;
    return {
      generatedAt: new Date().toISOString(),
      files: listLogFiles(category, request.query.scope || undefined),
    };
  });

  app.get<{ Querystring: { path?: string; limit?: string } }>(API.logFile, async (request, reply) => {
    const limit = Math.min(Number(request.query.limit ?? 500) || 500, 2000);
    const content = readLogFile(request.query.path ?? "", limit);
    if (!content) return fail(reply, 404, "日志文件不存在或路径不合法");
    return content;
  });

  // 下载完整历史日志：页面预览只取末尾若干行，下载必须拿到原始文件全文。
  app.get<{ Querystring: { path?: string } }>(API.logFileRaw, async (request, reply) => {
    const file = readLogFileRaw(request.query.path ?? "");
    if (!file) return fail(reply, 404, "日志文件不存在或路径不合法");
    reply.header("Content-Type", "text/plain; charset=utf-8");
    reply.header("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`);
    return reply.send(file.content);
  });

  app.delete<{ Querystring: { path?: string } }>(API.logFile, async (request, reply) => {
    const target = request.query.path ?? "";
    if (!deleteLogFile(target)) {
      return fail(reply, 400, "无法删除该日志文件（可能正在写入或路径不合法）");
    }
    appendAudit({
      actor: "admin",
      action: "log.delete",
      target,
      detail: "删除历史日志文件",
      ok: true,
    });
    return { ok: true };
  });

  app.get(API.logSettings, async () => getLogSettings());

  app.put<{ Body: Partial<LogRetention> }>(API.logSettings, async (request) => {
    const result = updateLogSettings((request.body ?? {}) as Partial<LogRetention>);
    appendAudit({
      actor: "admin",
      action: "log.settings",
      target: "retention",
      detail: JSON.stringify(result.retention),
      ok: true,
    });
    return result;
  });

  app.post(API.logCleanup, async () => {
    const result = cleanupLogs();
    appendAudit({
      actor: "admin",
      action: "log.cleanup",
      target: "all",
      detail: `清理 ${result.removed} 个，失败 ${result.failed} 个`,
      ok: true,
    });
    return result;
  });

  app.get(API.systemVersion, async (): Promise<SystemVersion> => version);

  app.get(API.systemUpdate, async (): Promise<UpdateStatus> => updateStatus);

  app.get(API.systemUpdateHelper, async () => ({ helpers: await helperDiagnostics() }));

  app.get<{ Querystring: { lines?: string } }>(API.systemLogs, async (request) => ({
    lines: await selfLogs(Math.min(Number(request.query.lines ?? 200) || 200, 1000)),
  }));

  app.post(API.updateCheck, async () => {
    const before = updateStatus.updateAvailable;
    const status = await checkForUpdate();
    return { ...status, newlyAvailable: status.updateAvailable && !before };
  });

  app.post(API.updateApply, async () => applyUpdate());

  app.post(API.debugToken, async (request): Promise<DebugTokenResponse> => {
    const body = (request.body ?? {}) as { minutes?: number };
    const minutes = Math.min(Number(body.minutes ?? 60) || 60, 720);
    const token = createDebugToken(minutes);
    const host = request.headers.host ?? `localhost:${config.port}`;
    const forwarded = request.headers["x-forwarded-proto"] as string | undefined;
    const protocol = (forwarded?.split(",")[0] ?? request.protocol).trim();
    return {
      url: `${protocol}://${host}${API.systemDiagnostics}?t=${token}`,
      expiresAt: new Date(Date.now() + minutes * 60_000).toISOString(),
    };
  });

  app.get(API.systemDiagnostics, async (request): Promise<DiagnosticsBundle> => {
    const health: HealthResponse = {
      ok: true,
      authenticated: isAuthenticated(request),
      needsSetup: needsSetup(),
      seq: eventBus.currentSeq,
      serverTime: new Date().toISOString(),
    };
    return {
      generatedAt: new Date().toISOString(),
      version,
      update: updateStatus,
      health,
      snapshot: await stacks.snapshot(),
      audit: readAudit(50, 0),
      logs: await selfLogs(200),
      helpers: await helperDiagnostics(),
      note: "只读诊断包，不包含密码或会话 Token",
    };
  });
}
