import Docker from "dockerode";
import type { NetworkConnectRequest, NetworkCreate, NetworksResponse, NetworkInfo } from "@dockermanager/shared";

const docker = new Docker();

export async function inspectNetworks(): Promise<NetworksResponse> {
  const listed = await docker.listNetworks();
  const networks: NetworkInfo[] = [];
  for (const item of listed) {
    let subnet = "";
    let gateway = "";
    let containers: { name: string; ipv4: string }[] = [];
    try {
      const detail = await docker.getNetwork(item.Id).inspect();
      const config = detail.IPAM?.Config?.[0];
      subnet = config?.Subnet ?? "";
      gateway = config?.Gateway ?? "";
      containers = Object.values(detail.Containers ?? {}).map((entry) => ({
        name: entry.Name ?? "",
        ipv4: entry.IPv4Address ?? "",
      }));
    } catch {
      // 网络可能刚好被删除，保留列表信息
    }
    networks.push({
      id: item.Id.slice(0, 12),
      name: item.Name ?? "",
      driver: item.Driver ?? "",
      scope: item.Scope ?? "",
      subnet,
      gateway,
      internal: Boolean((item as { Internal?: boolean }).Internal),
      attachable: Boolean((item as { Attachable?: boolean }).Attachable),
      containers,
    });
  }
  return { generatedAt: new Date().toISOString(), networks };
}

export async function createNetwork(body: NetworkCreate): Promise<void> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(body.name)) {
    throw new Error("网络名称不合法");
  }
  await docker.createNetwork({
    Name: body.name,
    Driver: body.driver || "bridge",
    Internal: Boolean(body.internal),
    Attachable: true,
  });
}

export async function removeNetwork(id: string): Promise<void> {
  await docker.getNetwork(id).remove();
}

export async function pruneNetworks(): Promise<string[]> {
  const result = await docker.pruneNetworks();
  return result.NetworksDeleted ?? [];
}

export async function connectNetwork(body: NetworkConnectRequest): Promise<void> {
  await docker.getNetwork(body.id).connect({ Container: body.container });
}

export async function disconnectNetwork(body: NetworkConnectRequest): Promise<void> {
  await docker.getNetwork(body.id).disconnect({ Container: body.container, Force: true });
}
