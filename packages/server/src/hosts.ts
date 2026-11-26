import type { AgentHost, HostsResponse } from "@dockermanager/shared";
import { config } from "./config.js";

const onlineCache = new Map<string, { online: boolean; at: number }>();
const CACHE_MS = 10000;

async function ping(url: string, token: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    const response = await fetch(`${url}/api/health`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export async function hostsResponse(): Promise<HostsResponse> {
  const hosts: AgentHost[] = [
    { id: "local", name: "本机", local: true, online: true },
  ];

  await Promise.all(
    config.agents.map(async (agent) => {
      const cached = onlineCache.get(agent.id);
      let online: boolean;
      if (cached && Date.now() - cached.at < CACHE_MS) {
        online = cached.online;
      } else {
        online = await ping(agent.url, agent.token);
        onlineCache.set(agent.id, { online, at: Date.now() });
      }
      hosts.push({ id: agent.id, name: agent.name, local: false, online });
    }),
  );

  return { hosts };
}

export function findAgent(id: string) {
  return config.agents.find((agent) => agent.id === id) ?? null;
}
