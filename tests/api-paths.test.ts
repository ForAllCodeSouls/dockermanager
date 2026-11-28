import { describe, expect, it } from "vitest";
import { API } from "../packages/shared/src/api";

describe("API paths", () => {
  it("builds validation and per-service action URLs", () => {
    expect(API.stackValidate("my stack")).toBe("/api/stacks/my%20stack/validate");
    expect(API.stackServiceAction("demo", "web app", "restart")).toBe(
      "/api/stacks/demo/services/web%20app/restart",
    );
  });

  it("builds resource and maintenance paths", () => {
    expect(API.containerInspect("abc123")).toBe("/api/containers/abc123/inspect");
    expect(API.containerFiles("abc123", "/etc/nginx")).toBe(
      "/api/containers/abc123/files?path=%2Fetc%2Fnginx",
    );
    expect(API.containerFile("abc123", "/etc/hosts")).toBe(
      "/api/containers/abc123/file?path=%2Fetc%2Fhosts",
    );
    expect(API.volumes).toBe("/api/volumes");
    expect(API.volume("my vol")).toBe("/api/volumes/my%20vol");
    expect(API.networks).toBe("/api/networks");
    expect(API.network("abc123")).toBe("/api/networks/abc123");
    expect(API.logFileRaw).toBe("/api/logs/file/raw");
    expect(API.systemPrune).toBe("/api/system/prune");
    expect(API.backup).toBe("/api/backup");
    expect(API.backupRestore).toBe("/api/backup/restore");
  });

  it("builds host-proxy paths", () => {
    expect(API.proxy("nas2", "stacks")).toBe("/api/host/nas2/stacks");
    expect(API.proxy("nas2", "/api/stacks/demo")).toBe(
      "/api/host/nas2/stacks/demo",
    );
  });
});
