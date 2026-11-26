import { spawn } from "node:child_process";
import path from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  API,
  type BatchRequest,
  type ComposePayload,
  type HealthResponse,
  type LoginRequest,
  type ServerEvent,
  type SetupRequest,
  type StackAction,
} from "@stackdeck/shared";
import {
  clearSessionCookie,
  createToken,
  hashPassword,
  isAuthenticated,
  setSessionCookie,
  verifyPassword,
} from "./auth.js";
import { config } from "./config.js";
import { composeFileFor } from "./docker.js";
import { eventBus } from "./event-bus.js";
import { appendAudit, needsSetup, readAudit, setPassword } from "./store.js";
import { stacks } from "./stacks.js";

const actions: StackAction[] = ["start", "stop", "restart", "update", "down", "pull"];

function fail(reply: FastifyReply, status: number, message: string) {
  return reply.code(status).send({ error: message });
}

function writeEvent(reply: FastifyReply, event: ServerEvent): void {
  reply.raw.write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("onRequest", async (request, reply) => {
    const pathname = request.url.split("?")[0];
    if (!pathname?.startsWith("/api/")) return;
    if (
      pathname === API.health ||
      pathname === API.login ||
      pathname === API.setup
    ) {
      return;
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

  for (const action of actions) {
    app.post<{ Params: { name: string } }>(
      `/api/stacks/:name/${action}`,
      async (request) => stacks.action(request.params.name, action),
    );
  }

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
        ["compose", "-f", composeFile, "-p", name, "logs", "-f", "--tail", "300", service],
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
}
