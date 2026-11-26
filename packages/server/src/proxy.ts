import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { isAgentRequest } from "./auth.js";
import { findAgent } from "./hosts.js";

/** 注册多主机反向代理：/api/host/:hostId/<原API路径> → agent 的 /api/<原API路径> */
export function registerProxy(app: FastifyInstance): void {
  app.all<{ Params: { hostId: string; "*": string } }>(
    "/api/host/:hostId/*",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const params = request.params as { hostId: string; "*"?: string };
      const hostId = params.hostId;
      const wildcard = params["*"] ?? "";
      const agent = findAgent(hostId);
      if (!agent) {
        return reply.code(404).send({ error: "未知主机" });
      }
      if (!isAgentRequest(request, agent.token)) {
        return reply.code(401).send({ error: "agent 认证失败" });
      }

      const target = `${agent.url}/api/${wildcard}${request.url.includes("?") ? `?${request.url.split("?")[1]}` : ""}`;
      const method = request.method;
      const headers: Record<string, string> = {
        Authorization: `Bearer ${agent.token}`,
      };
      const contentType = request.headers["content-type"];
      if (contentType) headers["Content-Type"] = contentType;
      const lastEventId = request.headers["last-event-id"] as string | undefined;
      if (lastEventId) headers["Last-Event-ID"] = lastEventId;

      let body: string | undefined;
      if (!["GET", "HEAD"].includes(method)) {
        body = JSON.stringify(request.body ?? {});
      }

      try {
        const upstream = await fetch(target, { method, headers, body });
        reply.code(upstream.status);

        // SSE 流式透传
        const upstreamContentType = upstream.headers.get("content-type") ?? "";
        if (upstreamContentType.includes("text/event-stream") && upstream.body) {
          reply.hijack();
          reply.raw.writeHead(upstream.status, {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache, no-transform",
            Connection: "keep-alive",
            "X-Accel-Buffering": "no",
          });
          const reader = upstream.body.getReader();
          const pump = async () => {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              reply.raw.write(value);
            }
            reply.raw.end();
          };
          request.raw.on("close", () => void reader.cancel().catch(() => undefined));
          await pump();
          return;
        }

        // 普通 JSON / 文本响应
        const text = await upstream.text();
        reply.header("Content-Type", upstreamContentType || "application/json; charset=utf-8");
        return reply.send(text);
      } catch (error) {
        return reply.code(502).send({
          error: `无法连接远程主机 ${agent.name}: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    },
  );
}
