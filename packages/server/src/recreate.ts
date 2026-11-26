import Docker from "dockerode";

/**
 * 容器重建工具。被 updater（主进程）与 updater-agent（helper 容器）共用。
 *
 * 背景：容器内 node 是 PID 1。若由主进程自己执行 stop()，Docker 会杀死 PID 1，
 * 后续 remove/create/start 根本来不及执行，容器停在 exited（restart policy
 * 对显式 stop 无效），站点直接 502。因此真正的重建必须由「另一个容器」执行，
 * 见 updater-agent.ts。本模块只负责计算重建参数与执行重建步骤。
 */

/** 重建时把镜像内烘焙的版本变量覆盖成新镜像的值，其余用户配置保留旧容器值。 */
export function mergedEnv(
  containerEnv: string[] | undefined,
  imageEnv: string[] | undefined,
): string[] | undefined {
  if (!containerEnv) return imageEnv;
  const out = [...containerEnv];
  const versionKeys = ["APP_VERSION", "APP_COMMIT", "APP_BUILD_TIME"];
  for (const key of versionKeys) {
    const fromImage = imageEnv?.find((entry) => entry.startsWith(`${key}=`));
    if (!fromImage) continue;
    const index = out.findIndex((entry) => entry.startsWith(`${key}=`));
    if (index >= 0) out[index] = fromImage;
    else out.push(fromImage);
  }
  return out;
}

/** 只保留可用于 create 的 HostConfig 白名单字段，避免派生字段导致报错。 */
export function recreateHostConfig(info: Docker.ContainerInspectInfo): Docker.HostConfig {
  const hc = info.HostConfig;
  // Binds 只含 bind mounts；named volume 在 Mounts 里，必须一并带上，否则丢数据卷。
  const namedVolumes = (info.Mounts ?? [])
    .filter((m) => m.Type === "volume" && m.Name)
    .map((m) => `${m.Name}:${m.Destination}:${m.RW ? "rw" : "ro"}`);
  const binds = [...(hc.Binds ?? []), ...namedVolumes];
  const picked: Docker.HostConfig = {
    Binds: binds.length > 0 ? binds : hc.Binds,
    PortBindings: hc.PortBindings,
    Links: hc.Links,
    Privileged: hc.Privileged,
    CapAdd: hc.CapAdd,
    CapDrop: hc.CapDrop,
    RestartPolicy: hc.RestartPolicy,
    Devices: hc.Devices,
    Dns: hc.Dns,
    DnsOptions: hc.DnsOptions,
    DnsSearch: hc.DnsSearch,
    ExtraHosts: hc.ExtraHosts,
    VolumesFrom: hc.VolumesFrom,
    LogConfig: hc.LogConfig,
    ShmSize: hc.ShmSize,
    AutoRemove: hc.AutoRemove,
    Init: hc.Init,
    ReadonlyRootfs: hc.ReadonlyRootfs,
    SecurityOpt: hc.SecurityOpt,
    Sysctls: hc.Sysctls,
    Ulimits: hc.Ulimits,
    GroupAdd: hc.GroupAdd,
    Isolation: hc.Isolation,
    Runtime: hc.Runtime,
    CgroupParent: hc.CgroupParent,
    PublishAllPorts: hc.PublishAllPorts,
    Memory: hc.Memory,
    MemoryReservation: hc.MemoryReservation,
    MemorySwap: hc.MemorySwap,
    NanoCpus: hc.NanoCpus,
    CpuShares: hc.CpuShares,
    CpuQuota: hc.CpuQuota,
    CpuPeriod: hc.CpuPeriod,
    CpusetCpus: hc.CpusetCpus,
    CpusetMems: hc.CpusetMems,
  };

  const networkNames = Object.keys(info.NetworkSettings?.Networks ?? {});
  const mode = hc.NetworkMode ?? "default";
  const isSpecial = ["host", "none", "bridge", "container", "default"].some(
    (n) => mode === n || mode.startsWith(`${n}:`),
  );
  if (!isSpecial && networkNames.length > 0) picked.NetworkMode = networkNames[0];
  else picked.NetworkMode = mode;

  for (const key of Object.keys(picked) as (keyof Docker.HostConfig)[]) {
    if (picked[key] === undefined) delete picked[key];
  }
  return picked;
}

/**
 * NetworkSettings.Networks 中的 IPAddress / Gateway / EndpointID / MacAddress 都是
 * Docker 运行后写入的只读派生字段，原样回填 EndpointsConfig 会让 create 失败。
 * 只保留 create 时可写的字段。
 */
export function recreatableEndpoints(
  networks: Docker.ContainerInspectInfo["NetworkSettings"]["Networks"],
): Record<string, Docker.EndpointSettings> | undefined {
  if (!networks || Object.keys(networks).length === 0) return undefined;
  const endpoints: Record<string, Docker.EndpointSettings> = {};
  for (const [networkName, endpoint] of Object.entries(networks)) {
    if (!endpoint) continue;
    const clean: Docker.EndpointSettings = {};
    if (endpoint.Aliases?.length) clean.Aliases = endpoint.Aliases;
    if (endpoint.IPAMConfig) clean.IPAMConfig = endpoint.IPAMConfig;
    if (endpoint.Links?.length) clean.Links = endpoint.Links;
    endpoints[networkName] = clean;
  }
  return Object.keys(endpoints).length > 0 ? endpoints : undefined;
}

export function buildCreateOptions(
  info: Docker.ContainerInspectInfo,
  newImage: string,
): Docker.ContainerCreateOptions {
  return {
    name: info.Name.replace(/^\//, ""),
    Image: newImage,
    Env: info.Config.Env,
    Labels: info.Config.Labels,
    Cmd: info.Config.Cmd,
    Entrypoint: info.Config.Entrypoint,
    WorkingDir: info.Config.WorkingDir,
    User: info.Config.User,
    Tty: info.Config.Tty,
    OpenStdin: info.Config.OpenStdin,
    ExposedPorts: info.Config.ExposedPorts,
    Volumes: info.Config.Volumes,
    Healthcheck: info.Config.Healthcheck,
    HostConfig: recreateHostConfig(info),
    NetworkingConfig: recreatableEndpoints(info.NetworkSettings?.Networks)
      ? { EndpointsConfig: recreatableEndpoints(info.NetworkSettings?.Networks) }
      : undefined,
  };
}

/**
 * 真正执行重建。调用方必须是一个「独立于目标容器的进程/容器」——否则 stop 目标
 * 就等于 stop 自己。步骤：预检 create → stop → remove → create(新镜像) → start，
 * 失败时用旧镜像回滚。
 */
export async function performRecreate(
  docker: Docker,
  targetName: string,
  newImage: string,
  previousImageId: string | null,
  log: (message: string) => void = () => undefined,
): Promise<void> {
  const target = docker.getContainer(targetName);
  const info = await target.inspect();

  // 用新镜像 Env 覆盖版本变量，其余保留旧容器配置。
  const newImageInfo = await docker.getImage(newImage).inspect().catch(() => null);
  const createOptions = buildCreateOptions(info, newImage);
  createOptions.Env = mergedEnv(info.Config.Env, newImageInfo?.Config?.Env);

  // 预检：临时名 create（不 start、不占端口），提前捕获配置错误。
  const probeName = `${targetName}-update-probe-${Date.now()}`;
  let probe: Docker.Container | null = null;
  try {
    probe = await docker.createContainer({
      ...createOptions,
      name: probeName,
      HostConfig: { ...createOptions.HostConfig, PortBindings: undefined },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`更新预检失败，已保留原容器: ${message}`);
  } finally {
    if (probe) await probe.remove({ force: true }).catch(() => undefined);
  }

  log(`preflight ok; stopping ${targetName}`);
  await target.stop({ t: 15 });
  await target.remove();

  let created: Docker.Container | null = null;
  try {
    created = await docker.createContainer(createOptions);
    await created.start();
    log(`recreated ${targetName} with ${newImage}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (created) await created.remove({ force: true }).catch(() => undefined);
    const rollbackImage = previousImageId || info.Config.Image;
    log(`recreate failed, rolling back to ${rollbackImage}: ${message}`);
    try {
      const restored = await docker.createContainer({ ...createOptions, Image: rollbackImage });
      await restored.start();
    } catch (rollbackError) {
      const rb = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
      throw new Error(`更新失败且回滚失败: ${message}; ${rb}`);
    }
    throw new Error(`更新失败已回滚: ${message}`);
  }
}
