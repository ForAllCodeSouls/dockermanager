import { describe, expect, it } from "vitest";
import { isValidStackName } from "../packages/shared/src/api";

describe("stack name validation", () => {
  it("accepts common docker compose project names", () => {
    for (const name of ["web", "my-stack", "home_assistant", "a.b-c_1"]) {
      expect(isValidStackName(name)).toBe(true);
    }
  });

  it("rejects traversal and shell-unsafe names", () => {
    for (const name of ["", "..", ".", "a/b", "a b", "-web", "web;rm", "a$b"]) {
      expect(isValidStackName(name)).toBe(false);
    }
  });
});
