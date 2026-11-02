/**
 * 执行轮次（Plan）相关的纯逻辑。
 *
 * 「从头开始」会作废上一轮的 Plan 并新建一轮，旧任务被标记为 cancelled，
 * 但退回/校验事件仍留在库里。面板要只显示当前这一轮的退回记录，
 * 否则新一轮判「合格」也会挂着上一轮的历史退回。
 */

export type RoundTask = { id: number; planId?: number | null; status?: string };
export type RoundPlan = { id: number; status?: string; version?: number };
export type RoundEvent = { taskId?: number | null; planId?: number | null };

/**
 * 当前活跃轮次的 Plan id。
 * 优先用 status === 'active' 的 Plan；没有时退回任务里出现过的最大 planId。
 */
export function activePlanId(tasks: readonly RoundTask[] | undefined, plans: readonly RoundPlan[] | undefined): number | null {
  const active = (plans ?? []).find((plan) => plan.status === 'active');
  if (active && typeof active.id === 'number') return active.id;
  let latest: number | null = null;
  for (const task of tasks ?? []) {
    const planId = task.planId;
    if (typeof planId === 'number' && (latest === null || planId > latest)) latest = planId;
  }
  return latest;
}

/**
 * 事件是否属于当前轮次。
 * 有 planId 的按 planId 比对；旧数据没有 planId 时，看关联任务是否还活在本轮。
 */
export function eventInCurrentRound(
  event: RoundEvent,
  planId: number | null,
  liveTaskIds: ReadonlySet<number>,
): boolean {
  if (planId === null) return true;
  const eventPlanId = event.planId;
  if (typeof eventPlanId === 'number') return eventPlanId === planId;
  return typeof event.taskId === 'number' && liveTaskIds.has(event.taskId);
}
