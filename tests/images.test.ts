import { describe, expect, it } from "vitest";
import {
  classifyImage,
  formatBytes,
  imageRefKeys,
  resolveImageId,
} from "../packages/server/src/images";
import { API } from "../packages/shared/src/api";

describe("image helpers", () => {
  it("normalizes image references consistently", () => {
    expect(imageRefKeys("nginx")).toContain("docker.io/library/nginx:latest");
    expect(imageRefKeys("nginx:latest")).toContain("docker.io/library/nginx:latest");
    expect(imageRefKeys("ghcr.io/foo/bar:v1")).toContain("ghcr.io/foo/bar:v1");
    expect(imageRefKeys("<none>:<none>")).toEqual([]);
    expect(imageRefKeys("sha256:abcdef1234567890")).toContain("sha256:abcdef123456");
  });

  it("classifies dangling, used, declared and unused images", () => {
    expect(classifyImage([], [])).toEqual({ usage: "dangling", cleanable: true });
    expect(
      classifyImage(["nginx:alpine"], [{ kind: "container", name: "app-1", state: "running" }]),
    ).toEqual({ usage: "used", cleanable: false });
    expect(
      classifyImage(["nginx:alpine"], [{ kind: "compose", name: "demo", project: "demo" }]),
    ).toEqual({ usage: "declared", cleanable: true });
    expect(classifyImage(["nginx:alpine"], [])).toEqual({ usage: "unused", cleanable: true });
  });

  it("formats bytes and resolves short image ids", () => {
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(
      resolveImageId("abcdef123456", [
        { id: "abcdef123456", fullId: "sha256:abcdef1234567890" },
      ]),
    ).toBe("sha256:abcdef1234567890");
    expect(resolveImageId("missing", [{ id: "abcdef123456", fullId: "sha256:abcdef1234567890" }])).toBeNull();
  });

  it("exposes image management endpoints", () => {
    expect(API.images).toBe("/api/images");
    expect(API.imageRemove).toBe("/api/images/remove");
    expect(API.imagePrune).toBe("/api/images/prune");
  });
});
