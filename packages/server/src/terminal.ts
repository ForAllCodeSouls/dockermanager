import type { FastifyInstance } from "fastify";
import type { IncomingMessage } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { isValidStackName } from "@stackdeck/shared";
import { config } from "./config.js";
import { verifyToken } from "./auth.js";
import { composeFileFor } from "./docker.js";

interface TerminalMessage {
  type: "opened" | "data" | "error" | "closed";
  data?: string;
}

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
    if (url.pathname !== "/api/terminal") return;

    const cookies = parseCookies(request.headers.cookie);
    if (!verifyToken(cookies[config.cookieName])) {
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

    if (!isValidStackName(stack) || !service || !/^[A-Za-z0-9_.-]+$/.test(service)) {
      send(ws, { type: "error", data: "参数不合法" });
      ws.close();
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

    let replay = "";
    const push = (text: string) => {
      replay += text;
      if (replay.length > 20000) replay = replay.slice(-20000);
      send(ws, { type: "data", data: text });
    };

    child.stdout?.on("data", (chunk: Buffer) => push(chunk.toString("utf8")));
    child.stderr?.on("data", (chunk: Buffer) => push(chunk.toString("utf8")));
    child.on("error", (error) => send(ws, { type: "error", data: error.message }));
    child.on("close", (code) => {
      send(ws, { type: "closed", data: `会话结束，退出码 ${code}` });
      ws.close();
    });

    ws.on("message", (data) => {
      child.stdin?.write(data.toString());
    });
    ws.on("close", () => {
      child.kill();
    });
  });
}

function send(ws: WebSocket, message: TerminalMessage): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
}
