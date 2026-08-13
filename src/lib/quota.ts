import { UsageEvent } from "./types";
import { readEffectiveQuotaLimit } from "./quotaConfig";
import {
  commitServerUsageQuotaReservation,
  countServerUsageEvents,
  releaseServerUsageQuotaReservation,
  reserveServerUsageQuota,
  saveServerUsageEvent,
} from "./serverStore";

export type QuotaResult =
  | { ok: true; actor: string; limit: number; remaining: number }
  | { ok: false; actor: string; limit: number; remaining: 0; message: string };

export type QuotaConsumptionResult<T> =
  | { ok: true; quota: Extract<QuotaResult, { ok: true }>; value: T }
  | { ok: false; quota: Extract<QuotaResult, { ok: false }> };

const quotaLocks = new Map<string, Promise<void>>();
const pendingQuotaReservations = new Map<string, number>();

export async function checkQuota(
  userId: string | undefined,
  action: UsageEvent["action"],
): Promise<QuotaResult> {
  const actor = userId ?? "local-beta-user";
  const limit = await readEffectiveQuotaLimit(action);
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const count = await countServerUsageEvents(actor, action, since);
  const remaining = Math.max(0, limit - count);

  if (remaining <= 0) {
    return {
      ok: false,
      actor,
      limit,
      remaining: 0,
      message: `Daily quota for ${action} is exhausted. Please try again later.`,
    };
  }

  return { ok: true, actor, limit, remaining };
}

export async function withQuotaConsumption<T>(
  userId: string | undefined,
  action: UsageEvent["action"],
  operation: (quota: Extract<QuotaResult, { ok: true }>) => Promise<T>,
): Promise<QuotaConsumptionResult<T>> {
  const actor = userId ?? "local-beta-user";
  const lockKey = quotaLockKey(actor, action);
  const prepared = await withQuotaLock(actor, action, async () => {
    const quota = await checkQuota(actor, action);
    if (!quota.ok) {
      return { ok: false as const, quota };
    }

    const pending = pendingQuotaReservations.get(lockKey) ?? 0;
    if (quota.remaining <= pending) {
      return {
        ok: false as const,
        quota: exhaustedQuota(actor, action, quota.limit),
      };
    }

    const event = createUsageEvent(actor, action);
    const reservation = await reserveServerUsageQuota(event, quota.limit, sinceIso());
    if (!reservation.ok) {
      return {
        ok: false as const,
        quota: exhaustedQuota(actor, action, quota.limit),
      };
    }

    pendingQuotaReservations.set(lockKey, pending + 1);
    const reservedQuota = reservation.usedCount === undefined
      ? {
          ...quota,
          remaining: Math.max(1, quota.remaining - pending),
        }
      : {
          ...quota,
          remaining: Math.max(1, quota.limit - (reservation.usedCount - 1)),
        };

    return {
      ok: true as const,
      event,
      quota: reservedQuota,
    };
  });

  if (!prepared.ok) return prepared;

  try {
    const value = await operation(prepared.quota);
    const usageEvent = await commitServerUsageQuotaReservation(prepared.event);
    const consumed = quotaAfterConsumption(prepared.quota);
    return {
      ok: true,
      quota: {
        ...consumed,
        actor: usageEvent.userId ?? consumed.actor,
      },
      value,
    };
  } catch (error) {
    await releaseServerUsageQuotaReservation(prepared.event).catch(() => undefined);
    throw error;
  } finally {
    decrementPendingQuotaReservation(lockKey);
  }
}

export async function consumeQuota(
  userId: string | undefined,
  action: UsageEvent["action"],
  quota?: Extract<QuotaResult, { ok: true }>,
) {
  const checkedQuota = quota ?? await checkQuota(userId, action);
  if (!checkedQuota.ok) return checkedQuota;

  await saveServerUsageEvent(createUsageEvent(checkedQuota.actor, action));
  return quotaAfterConsumption(checkedQuota);
}

export const assertQuota = checkQuota;

function sinceIso() {
  return new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
}

function createUsageEvent(userId: string, action: UsageEvent["action"]): UsageEvent {
  return {
    id: crypto.randomUUID(),
    userId,
    action,
    createdAt: new Date().toISOString(),
  };
}

function quotaAfterConsumption(quota: Extract<QuotaResult, { ok: true }>) {
  return { ...quota, remaining: Math.max(0, quota.remaining - 1) };
}

function exhaustedQuota(
  actor: string,
  action: UsageEvent["action"],
  limit: number,
): Extract<QuotaResult, { ok: false }> {
  return {
    ok: false,
    actor,
    limit,
    remaining: 0,
    message: `Daily quota for ${action} is exhausted. Please try again later.`,
  };
}

async function withQuotaLock<T>(
  actor: string,
  action: UsageEvent["action"],
  operation: () => Promise<T>,
) {
  const lockKey = quotaLockKey(actor, action);
  const previous = quotaLocks.get(lockKey) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current);
  quotaLocks.set(lockKey, tail);

  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (quotaLocks.get(lockKey) === tail) {
      quotaLocks.delete(lockKey);
    }
  }
}

function quotaLockKey(actor: string, action: UsageEvent["action"]) {
  return `${actor}:${action}`;
}

function decrementPendingQuotaReservation(lockKey: string) {
  const pending = pendingQuotaReservations.get(lockKey) ?? 0;
  if (pending <= 1) {
    pendingQuotaReservations.delete(lockKey);
    return;
  }
  pendingQuotaReservations.set(lockKey, pending - 1);
}
