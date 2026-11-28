import Docker from "dockerode";
import type { VolumeCreate, VolumesResponse, VolumeInfo } from "@dockermanager/shared";

const docker = new Docker();

export async function inspectVolumes(): Promise<VolumesResponse> {
  const [listed, containers] = await Promise.all([
    docker.listVolumes(),
    docker.listContainers({ all: true }),
  ]);
  const usedBy = new Map<string, string[]>();
  for (const container of containers) {
    const name = container.Names?.[0]?.replace(/^\//, "") ?? container.Id.slice(0, 12);
    for (const mount of container.Mounts ?? []) {
      if (mount.Type !== "volume" || !mount.Name) continue;
      const names = usedBy.get(mount.Name) ?? [];
      if (!names.includes(name)) names.push(name);
      usedBy.set(mount.Name, names);
    }
  }
  const volumes: VolumeInfo[] = (listed.Volumes ?? []).map((volume) => {
    const refs = usedBy.get(volume.Name) ?? [];
    return {
      name: volume.Name,
      driver: volume.Driver ?? "local",
      mountpoint: volume.Mountpoint ?? "",
      createdAt: (volume as { CreatedAt?: string }).CreatedAt ?? "",
      labels: volume.Labels ?? {},
      usedBy: refs,
      inUse: refs.length > 0,
    };
  });
  return {
    generatedAt: new Date().toISOString(),
    volumes,
    summary: { total: volumes.length, unused: volumes.filter((item) => !item.inUse).length },
  };
}

export async function createVolume(body: VolumeCreate): Promise<void> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(body.name)) {
    throw new Error("卷名称不合法");
  }
  await docker.createVolume({ Name: body.name, Labels: body.labels ?? {} });
}

export async function removeVolume(name: string, force = false): Promise<void> {
  await docker.getVolume(name).remove({ force });
}

export async function pruneVolumes(): Promise<string[]> {
  const result = await docker.pruneVolumes();
  return result.VolumesDeleted ?? [];
}
