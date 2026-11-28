import fs from "node:fs";
import path from "node:path";
import Docker from "dockerode";
import YAML from "yaml";
import {
  isValidStackName,
  type ImageInfo,
  type ImagePruneResult,
  type ImageReference,
  type ImagesResponse,
  type ImageUsage,
  type ImageRemoveResult,
} from "@dockermanager/shared";
import { config } from "./config.js";
import { composeFileFor } from "./docker.js";
import { eventBus } from "./event-bus.js";
import { appendAudit } from "./store.js";

const docker = new Docker();

interface DockerImageSummary {
  Id: string;
  RepoTags?: string[] | null;
  RepoDigests?: string[] | null;
  Created?: number;
  Size?: number;
}

interface DockerContainerSummary {
  Id: string;
  Image: string;
  ImageID?: string;
  State?: string;
  Names?: string[];
  Labels?: Record<string, string>;
}

/** 人类可读的字节数。 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 ? 0 : value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits).replace(/\.?0+$/, "")} ${units[unit]}`;
}

/**
 * 把镜像引用规范化为可比较的键集合：
 * - "nginx" 与 "nginx:latest" 视为同一个
 * - docker.io/library/nginx 与 nginx 视为同一个（去掉常见默认前缀）
 * - sha256 ID 保留完整与短 ID 两种形式
 */
export function imageRefKeys(ref: string): string[] {
  const raw = (ref ?? "").trim().toLowerCase();
  if (!raw || raw.startsWith("<none>")) return [];
  if (raw.startsWith("sha256:")) {
    const hex = raw.slice(7);
    return hex.length >= 12 ? [raw, `sha256:${hex.slice(0, 12)}`] : [raw];
  }
  if (raw.includes("@")) return [raw, raw.split("@")[0] ?? raw];

  const slash = raw.lastIndexOf("/");
  const colon = raw.lastIndexOf(":");
  const hasTag = colon > slash;
  const repo = hasTag ? raw.slice(0, colon) : raw;
  const tag = hasTag ? raw.slice(colon + 1) : "latest";
  const keys = new Set<string>([`${repo}:${tag}`, repo]);
  // 官方镜像的省略写法：nginx == docker.io/library/nginx == library/nginx
  const bare = repo.replace(/^docker\.io\//, "").replace(/^library\//, "");
  if (bare !== repo) {
    keys.add(`${bare}:${tag}`);
    keys.add(bare);
  }
  if (!repo.includes("/")) {
    keys.add(`docker.io/library/${repo}:${tag}`);
    keys.add(`docker.io/library/${repo}`);
    keys.add(`library/${repo}:${tag}`);
    keys.add(`library/${repo}`);
  }
  return [...keys];
}

function isDangling(tags: string[]): boolean {
  return tags.length === 0 || tags.every((tag) => tag.startsWith("<none>"));
}

/** 读取所有项目的 compose 文件，提取 services.*.image 声明。 */
export function declaredImageRefs(): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(config.stacksDir, { withFileTypes: true });
  } catch {
    return result;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !isValidStackName(entry.name)) continue;
    const file = composeFileFor(entry.name);
    if (!file) continue;
    try {
      const doc = YAML.parse(fs.readFileSync(file, "utf8")) as {
        services?: Record<string, { image?: string }>;
      };
      const names = new Set<string>();
      for (const service of Object.values(doc?.services ?? {})) {
        if (!service?.image || typeof service.image !== "string") continue;
        if (service.image.includes("$")) continue;
        for (const key of imageRefKeys(service.image)) names.add(key);
      }
      if (names.size > 0) result.set(entry.name, names);
    } catch {
      // 单个 compose 解析失败不影响其他项目，也不影响镜像列表
    }
  }
  return result;
}

/** 列出镜像并标注引用关系；容器（含已停止）优先于 compose 声明。 */
export async function inspectImages(): Promise<ImagesResponse> {
  const [rawImages, rawContainers] = await Promise.all([
    docker.listImages({ all: true }) as Promise<DockerImageSummary[]>,
    docker.listContainers({ all: true }) as Promise<DockerContainerSummary[]>,
  ]);

  // 按 ID 合并（同一镜像可能同时有 tag 与 digest 条目）
  const groups = new Map<string, {
    fullId: string;
    tags: Set<string>;
    created: number;
    size: number;
    refs: ImageReference[];
  }>();
  for (const item of rawImages) {
    const id = (item.Id ?? "").replace(/^sha256:/, "");
    if (!id) continue;
    const group = groups.get(id) ?? {
      fullId: `sha256:${id}`,
      tags: new Set<string>(),
      created: Number(item.Created) || 0,
      size: 0,
      refs: [],
    };
    for (const tag of item.RepoTags ?? []) {
      if (!tag.startsWith("<none>")) group.tags.add(tag);
    }
    group.size = Math.max(group.size, Number(item.Size) || 0);
    group.created = Math.max(group.created, Number(item.Created) || 0);
    groups.set(id, group);
  }

  const keysForImage = (group: { fullId: string; tags: Set<string> }): Set<string> => {
    const keys = new Set<string>(imageRefKeys(group.fullId));
    for (const tag of group.tags) for (const key of imageRefKeys(tag)) keys.add(key);
    return keys;
  };

  const declared = declaredImageRefs();

  for (const group of groups.values()) {
    const keys = keysForImage(group);
    for (const container of rawContainers) {
      const containerKeys = [
        ...(container.ImageID ? imageRefKeys(container.ImageID) : []),
        ...imageRefKeys(container.Image),
      ];
      if (!containerKeys.some((key) => keys.has(key))) continue;
      group.refs.push({
        kind: "container",
        name: container.Names?.[0]?.replace(/^\//, "") ?? container.Id.slice(0, 12),
        state: container.State ?? "unknown",
        project: container.Labels?.["com.docker.compose.project"],
      });
    }
    if (group.refs.some((ref) => ref.kind === "container")) continue;
    for (const [project, refs] of declared) {
      if (![...refs].some((key) => keys.has(key))) continue;
      group.refs.push({ kind: "compose", name: project, project });
    }
  }

  const images: ImageInfo[] = [];
  const summary: ImagesResponse["summary"] = {
    total: 0,
    used: 0,
    declared: 0,
    unused: 0,
    dangling: 0,
    reclaimableBytes: 0,
  };

  for (const group of groups.values()) {
    const tags = [...group.tags];
    const hasContainer = group.refs.some((ref) => ref.kind === "container");
    const hasCompose = group.refs.some((ref) => ref.kind === "compose");
    let usage: ImageUsage;
    if (hasContainer) usage = "used";
    else if (isDangling(tags)) usage = "dangling";
    else if (hasCompose) usage = "declared";
    else usage = "unused";
    const cleanable = usage !== "used";
    images.push({
      id: group.fullId.replace(/^sha256:/, "").slice(0, 12),
      fullId: group.fullId,
      tags,
      size: group.size,
      sizeLabel: formatBytes(group.size),
      createdAt: new Date(group.created * 1000).toISOString(),
      usage,
      cleanable,
      references: group.refs,
    });
    summary.total += 1;
    summary[usage] += 1;
    if (cleanable) summary.reclaimableBytes += group.size;
  }

  images.sort((a, b) => {
    const order: Record<ImageUsage, number> = { used: 0, declared: 1, unused: 2, dangling: 3 };
    return order[a.usage] - order[b.usage] || (a.tags[0] ?? a.id).localeCompare(b.tags[0] ?? b.id);
  });

  return { generatedAt: new Date().toISOString(), images, summary };
}

/** 解析用户传入的 ID：接受短 ID、完整 ID 或 sha256: 前缀。 */
export function resolveImageId(
  id: string,
  images: { id: string; fullId: string }[],
): string | null {
  const value = id.replace(/^sha256:/, "").toLowerCase();
  if (!value) return null;
  const match = images.find(
    (image) =>
      image.id.toLowerCase().startsWith(value) ||
      image.fullId.replace(/^sha256:/, "").toLowerCase().startsWith(value),
  );
  return match?.fullId ?? null;
}

/** 删除指定镜像。被容器使用的镜像会直接拒绝，避免误删。 */
export async function removeImages(ids: string[]): Promise<ImageRemoveResult[]> {
  const snapshot = await inspectImages();
  const results: ImageRemoveResult[] = [];
  for (const requested of [...new Set(ids)]) {
    const fullId = resolveImageId(requested, snapshot.images);
    const image = snapshot.images.find((item) => item.fullId === fullId);
    const label = image?.tags[0] ?? requested;
    if (!fullId || !image) {
      results.push({ id: requested, ok: false, message: "镜像不存在" });
      continue;
    }
    if (!image.cleanable) {
      const refs = image.references
        .filter((ref) => ref.kind === "container")
        .map((ref) => ref.name)
        .join("、");
      results.push({
        id: requested,
        ok: false,
        message: `镜像正在被容器 ${refs} 使用，无法删除`,
      });
      appendAudit({
        actor: "admin",
        action: "image.remove",
        target: label,
        detail: results[results.length - 1]?.message ?? "删除失败",
        ok: false,
      });
      continue;
    }
    try {
      await docker.getImage(fullId).remove({ force: false, noprune: false });
      results.push({ id: requested, ok: true, message: `已删除 ${label}` });
      appendAudit({
        actor: "admin",
        action: "image.remove",
        target: label,
        detail: `删除镜像 ${image.id}`,
        ok: true,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({ id: requested, ok: false, message });
      appendAudit({
        actor: "admin",
        action: "image.remove",
        target: label,
        detail: message.slice(0, 300),
        ok: false,
      });
    }
  }
  if (results.some((item) => item.ok)) {
    eventBus.publish("image.changed", { removed: results.filter((item) => item.ok).length });
  }
  return results;
}

/** 批量清理。dangling=仅悬空；unused=未使用+悬空；all=所有可清理。 */
export async function pruneImages(scope: "dangling" | "unused" | "all"): Promise<ImagePruneResult> {
  const snapshot = await inspectImages();
  const selected = snapshot.images.filter((image) => {
    if (!image.cleanable) return false;
    if (scope === "dangling") return image.usage === "dangling";
    if (scope === "unused") return image.usage === "unused" || image.usage === "dangling";
    return true;
  });
  const results = await removeImages(selected.map((image) => image.fullId));
  const okIds = new Set(
    results
      .filter((item) => item.ok)
      .flatMap((item) => {
        const hex = item.id.replace(/^sha256:/, "");
        return [hex, hex.slice(0, 12)];
      }),
  );
  const reclaimedBytes = selected
    .filter((image) => {
      const hex = image.fullId.replace(/^sha256:/, "");
      return okIds.has(hex) || okIds.has(hex.slice(0, 12));
    })
    .reduce((sum, image) => sum + image.size, 0);
  const result: ImagePruneResult = {
    removed: results.filter((item) => item.ok).map((item) => item.id),
    failed: results.filter((item) => !item.ok),
    reclaimedBytes,
  };
  appendAudit({
    actor: "admin",
    action: "image.prune",
    target: scope,
    detail: `清理 ${result.removed.length} 个，失败 ${result.failed.length} 个，释放 ${formatBytes(result.reclaimedBytes)}`,
    ok: result.failed.length === 0,
  });
  return result;
}

/** 供项目页按镜像名筛选：返回与给定镜像引用匹配的镜像信息。 */
export function imagesForRefs(refs: string[], images: ImageInfo[]): ImageInfo[] {
  const keys = refs.flatMap(imageRefKeys);
  return images.filter((image) =>
    [...imageRefKeys(image.fullId), ...image.tags.flatMap(imageRefKeys)].some((key) =>
      keys.includes(key),
    ),
  );
}

/** 供测试使用的纯分类逻辑。 */
export function classifyImage(
  tags: string[],
  refs: ImageReference[],
): { usage: ImageUsage; cleanable: boolean } {
  const hasContainer = refs.some((ref) => ref.kind === "container");
  const hasCompose = refs.some((ref) => ref.kind === "compose");
  let usage: ImageUsage;
  if (hasContainer) usage = "used";
  else if (isDangling(tags)) usage = "dangling";
  else if (hasCompose) usage = "declared";
  else usage = "unused";
  return { usage, cleanable: usage !== "used" };
}

export const __paths = { stacksDir: () => path.join(config.stacksDir) };
