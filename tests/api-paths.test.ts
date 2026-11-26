import { describe, expect, it } from "vitest";
import { API } from "../packages/shared/src/api";

describe("API paths", () => {
  it("builds validation and per-service action URLs", () => {
    expect(API.stackValidate("my stack")).toBe("/api/stacks/my%20stack/validate");
    expect(API.stackServiceAction("demo", "web app", "restart")).toBe(
      "/api/stacks/demo/services/web%20app/restart",
    );
  });

  it("builds host-proxy paths", () => {
    expect(API.proxy("nas2", "stacks")).toBe("/api/host/nas2/stacks");
    expect(API.proxy("nas2", "/api/stacks/demo")).toBe(
      "/api/host/nas2/stacks/demo",
    );
  });
});
