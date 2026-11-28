import fs from "node:fs";
import path from "node:path";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import { config } from "./config.js";
import { startLogCollector } from "./log-collector.js";
import { appendLog, flushLogs } from "./log-store.js";
import { registerRoutes } from "./routes.js";
import { startStatsSampler } from "./stats.js";
import { setupTerminal } from "./terminal.js";
import { startUpdater } from "./updater.js";

/** pino 输出是 JSON，落盘时转成人类可读格式；stdout 保持原样便于 docker logs 查看 */
function formatLogLine(raw: string): string {
  const text = raw.trimEnd();
  if (!text) return "";
  try {
    const item = JSON.parse(text) as Record<string, unknown>;
    if (typeof item.time !== "number" || typeof item.msg !== "string") return text;
    const level = Number(item.level) || 30;
    const label =
      level >= 60 ? "FATAL" : level >= 50 ? "ERROR" : level >= 40 ? "WARN" : level >= 30 ? "INFO" : "DEBUG";
    const time = new Date(item.time).toLocaleString("zh-CN");
    let detail = "";
    if (item.err && typeof item.err === "object") {
      const err = item.err as { message?: string; stack?: string };
      detail = ` | ${err.stack ?? err.message ?? ""}`;
    }
    return `${time} [${label}] ${item.msg}${detail}`;
  } catch {
    return text;
  }
}

const logStream = new Writable({
  write(chunk, _encoding, callback) {
    process.stdout.write(chunk);
    for (const line of chunk.toString("utf8").split("\n")) {
      const formatted = formatLogLine(line);
      if (formatted) appendLog("server", "", formatted);
    }
    callback();
  },
});

process.on("uncaughtException", (error) => {
  appendLog("server", "", `${new Date().toISOString()} [FATAL] ${error.stack ?? error.message}`);
  flushLogs();
});
process.on("unhandledRejection", (reason) => {
  appendLog("server", "", `${new Date().toISOString()} [ERROR] 未处理的 Promise 拒绝: ${String(reason)}`);
  flushLogs();
});

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL ?? "info", stream: logStream },
});

await app.register(cookie);
await registerRoutes(app);
setupTerminal(app);

const here = path.dirname(fileURLToPath(import.meta.url));
const webDist = process.env.WEB_DIST ?? path.resolve(here, "../../web/dist");
if (fs.existsSync(path.join(webDist, "index.html"))) {
  await app.register(fastifyStatic, { root: webDist, wildcard: false });
  app.setNotFoundHandler((_request, reply) => reply.sendFile("index.html"));
}

await app.listen({ port: config.port, host: config.host });
app.log.info(`DockerManager listening on http://${config.host}:${config.port}`);
startUpdater();
startStatsSampler();
startLogCollector();
