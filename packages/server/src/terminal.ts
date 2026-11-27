import type { FastifyInstance } from "fastify";
import type { IncomingMessage } from "node:http";
import { spawn } from "node:child_process";
import path from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import * as pty from "node-pty";
import { API, isValidStackName } from "@dockermanager/shared";
import { config } from "./config.js";
import { verifyToken } from "./auth.js";
import { composeFileFor } from "./docker.js";
import { findAgent } from "./hosts.js";

interface TerminalMessage {
  type: "opened" | "data" | "error" | "closed";
  data?: string;
}

type AgentConfig = NonNullable<ReturnType<typeof findAgent>>;

function parseCookies(header: string | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index > 0) {
      result[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
    }
  }
  return result;
}

function authorizeUpgrade(request: IncomingMessage): boolean {
  const cookies = parseCookies(request.headers.cookie);
  if (verifyToken(cookies[config.cookieName])) return true;
  // agent 部署没有浏览器会话，使用共享密钥的 Bearer Token。
  if (
    config.mode === "agent" &&
    config.agentToken &&
    request.headers.authorization === `Bearer ${config.agentToken}`
  ) {
    return true;
  }
  return false;
}

function send(ws: WebSocket, message: TerminalMessage): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
}

/** 检测 compose 服务是否有正在运行的容器 */
function isServiceRunning(composeFile: string, stack: string, service: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = spawn(
      "docker",
      ["compose", "-f", composeFile, "-p", stack, "ps", "-q", service],
      { cwd: path.dirname(composeFile), stdio: ["ignore", "pipe", "ignore"] },
    );
    let output = "";
    probe.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    probe.on("error", () => resolve(false));
    probe.on("close", (code) => resolve(code === 0 && output.trim().length > 0));
  });
}

/** 解析服务的镜像与网络，供未运行服务的临时容器使用 */
function resolveServiceConfig(
  composeFile: string,
  stack: string,
  service: string,
): Promise<{ image: string | null; network: string | null }> {
  return new Promise((resolve) => {
    const child = spawn(
      "docker",
      ["compose", "-f", composeFile, "-p", stack, "config", "--format", "json"],
      { cwd: path.dirname(composeFile), stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    const fail = () => resolve({ image: null, network: null });
    child.on("error", fail);
    child.on("close", (code) => {
      if (code !== 0) return fail();
      try {
        const config = JSON.parse(output) as {
          services?: Record<string, { image?: string; networks?: Record<string, unknown> }>;
          networks?: Record<string, unknown>;
        };
        const svc = config.services?.[service];
        const image = svc?.image ?? null;
        // 优先用服务显式声明的第一个网络，否则用 compose 默认网络 <stack>_default。
        const svcNetworks = svc?.networks ? Object.keys(svc.networks) : [];
        const network = svcNetworks[0] ?? (config.networks && Object.keys(config.networks)[0]) ?? `${stack}_default`;
        resolve({ image, network });
      } catch {
        fail();
      }
    });
  });
}

function wsUrlFor(agent: AgentConfig, stack: string, service: string): string {
  const base = agent.url.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
  return `${base}${API.terminal}?stack=${encodeURIComponent(stack)}&service=${encodeURIComponent(service)}`;
}

function proxyTerminal(ws: WebSocket, agent: AgentConfig, stack: string, service: string): void {
  if (!agent.token) {
    send(ws, { type: "error", data: `远程主机 ${agent.name} 未配置访问令牌` });
    ws.close();
    return;
  }

  let upstream: WebSocket;
  try {
    upstream = new WebSocket(wsUrlFor(agent, stack, service), {
      headers: { Authorization: `Bearer ${agent.token}` },
    });
  } catch (error) {
    send(ws, {
      type: "error",
      data: `远程终端连接失败：${error instanceof Error ? error.message : String(error)}`,
    });
    ws.close();
    return;
  }

  let closed = false;
  const pending: string[] = [];
  const closeBoth = () => {
    if (closed) return;
    closed = true;
    if (upstream.readyState !== upstream.CLOSED) upstream.close();
    if (ws.readyState === ws.OPEN) ws.close();
  };
  const forward = (data: string) => {
    if (upstream.readyState === upstream.OPEN) {
      upstream.send(data);
      return;
    }
    // 上游WebSocket尚未建立时暂存少量输入，避免用户第一击键被丢弃。
    pending.push(data);
    if (pending.length > 100) pending.shift();
  };

  upstream.on("open", () => {
    for (const data of pending.splice(0)) upstream.send(data);
    send(ws, { type: "opened", data: `已连接远程主机 ${agent.name}` });
  });
  upstream.on("message", (data) => {
    if (ws.readyState === ws.OPEN) ws.send(data.toString());
  });
  upstream.on("error", (error) => {
    send(ws, { type: "error", data: `远程终端连接失败：${error.message}` });
    closeBoth();
  });
  upstream.on("close", () => {
    if (ws.readyState === ws.OPEN) ws.close();
  });

  ws.on("message", (data) => {
    forward(data.toString());
  });
  ws.on("close", () => {
    if (upstream.readyState !== upstream.CLOSED) upstream.close();
  });
}

export function setupTerminal(app: FastifyInstance): void {
  const wss = new WebSocketServer({ noServer: true });

  app.server.on("upgrade", (request: IncomingMessage, socket, head) => {
    let url: URL;
    try {
      url = new URL(request.url ?? "/", "http://localhost");
    } catch {
      socket.destroy();
      return;
    }
    if (url.pathname !== API.terminal) return;

    if (!authorizeUpgrade(request)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws, request));
  });

  wss.on("connection", (ws: WebSocket, request: IncomingMessage) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const stack = url.searchParams.get("stack") ?? "";
    const service = url.searchParams.get("service") ?? "";
    const hostId = url.searchParams.get("host") ?? "local";

    if (
      !isValidStackName(stack) ||
      !service ||
      !/^[A-Za-z0-9_.-]+$/.test(service) ||
      !/^[A-Za-z0-9_.-]+$/.test(hostId)
    ) {
      send(ws, { type: "error", data: "参数不合法" });
      ws.close();
      return;
    }

    if (hostId !== "local") {
      const agent = findAgent(hostId);
      if (!agent) {
        send(ws, { type: "error", data: `未知主机 ${hostId}` });
        ws.close();
        return;
      }
      proxyTerminal(ws, agent, stack, service);
      return;
    }

    const composeFile = composeFileFor(stack);
    if (!composeFile) {
      send(ws, { type: "error", data: "栈不存在" });
      ws.close();
      return;
    }

    void (async () => {
      if (ws.readyState !== ws.OPEN) return;
      const running = await isServiceRunning(composeFile, stack, service);
      if (ws.readyState !== ws.OPEN) return;

      // 运行中的服务用 compose exec；未运行则用镜像起一个临时容器（--rm 退出后自动清理）。
      // 二者都挂到 node-pty 的伪终端上：有回显、有提示符、支持 Tab 补全与方向键。
      let argv: string[];
      if (running) {
        argv = ["compose", "-f", composeFile, "-p", stack, "exec", service, "sh"];
      } else {
        const { image, network } = await resolveServiceConfig(composeFile, stack, service);
        if (!image) {
          send(ws, { type: "error", data: "服务未运行，且无法从配置解析镜像" });
          ws.close();
          return;
        }
        argv = ["run", "--rm", "-it", ...(network ? ["--network", network] : []), image, "sh"];
      }
      if (ws.readyState !== ws.OPEN) return;

      let term: pty.IPty;
      try {
        term = pty.spawn("docker", argv, {
          name: "xterm-256color",
          cols: 100,
          rows: 30,
          cwd: path.dirname(composeFile),
          env: { ...process.env, TERM: "xterm-256color" } as Record<string, string>,
        });
      } catch (error) {
        send(ws, {
          type: "error",
          data: `终端启动失败：${error instanceof Error ? error.message : String(error)}`,
        });
        ws.close();
        return;
      }

      send(ws, {
        type: "opened",
        data: running ? "终端已连接" : "服务未运行，已开启临时容器（退出后自动清理）",
      });
      term.onData((data) => send(ws, { type: "data", data }));
      term.onExit(({ exitCode }) => {
        send(ws, { type: "closed", data: `会话结束，退出码 ${exitCode}` });
        ws.close();
      });

      ws.on("message", (data) => {
        const raw = data.toString();
        let payload = raw;
        try {
          const frame = JSON.parse(raw) as {
            type?: string;
            data?: string;
            cols?: number;
            rows?: number;
          };
          if (frame.type === "resize") {
            const cols = Math.max(20, Math.min(400, frame.cols ?? 80));
            const rows = Math.max(5, Math.min(200, frame.rows ?? 24));
            try {
              term.resize(cols, rows);
            } catch {
              // ignore resize race
            }
            return;
          }
          if (typeof frame.data === "string") payload = frame.data;
        } catch {
          // 纯文本帧，原样写入
        }
        try {
          term.write(payload);
        } catch {
          // 会话已结束
        }
      });
      ws.on("close", () => {
        try {
          term.kill();
        } catch {
          // 已退出
        }
      });
    })();
  });
}
