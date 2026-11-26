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
 * 启动一个一次性 helper 容器来执行真正的容器重建。
 *
 * 绝对不能让主进程自己 stop() 自己：容器内 node 是 PID 1，stop 会杀死进程，
 * 后续 remove/create/start 无法执行，容器停在 exited（restart policy 对显式
 * stop 无效），站点 502。helper 是独立容器，它去操作主容器，二者分离。
 *
 * helper：
 *  - 用新镜像（里面已经包含 updater-agent.js 与重建逻辑）
 *  - 挂载 docker.sock 以操作主容器
 *  - 通过环境变量拿到目标容器名 / 新镜像 / 旧镜像 ID
 *  - AutoRemove，执行完自清理
 *  - 只操作主容器，不碰其他容器与宿主机文件
 */
async function launchHelper(newImage: string, previousImageId: string | null): Promise<void> {
  const targetName = os.hostname().slice(0, 64);
  const helperName = `dockermanager-updater-${Date.now()}`;

  eventBus.publish("update.applied", { image: newImage, phase: "launching-helper" });

  const helper = await docker.createContainer({
    name: helperName,
    Image: newImage,
    Env: [
      `UPDATE_TARGET=${targetName}`,
      `UPDATE_IMAGE=${newImage}`,
      `UPDATE_PREVIOUS_IMAGE=${previousImageId ?? ""}`,
    ],
    Entrypoint: ["node"],
    Cmd: ["packages/server/dist/updater-agent.js"],
    WorkingDir: "/app",
    HostConfig: {
      Binds: ["/var/run/docker.sock:/var/run/docker.sock"],
      AutoRemove: true,
      // helper 不对外暴露端口，也不复制主容器的网络/卷配置。
    },
  });
  await helper.start();
}

export async function checkForUpdate(): Promise<UpdateStatus> {
  if (updateStatus.checking) return updateStatus;
  updateStatus.checking = true;
  try {
    const info = await selfInspect();
    const image = config.imageName || info?.Config?.Image || "";
    if (!image) throw new Error("无法确定镜像名称，请设置 IMAGE_NAME 环境变量");
    version.image = image;

    // 以「容器当前正在运行的镜像 ID」为比较基准，而非本地 tag 的镜像 ID。
    // docker pull 只更新本地 tag，不改变运行中的容器。
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
    void launchHelper(version.image, previousImageId).catch((error) => {
      updateStatus.lastError = error instanceof Error ? error.message : String(error);
      eventBus.publish("update.failed", { error: updateStatus.lastError });
    });
  }, 1500);
  timer.unref();
}

export async function applyUpdate(): Promise<{ ok: boolean; message: string }> {
  const status = await checkForUpdate();
  if (status.lastError) return { ok: false, message: status.lastError };
  if (!status.updateAvailable) return { ok: true, message: "已是最新版本" };
  updateStatus.appliedAt = new Date().toISOString();
  // 用旧镜像 ID 作为回滚兜底，交给 helper 容器。
  scheduleApply(status.currentImageId);
  return { ok: true, message: "发现新版本，已启动更新器用新镜像重建自身" };
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
