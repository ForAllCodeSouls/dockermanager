import { describe, expect, it } from "vitest";
import {
  TaskBusyError,
  acquireStack,
  activeStackCount,
  isStackBusy,
  releaseStack,
} from "../packages/server/src/task-lock.js";

describe("项目级任务互斥锁", () => {
  it("同一项目已有任务时拒绝第二个，并给出明确提示", () => {
    const stack = `lock-a-${Math.random().toString(36).slice(2)}`;
    acquireStack(stack, "启动");
    try {
      expect(isStackBusy(stack)).toBe(true);
      expect(() => acquireStack(stack, "停止")).toThrowError(TaskBusyError);
      try {
        acquireStack(stack, "停止");
      } catch (error) {
        expect((error as TaskBusyError).message).toContain(stack);
        expect((error as TaskBusyError).message).toContain("启动");
        expect((error as TaskBusyError).activeAction).toBe("启动");
      }
    } finally {
      releaseStack(stack);
    }
  });

  it("不同项目互不阻塞", () => {
    const a = `lock-b-${Math.random().toString(36).slice(2)}`;
    const b = `lock-c-${Math.random().toString(36).slice(2)}`;
    acquireStack(a, "启动");
    acquireStack(b, "拉取");
    try {
      expect(isStackBusy(a)).toBe(true);
      expect(isStackBusy(b)).toBe(true);
    } finally {
      releaseStack(a);
      releaseStack(b);
    }
  });

  it("释放后可再次占用，重复释放幂等", () => {
    const stack = `lock-d-${Math.random().toString(36).slice(2)}`;
    const before = activeStackCount();
    acquireStack(stack, "启动");
    expect(activeStackCount()).toBe(before + 1);
    releaseStack(stack);
    releaseStack(stack);
    expect(isStackBusy(stack)).toBe(false);
    expect(activeStackCount()).toBe(before);
    expect(() => acquireStack(stack, "重启")).not.toThrow();
    releaseStack(stack);
  });
});
