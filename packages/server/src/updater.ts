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
  return docker.getContainer(os.hostname());
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

export async function checkForUpdate(): Promise<UpdateStatus> {
  if (updateStatus.checking) return updateStatus;
  updateStatus.checking = true;
  try {
    const info = await selfInspect();
    const image = config.imageName || info?.Config?.Image || "";
    if (!image) throw new Error("无法确定镜像名称，请设置 IMAGE_NAME 环境变量");
    version.image = image;

    const before = await imageId(image);
    const stream = await docker.pull(image);
    await new Promise<void>((resolve, reject) => {
      docker.modem.followProgress(stream, (error: Error | null) =>
        error ? reject(error) : resolve(),
      );
    });
    const after = await imageId(image);

    updateStatus.currentImageId = before;
    updateStatus.latestImageId = after;
    version.imageId = after;
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

function scheduleRestart(): void {
  const timer = setTimeout(async () => {
    try {
      eventBus.publish("update.applied", { image: version.image });
      await selfContainer().restart();
    } catch (error) {
      eventBus.publish("update.failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, 1500);
  timer.unref();
}

export async function applyUpdate(): Promise<{ ok: boolean; message: string }> {
  const status = await checkForUpdate();
  if (status.lastError) return { ok: false, message: status.lastError };
  if (!status.updateAvailable) return { ok: true, message: "已是最新版本" };
  updateStatus.appliedAt = new Date().toISOString();
  scheduleRestart();
  return { ok: true, message: "发现新版本，正在重启自身以应用更新" };
}

export function startUpdater(): void {
  if (!config.autoUpdate) return;
  const timer = setInterval(() => {
    void checkForUpdate().then((status) => {
      if (status.updateAvailable && config.autoUpdateApply) scheduleRestart();
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
