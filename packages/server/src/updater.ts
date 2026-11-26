import os from "node:os";
import Docker from "dockerode";
import type { UpdateStatus } from "@dockermanager/shared";
import { config } from "./config.js";
import { eventBus } from "./event-bus.js";
import { version } from "./version.js";

const docker = new Docker();

export const updateStatus: UpdateStatus = {
  enabled: config.autoUpdate,
  autoApply: config.autoUpdateApply,
  intervalSeconds: config.autoUpdateIntervalSeconds,
  checking: false,
  lastCheckAt: null,
  lastError: null,
  updateAvailable: false,
  appliedAt: null,
  currentImageId: null,
  latestImageId: null,
};

function selfContainer() {
  return docker.getContainer(os.hostname().slice(0, 64));
}

export async function selfInspect(): Promise<Docker.ContainerInspectInfo | null> {
  try {
    return await selfContainer().inspect();
  } catch {
    return null;
  }
}

function imageId(image: string): Promise<string | null> {
  return docker
    .getImage(image)
    .inspect()
    .then((info) => info.Id)
    .catch(() => null);
}

/**
 * 重建容器时，运行期环境变量（含用户配置）来自旧容器，但镜像内烘焙的
 * APP_VERSION / APP_COMMIT / APP_BUILD_TIME 必须取自新镜像，否则诊断面板
 * 会一直显示旧版本号。其余变量保留旧容器的值（用户配置不能被覆盖）。
 */
function mergedEnv(
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

/** 从容器 inspect 结果中挑选可用于重建的 HostConfig 字段（白名单，避免派生字段导致 create 报错）。 */
function recreateHostConfig(info: Docker.ContainerInspectInfo): Docker.HostConfig {
  const hc = info.HostConfig;
  const picked: Docker.HostConfig = {
    Binds: hc.Binds,
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

  // 自定义网络（compose 项目网络）通过 NetworkingConfig 连接，
  // 这里把 NetworkMode 设为第一个网络名，避免与 EndpointsConfig 冲突。
  const networkNames = Object.keys(info.NetworkSettings?.Networks ?? {});
  const mode = hc.NetworkMode ?? "default";
  const isSpecial = ["host", "none", "bridge", "container", "default"].some((n) =>
    mode === n || mode.startsWith(`${n}:`),
  );
  if (!isSpecial && networkNames.length > 0) {
    picked.NetworkMode = networkNames[0];
  } else {
    picked.NetworkMode = mode;
  }

  for (const key of Object.keys(picked) as (keyof Docker.HostConfig)[]) {
    if (picked[key] === undefined) delete picked[key];
  }
  return picked;
}

/**
 * 用新镜像重建自身容器。docker restart 只会重启原容器、沿用旧镜像层，
 * 因此必须 create(新镜像) → stop/remove(旧) → start(新)，才能真正应用更新。
 * 只操作自身容器，不触碰任何其他容器或宿主机文件。
 */
async function recreateSelf(newImage: string, previousImageId: string | null): Promise<void> {
  const self = selfContainer();
  const info = await self.inspect();
  const name = info.Name.replace(/^\//, "");
  const networks = info.NetworkSettings?.Networks ?? {};
  const newImageInfo = await docker.getImage(newImage).inspect().catch(() => null);

  const createOptions: Docker.ContainerCreateOptions = {
    name,
    Image: newImage,
    Env: mergedEnv(info.Config.Env, newImageInfo?.Config?.Env),
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
    NetworkingConfig: Object.keys(networks).length > 0 ? { EndpointsConfig: networks } : undefined,
  };

  eventBus.publish("update.applied", { image: newImage, phase: "recreating" });
  await self.stop({ t: 15 });
  await self.remove();

  try {
    const created = await docker.createContainer(createOptions);
    await created.start();
  } catch (error) {
    // 恢复：用旧镜像 ID 重建，尽量把服务拉回来
    const message = error instanceof Error ? error.message : String(error);
    try {
      const rollbackImage = previousImageId || info.Config.Image;
      const restored = await docker.createContainer({ ...createOptions, Image: rollbackImage });
      await restored.start();
      eventBus.publish("update.failed", { error: `更新失败已回滚: ${message}` });
    } catch (rollbackError) {
      eventBus.publish("update.failed", {
        error: `更新失败且回滚失败: ${message}; ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
      });
    }
    throw error;
  }
}

export async function checkForUpdate(): Promise<UpdateStatus> {
  if (updateStatus.checking) return updateStatus;
  updateStatus.checking = true;
  try {
    const info = await selfInspect();
    const image = config.imageName || info?.Config?.Image || "";
    if (!image) throw new Error("无法确定镜像名称，请设置 IMAGE_NAME 环境变量");
    version.image = image;

    // 关键：必须拿「容器当前正在运行的镜像 ID」作为比较基准，
    // 而不是本地 tag 的镜像 ID。docker pull 会更新本地 tag，但不会改变
    // 正在运行的容器；旧逻辑 pull 前后读的都是同一个 tag，因此永远判为
    // 「已是最新」，容器从不重建，前端也就一直停留在旧 bundle。
    const before = info?.Image ?? (await imageId(image));
    const stream = await docker.pull(image);
    await new Promise<void>((resolve, reject) => {
      docker.modem.followProgress(stream, (error: Error | null) =>
        error ? reject(error) : resolve(),
      );
    });
    const after = await imageId(image);

    updateStatus.currentImageId = before;
    updateStatus.latestImageId = after;
    // 这里报告的是「正在运行」的镜像，诊断面板才不会谎报新版本。
    version.imageId = before;
    updateStatus.updateAvailable = Boolean(after && after !== before);
    updateStatus.lastCheckAt = new Date().toISOString();
    updateStatus.lastError = null;

    if (updateStatus.updateAvailable) {
      eventBus.publish("update.available", { image, from: before, to: after });
    }
    return updateStatus;
  } catch (error) {
    updateStatus.lastError = error instanceof Error ? error.message : String(error);
    updateStatus.lastCheckAt = new Date().toISOString();
    eventBus.publish("update.failed", { error: updateStatus.lastError });
    return updateStatus;
  } finally {
    updateStatus.checking = false;
  }
}

function scheduleApply(previousImageId: string | null): void {
  const timer = setTimeout(() => {
    void recreateSelf(version.image, previousImageId).catch((error) => {
      updateStatus.lastError = error instanceof Error ? error.message : String(error);
    });
  }, 1500);
  timer.unref();
}

export async function applyUpdate(): Promise<{ ok: boolean; message: string }> {
  const status = await checkForUpdate();
  if (status.lastError) return { ok: false, message: status.lastError };
  if (!status.updateAvailable) return { ok: true, message: "已是最新版本" };
  updateStatus.appliedAt = new Date().toISOString();
  // 用旧镜像 ID 作为回滚兜底
  scheduleApply(status.currentImageId);
  return { ok: true, message: "发现新版本，正在用新镜像重建自身以应用更新" };
}

export function startUpdater(): void {
  if (!config.autoUpdate) return;
  const timer = setInterval(() => {
    void checkForUpdate().then((status) => {
      if (status.updateAvailable && config.autoUpdateApply) {
        updateStatus.appliedAt = new Date().toISOString();
        scheduleApply(status.currentImageId);
      }
    });
  }, config.autoUpdateIntervalSeconds * 1000);
  timer.unref();

  const initial = setTimeout(() => void checkForUpdate(), 15000);
  initial.unref();
}

export async function selfLogs(lines = 200): Promise<string[]> {
  try {
    const info = await selfInspect();
    if (!info || !info.Config.Tty) {
      // non-TTY streams carry an 8-byte multiplex header per frame
      const raw = (await selfContainer().logs({
        stdout: true,
        stderr: true,
        tail: lines,
        timestamps: true,
      })) as Buffer;
      return raw
        .toString("utf8")
        .split("\n")
        .map((line) => line.replace(/^[\u0000-\u0008]+/, ""))
        .filter((line) => line.trim().length > 0)
        .slice(-lines);
    }
    const raw = (await selfContainer().logs({
      stdout: true,
      stderr: true,
      tail: lines,
      timestamps: true,
    })) as Buffer;
    return raw.toString("utf8").split("\n").filter(Boolean).slice(-lines);
  } catch (error) {
    return [`[无法读取容器日志] ${error instanceof Error ? error.message : String(error)}`];
  }
}
