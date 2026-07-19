# Failover demonstration

`bun run demo` performs the deterministic database-backed sequence and asserts that a late result loses:

1. Submit with zero donors and show `queued`.
2. Connect donor A and lease the oldest compatible job.
3. Let donor A's lease expire.
4. Persist `job.retrying`.
5. Connect donor B and complete the retry.
6. Submit donor A's late result and observe `late_or_invalid`.
7. Show exactly one committed attempt and the full persisted event sequence.

For the real network demonstration:

1. Start the API/PostgreSQL stack and an OpenAI-compatible backend on each donor.
2. Create two pairing codes and run `relay-host setup` on A and B.
3. Start only A, submit a durable job, then stop A during a deliberately slow provider request.
4. Wait at least the configured lease duration (20 seconds by default), then start B.
5. Reconnect SSE using the last observed event ID and fetch the result.
6. Query the database read-only to confirm one `attempts.committed = true` row.

Repeat this before launch and after changes to protocol, scheduler, migrations, reverse proxy, or WebSocket infrastructure.
