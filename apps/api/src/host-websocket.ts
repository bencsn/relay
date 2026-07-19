import { createHash } from "node:crypto";
import type { ServerConfig } from "@relay/config";
import {
  acceptLease,
  authenticateDonor,
  claimNextJob,
  commitAttempt,
  type Database,
  failAttempt,
  heartbeatLease,
  markAttemptStarted,
  markDonorOffline,
  touchDonor,
  updateDonorPresence,
} from "@relay/db";
import {
  canonicalResultSchema,
  type HostCapabilities,
  hostMessageSchema,
  type ServerMessage,
} from "@relay/protocol";
import type { Hono } from "hono";
import { upgradeWebSocket } from "hono/bun";
import type { Logger } from "./logger.ts";

interface Dependencies {
  sql: Database;
  config: ServerConfig;
  logger: Logger;
}

interface ConnectionState {
  donorId: string;
  sessionId?: string;
  lastSequence: number;
  capabilities?: HostCapabilities;
  ready: boolean;
  closed: boolean;
  inflight: Set<string>;
  timer?: ReturnType<typeof setInterval>;
}

function rawToken(header?: string) {
  return header?.match(/^Bearer\s+(.+)$/i)?.[1];
}

export function attachHostWebSocket(app: Hono<any>, deps: Dependencies) {
  app.get(
    "/v1/hosts/connect",
    async (c, next) => {
      const token = rawToken(c.req.header("authorization"));
      if (!token)
        return c.json(
          { error: { code: "invalid_device_token", message: "Missing donor credential." } },
          401,
        );
      const donor = await authenticateDonor(deps.sql, deps.config.DEVICE_TOKEN_PEPPER, token);
      if (!donor)
        return c.json(
          { error: { code: "invalid_device_token", message: "Invalid donor credential." } },
          401,
        );
      c.set("donor", donor);
      await next();
    },
    upgradeWebSocket((c) => {
      const donor = c.get("donor") as { id: string; name: string };
      const state: ConnectionState = {
        donorId: donor.id,
        lastSequence: -1,
        ready: false,
        closed: false,
        inflight: new Set(),
      };
      let socket:
        | { send(data: string): void; close(code?: number, reason?: string): void }
        | undefined;

      const send = (message: ServerMessage) => socket?.send(JSON.stringify(message));

      const offer = async () => {
        if (state.closed || !state.ready || !state.capabilities || !socket) return;
        while (state.inflight.size < state.capabilities.policy.maxConcurrency) {
          const lease = await claimNextJob(
            deps.sql,
            state.donorId,
            state.capabilities,
            deps.config.LEASE_SECONDS,
            deps.config.MAX_CONSUMER_ACTIVE_LEASES,
          );
          if (!lease) break;
          state.inflight.add(lease.leaseId);
          send({
            type: "lease.offer",
            leaseId: lease.leaseId,
            attemptId: lease.attemptId,
            expiresAt: lease.expiresAt.toISOString(),
            request: lease.request,
          });
          setTimeout(
            () => {
              state.inflight.delete(lease.leaseId);
            },
            (deps.config.LEASE_SECONDS + 1) * 1000,
          );
        }
      };

      return {
        onOpen(_event, ws) {
          socket = ws;
          deps.logger.info("donor.connected", { donor_id: state.donorId });
        },
        async onMessage(event, ws) {
          try {
            const text =
              typeof event.data === "string"
                ? event.data
                : new TextDecoder().decode(event.data as ArrayBuffer);
            const message = hostMessageSchema.parse(JSON.parse(text));
            if (state.sessionId && message.sessionId !== state.sessionId)
              throw new Error("session_id_changed");
            if (message.sequence <= state.lastSequence)
              throw new Error("replayed_or_out_of_order_message");
            state.sessionId = message.sessionId;
            state.lastSequence = message.sequence;
            await touchDonor(deps.sql, state.donorId);

            switch (message.type) {
              case "host.hello":
                send({
                  type: "host.accepted",
                  sessionId: message.sessionId,
                  heartbeatSeconds: deps.config.HEARTBEAT_SECONDS,
                });
                break;
              case "host.capabilities":
                state.capabilities = message.capabilities;
                await updateDonorPresence(deps.sql, state.donorId, message.capabilities);
                break;
              case "host.ready":
                if (!state.capabilities) throw new Error("capabilities_required");
                state.ready = true;
                state.timer ??= setInterval(
                  () =>
                    void offer().catch((error) =>
                      deps.logger.error("scheduler.offer_failed", {
                        donor_id: state.donorId,
                        error: String(error),
                      }),
                    ),
                  500,
                );
                await offer();
                break;
              case "lease.accept": {
                const accepted = await acceptLease(
                  deps.sql,
                  state.donorId,
                  message.leaseId,
                  message.attemptId,
                );
                if (!accepted)
                  send({
                    type: "lease.cancel",
                    leaseId: message.leaseId,
                    reason: "lease_not_owned",
                  });
                break;
              }
              case "lease.heartbeat": {
                const renewed = await heartbeatLease(
                  deps.sql,
                  state.donorId,
                  message.leaseId,
                  message.attemptId,
                  deps.config.LEASE_SECONDS,
                );
                if (!renewed)
                  send({ type: "lease.cancel", leaseId: message.leaseId, reason: "lease_expired" });
                break;
              }
              case "attempt.started": {
                const started = await markAttemptStarted(
                  deps.sql,
                  state.donorId,
                  message.leaseId,
                  message.attemptId,
                );
                if (!started)
                  send({
                    type: "lease.cancel",
                    leaseId: message.leaseId,
                    reason: "lease_not_owned",
                  });
                break;
              }
              case "attempt.completed": {
                const result = canonicalResultSchema.parse(message.result);
                const computed = createHash("sha256").update(JSON.stringify(result)).digest("hex");
                if (computed !== message.contentHash) throw new Error("content_hash_mismatch");
                if (Buffer.byteLength(JSON.stringify(result)) > deps.config.MAX_OUTPUT_BYTES)
                  throw new Error("result_too_large");
                const outcome = await commitAttempt(
                  deps.sql,
                  state.donorId,
                  message.leaseId,
                  message.attemptId,
                  result,
                  computed,
                  deps.config.RESULT_RETENTION_SECONDS,
                );
                state.inflight.delete(message.leaseId);
                if (outcome !== "committed")
                  send({ type: "lease.cancel", leaseId: message.leaseId, reason: outcome });
                await offer();
                break;
              }
              case "attempt.failed":
                await failAttempt(
                  deps.sql,
                  state.donorId,
                  message.leaseId,
                  message.attemptId,
                  {
                    code: message.code,
                    message: message.message,
                    retryable: message.retryable,
                  },
                  deps.config.RESULT_RETENTION_SECONDS,
                );
                state.inflight.delete(message.leaseId);
                await offer();
                break;
            }
          } catch (error) {
            deps.logger.warn("donor.message_rejected", {
              donor_id: state.donorId,
              error: error instanceof Error ? error.message : String(error),
            });
            ws.send(
              JSON.stringify({
                type: "error",
                code: "invalid_message",
                message: "Donor message rejected.",
              } satisfies ServerMessage),
            );
            if (
              error instanceof Error &&
              ["replayed_or_out_of_order_message", "session_id_changed"].includes(error.message)
            )
              ws.close(1008, "protocol violation");
          }
        },
        async onClose() {
          state.closed = true;
          if (state.timer) clearInterval(state.timer);
          await markDonorOffline(deps.sql, state.donorId);
          deps.logger.info("donor.disconnected", { donor_id: state.donorId });
        },
      };
    }),
  );
}
