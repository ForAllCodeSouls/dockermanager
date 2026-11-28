/**
 * 项目级任务互斥锁。
 *
 * 前端按钮锁只约束单个页面，多个浏览器/手机同时操作同一个项目仍可能撞车。
 * 这里在服务端按项目名持有锁：同一项目同时只允许一个未结束的任务。
 * 只记录「未完成」的任务，任务结束即释放，不需要过期清理。
 */
interface ActiveTask {
  action: string;
  startedAt: number;
}

const active = new Map<string, ActiveTask>();

export class TaskBusyError extends Error {
  constructor(
    readonly stack: string,
    readonly activeAction: string,
  ) {
    super(`项目「${stack}」正在执行「${activeAction}」，请等它完成后再操作`);
    this.name = "TaskBusyError";
  }
}

/** 占用项目；若已有未完成任务则抛 TaskBusyError。 */
export function acquireStack(stack: string, action: string): void {
  const current = active.get(stack);
  if (current) throw new TaskBusyError(stack, current.action);
  active.set(stack, { action, startedAt: Date.now() });
}

/** 释放项目锁。幂等。 */
export function releaseStack(stack: string): void {
  active.delete(stack);
}

/** 当前是否有未结束任务（供批量操作等其它入口查询）。 */
export function isStackBusy(stack: string): boolean {
  return active.has(stack);
}

/** 仅供测试/诊断：当前占用的项目数。 */
export function activeStackCount(): number {
  return active.size;
}
