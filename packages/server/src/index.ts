import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import { config } from "./config.js";
import { registerRoutes } from "./routes.js";
import { startStatsSampler } from "./stats.js";
import { setupTerminal } from "./terminal.js";
import { startUpdater } from "./updater.js";

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL ?? "info" },
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
