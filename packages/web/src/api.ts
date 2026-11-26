import { API } from "@dockermanager/shared";

let currentHost = "local";

export function setCurrentHost(host: string): void {
  currentHost = host || "local";
}

export function getCurrentHost(): string {
  return currentHost;
}

/** 根据当前主机改写 API 路径；本地主机直接访问，远程主机走代理 */
function scoped(path: string): string {
  if (currentHost === "local") return path;
  // path 形如 /api/stacks，改写为 /api/host/<id>/stacks
  return API.proxy(currentHost, path.replace(/^\/api\//, ""));
}

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(scoped(path), {
    credentials: "same-origin",
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `请求失败 (${response.status})`);
  }
  return (await response.json()) as T;
}

export function post<T>(path: string, body?: unknown): Promise<T> {
  return apiFetch<T>(path, { method: "POST", body: JSON.stringify(body ?? {}) });
}

export function put<T>(path: string, body: unknown): Promise<T> {
  return apiFetch<T>(path, { method: "PUT", body: JSON.stringify(body) });
}

export function del<T>(path: string): Promise<T> {
  return apiFetch<T>(path, { method: "DELETE" });
}

/** SSE / WebSocket 等场景需要拿到改写后的 URL */
export function scopedUrl(path: string): string {
  return scoped(path);
}
