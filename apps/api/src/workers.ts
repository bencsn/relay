import type { ServerConfig } from "@relay/config";
import {
  claimWebhookDelivery,
  type Database,
  expireQueuedJobs,
  finishWebhookDelivery,
  purgeExpiredResults,
  reclaimExpiredLeases,
  resetStuckWebhookDeliveries,
} from "@relay/db";
import type { Logger } from "./logger.ts";
import { accountWebhookSecret, deliverWebhook } from "./webhooks.ts";

export function startWorkers(sql: Database, config: ServerConfig, logger: Logger) {
  let stopped = false;
  const timers: ReturnType<typeof setInterval>[] = [];
  const guard = (name: string, task: () => Promise<unknown>) => {
    if (stopped) return;
    void task().catch((error) =>
      logger.error("worker.failed", {
        worker: name,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  };

  timers.push(
    setInterval(
      () =>
        guard("leases", async () => {
          const reclaimed = await reclaimExpiredLeases(sql, config.RESULT_RETENTION_SECONDS);
          const expired = await expireQueuedJobs(sql, config.RESULT_RETENTION_SECONDS);
          if (reclaimed || expired)
            logger.info("queue.maintenance", {
              reclaimed_leases: reclaimed,
              expired_jobs: expired,
            });
        }),
      1000,
    ),
  );
  timers.push(setInterval(() => guard("retention", () => purgeExpiredResults(sql)), 60_000));
  timers.push(
    setInterval(
      () =>
        guard("webhooks", async () => {
          const delivery = await claimWebhookDelivery(sql);
          if (!delivery) return;
          const body = JSON.stringify({
            event_id: delivery.event_id,
            type: delivery.event_type,
            job_id: delivery.job_id,
            state: delivery.event_type.replace("job.", ""),
            timestamp: delivery.created_at.toISOString(),
            result_url: `/v1/jobs/${delivery.job_id}/result`,
          });
          try {
            await deliverWebhook(
              delivery.url,
              body,
              accountWebhookSecret(config.WEBHOOK_SIGNING_SECRET, delivery.account_id),
              delivery.id,
            );
            await finishWebhookDelivery(sql, delivery.id, true);
          } catch (error) {
            await finishWebhookDelivery(
              sql,
              delivery.id,
              false,
              error instanceof Error ? error.message : String(error),
            );
          }
        }),
      250,
    ),
  );
  guard("webhook_recovery", () => resetStuckWebhookDeliveries(sql));

  return () => {
    stopped = true;
    for (const timer of timers) clearInterval(timer);
  };
}
