import type { FastifyInstance } from "fastify";
import type { IncomingMessage } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { WebSocket, WebSocketServer } from "ws";
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

    const child: ChildProcess = spawn(
      "docker",
      ["compose", "-f", composeFile, "-p", stack, "exec", service, "sh"],
      {
        cwd: path.dirname(composeFile),
        env: { ...process.env, TERM: "xterm-256color" },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    send(ws, { type: "opened", data: "终端已连接" });
    child.stdout?.on("data", (chunk: Buffer) => {
      send(ws, { type: "data", data: chunk.toString("utf8") });
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      send(ws, { type: "data", data: chunk.toString("utf8") });
    });
    child.on("error", (error) => send(ws, { type: "error", data: error.message }));
    child.on("close", (code) => {
      send(ws, { type: "closed", data: `会话结束，退出码 ${code}` });
      ws.close();
    });

    ws.on("message", (data) => {
      const raw = data.toString();
      // 前端 xterm 发送 JSON 帧 {type,data}；兼容旧版纯文本帧。
      let payload = raw;
      try {
        const frame = JSON.parse(raw) as { type?: string; data?: string };
        // resize 帧只调整本端 xterm 显示，不向 shell 写入任何字节。
        if (frame.type === "resize") return;
        if (typeof frame.data === "string") payload = frame.data;
      } catch {
        // 纯文本帧，原样写入
      }
      child.stdin?.write(payload);
    });
    ws.on("close", () => {
      child.kill();
    });
  });
}
