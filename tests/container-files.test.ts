import { describe, expect, it } from "vitest";
import { parseLsLine, safeId, safePath } from "../packages/server/src/container-files.js";

describe("容器文件访问白名单", () => {
  it("拒绝路径穿越与相对路径", () => {
    expect(safePath("/etc/hosts")).toBe(true);
    expect(safePath("/")).toBe(true);
    expect(safePath("etc/hosts")).toBe(false);
    expect(safePath("/etc/../passwd")).toBe(false);
    expect(safePath("/etc/hosts\0.txt")).toBe(false);
  });

  it("拒绝带空格或引号的容器 ID", () => {
    expect(safeId("a1b2c3d4e5f6")).toBe(true);
    expect(safeId("sha256:abc")).toBe(false);
    expect(safeId("abc; rm -rf /")).toBe(false);
    expect(safeId("")).toBe(false);
  });
});

describe("容器文件列表解析", () => {
  it("解析 GNU ls --time-style 输出", () => {
    const entry = parseLsLine(
      "-rw-r--r-- 1 root root 12 2026-11-28T09:04:57 app.log",
      "/var/log",
    );
    expect(entry).toMatchObject({
      name: "app.log",
      path: "/var/log/app.log",
      type: "file",
      size: 12,
      modifiedAt: "2026-11-28T09:04:57",
    });
  });

  it("解析 BusyBox ls -la 输出并去掉链接目标", () => {
    const dir = parseLsLine("drwxr-xr-x    2 root     root          4096 Nov 28 09:04 config", "/");
    expect(dir).toMatchObject({ name: "config", path: "/config", type: "dir" });
    const link = parseLsLine(
      "lrwxrwxrwx    1 root     root            11 Nov 28 09:04 current -> /etc/config",
      "/config",
    );
    expect(link).toMatchObject({ name: "current", path: "/config/current", type: "link" });
  });

  it("跳过 total 和 . / .. 行", () => {
    expect(parseLsLine("total 16", "/")).toBeNull();
    expect(parseLsLine("drwxr-xr-x 1 root root 4096 2026-11-28T09:04:57 .", "/")).toBeNull();
  });
});
