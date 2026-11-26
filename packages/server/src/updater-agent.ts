import Docker from "dockerode";
import { performRecreate } from "./recreate.js";

/**
 * 自更新的真正执行者，运行在独立的一次性 helper 容器里。
 *
 * 为什么需要独立容器：主容器里 node 是 PID 1，主进程若调用 stop(self) 会被
 * Docker 杀死，后续重建步骤无法执行。helper 是被「新镜像」临时拉起的一次性容器，
 * 它去 stop/remove/create/start 主容器，二者分离，重建才能完整跑完。
 *
 * helper 由主进程通过 os.hostname() 定位目标容器并启动，执行完自动退出。
 * 全程只操作主容器自身，不触碰任何其他容器或宿主机文件。
 */
async function main(): Promise<void> {
  const targetName = process.env.UPDATE_TARGET;
  const newImage = process.env.UPDATE_IMAGE;
  const previousImageId = process.env.UPDATE_PREVIOUS_IMAGE || null;

  if (!targetName || !newImage) {
    console.error("[updater-agent] 缺少 UPDATE_TARGET / UPDATE_IMAGE");
    process.exit(1);
    return;
  }

  const docker = new Docker();
  console.log(
    `[updater-agent] 开始重建 ${targetName} -> ${newImage} (previous=${previousImageId ?? "unknown"})`,
  );
  try {
    await performRecreate(docker, targetName, newImage, previousImageId, (msg) =>
      console.log(`[updater-agent] ${msg}`),
    );
    console.log("[updater-agent] 重建完成");
  } catch (error) {
    console.error(
      `[updater-agent] 重建失败: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}

await main();
