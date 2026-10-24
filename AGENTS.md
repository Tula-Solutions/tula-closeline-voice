# tula-closeline-voice

softphone, Copilot and Inbound Agent calls

Kind: **service**. Common standards for every Closeline repo are in `.claude/COMMON.md`, synced
from the hub (`tula-closeline`). This file holds only what is specific to this repo. Keep it under
200 lines: put detail in a path-scoped rule under `.claude/rules/` or a decision record in the hub.

## Commands

| Command | Use |
| --- | --- |
| `bun install` | install, including the tagged `tula-closeline-*` libraries |
| `bun run verify` | the full gate, exactly what CI runs |
| `bun run verify:changed` | the quick gate the Stop hook runs |
| `bun test` | tests |
| `bun run test:integration` | the `*.integration.ts` suites against compose Postgres (`docker compose up -d --wait`; `POSTGRES_PORT` moves it); not part of `verify` |
| `bun run bench` | the benchmarks and their budgets |
| `bun run openapi` | rewrite `openapi.json` after a route or schema change |

Other scripts are in `package.json`.

## Layout

The shape in `.claude/COMMON.md` is built; add modules under `src/modules/<name>/`.

- `src/container.ts` is the only composition root: env, kit logger, clock, token verifier, the
  Line store (Postgres, over `createDb`), number provisioner, organization directory, readiness
  checks (`database`), `lifecycle`, `reportError`, and `close`. `src/testing.ts` builds the same container from in-memory doubles.
- `reportError(error, context)` is the one seam for unexpected errors (5xx only). It logs through
  the kit today; the error tracker is wired in there and nowhere else. It must not throw. Call
  `reportSafely`, never it directly.
- `src/http/` is the middleware stack in `createBaseApp`: request id, error guard, body limit,
  error handler, 404. Modules build routes with `createRouter()` and `errorResponse(...)` so every
  route is described for OpenAPI and failures take the contract's `area.reason` codes.
- Readiness: add a `ReadinessCheck` to `readinessChecks` when a dependency arrives. `/readyz` runs
  them concurrently, each with `READINESS_TIMEOUT_MS`, and never returns the failure reason.
  `/healthz` checks nothing.
- Shutdown (`src/shutdown.ts`): on SIGTERM `/readyz` goes 503, `SHUTDOWN_GRACE_MS` passes, the
  server stops accepting, `SHUTDOWN_TIMEOUT_MS` bounds the drain, then it exits. A second signal
  over a second later exits at once.
- `src/modules/line/` is the Lines module (router, service). Routes sit under `/v1` behind
  `authenticate` (`src/http/auth.ts`); the Organization and role come from the verified token only.
  Add, assign and release are Owner and Admin; list and read are every role. Every tenant query
  goes through `withOrganization` (`src/adapters/postgres/line-store.ts`). `providerSid` never
  leaves the service.
- `src/modules/call/` places and lists Calls (`POST/GET /v1/calls`, `GET /v1/calls/{id}`,
  `PUT /v1/calls/{id}/wrap-up`). `state.ts` holds the one edge table (`canTransition`): `live` is
  unreachable without a stored Disclosure version, and the stores enforce it. Placing needs an
  `Idempotency-Key`, stores the `ringing` Call in the idempotency transaction, then walks the
  provider after commit: place, play the Disclosure (`DISCLOSURE_WORDING`, version 1, in
  `service.ts`; no setting, ADR 0003), bridge the Rep, start the Recording, `live`. A Disclosure
  failure ends the Call `failed`. Visibility: Rep own, Manager own plus `teamRepsOf`, Owner and
  Admin all; any other Call is `call.not_found`. `Calls.end` is service-only (no route yet).
  The place-Call path is not a hot path: a Rep places a few Calls a minute and it is bound by the
  provider's latency, so it has no benchmark.
- Ports (`src/ports/`): `CallStore` (Postgres and memory; every event row is written in the same
  transaction as the change), `LineStore`, `IdempotencyStore` (stored answers of `Idempotency-Key`
  requests; `POST /v1/lines` reserves the key, buys, inserts the Line and completes the key in one
  transaction, see `src/modules/idempotency/service.ts`), `NumberProvisioner` (buy, port, release a number),
  `OrganizationDirectory` (Teams, Reps and a Manager's Team Reps via `teamRepsOf`, owned by core; `src/adapters/core-http/` asks core's
  `/internal/v1/directory/*` routes with a per-attempt timeout and bounded jittered retry on
  network errors and 5xx, and any failure is `server.unavailable`; an Organization that is not
  `active` has no Membership). Memory adapters are in `src/adapters/memory/`;
  `src/adapters/unconfigured/` fails closed with `server.unavailable` until the Twilio number
  adapter exists.
- `src/modules/webhook/` receives Twilio status and recording callbacks (unauthenticated, verified by
  `X-Twilio-Signature` over `WEBHOOK_BASE_URL` + path; bad signature is 403 and changes nothing;
  `CallEventStore` appends one `provider_callback` row per event id, duplicates change nothing).
  `src/modules/softphone/` mints the short-lived browser token (`POST /v1/softphone/token`, Rep and
  Organization only; `OrganizationDirectory.membershipOf`). `telephony` is built in `container.ts`:
  the kit Twilio adapter over the Postgres `TwilioStore` (`src/adapters/postgres/twilio-store.ts`; rows carry `expires_at`; `purgeExpiredTwilio` in `twilio-purge.ts` removes one Organization's expired rows in bounded batches). With `TELEPHONY_PROVIDER=twilio`, `server.ts` starts the scheduled purge (`src/modules/purge/`: `schedule.ts` runs a jittered, non-overlapping timer; `twilio-purge-job.ts` pages `voice.twilio_orgs_with_expired` through the `TwilioPurgeSource` port, caps each run, and resumes from an in-memory cursor so failing Organizations cannot starve the rest). Each purge-source query is bounded by `TWILIO_PURGE_QUERY_TIMEOUT_MS` twice over: Postgres `statement_timeout` set locally in the transaction, a purge starts no new batch after one timeout (it reports undrained), and `bound-source.ts` rejects a scan after the timeout and a purge after twice it with `PurgeQueryTimeoutError`, so a hung source cannot hold the run. A timeout is reported like any failure and the next tick runs normally; shutdown waits for at most one in-flight query.
- Log errors with `describeError`, never the raw error.
- `openapi.json` is generated: `bun run openapi`; `verify` fails if it is stale. No database yet:
  the voice schema comes from `tula-closeline-db`; migrations are never made here.

## Env keys (`src/env.ts`, mirrored in `.env.example`)

`ENVIRONMENT` (required, no default), `PORT`, `LOG_LEVEL`, `READINESS_TIMEOUT_MS`,
`SHUTDOWN_TIMEOUT_MS`, `SHUTDOWN_GRACE_MS`, `MAX_REQUEST_BODY_BYTES`, and the deployment keys
`REGION`, `DATABASE_URL`, `AUTH_JWKS_URL`, `AUTH_ISSUER`, `AUTH_AUDIENCE`, `AWS_REGION`,
`QUEUE_URL`, `STORAGE_BUCKET`, `TELEPHONY_PROVIDER` (`memory|twilio`), and with `twilio` the keys
`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_API_KEY_SID`, `TWILIO_API_KEY_SECRET`,
`TWILIO_TWIML_APP_SID`, `WEBHOOK_BASE_URL` (the public https origin Twilio signs; http only local),
`CORE_INTERNAL_URL` and `CORE_INTERNAL_TOKEN` (core's origin and the `Authorization: Bearer` secret
in its `INTERNAL_API_TOKENS`; set together; required outside local, where unset means an empty
in-memory directory),
and the purge schedule keys `TWILIO_PURGE_INTERVAL_MS` (default 900000) and
`TWILIO_PURGE_MAX_ORGANIZATIONS` (default 200), `TWILIO_PURGE_QUERY_TIMEOUT_MS` (default 10000). The deployment keys have
local defaults only when `ENVIRONMENT=local` and are required elsewhere; `QUEUE_ENDPOINT` and
`STORAGE_ENDPOINT` are local-only. Add a key in both files.

## Hot paths

The per-request middleware stack (`createBaseApp`) and `/healthz`, and the Twilio webhook handler
(`Webhooks.receive`, `POST /webhooks/twilio/*`: signature check, then one idempotent insert; O(body
size)). Budgets are in `bench/` (`bench/webhook.bench.test.ts`).

A benchmark times `measure(operation)`: a warm-up, then several batches, gated on the fastest, so a
noisy runner cannot fail it but a real regression (every batch slower) does. Budget is about 5x the
typical best batch, written in the file. `bun run bench` is part of `verify`. Add a benchmark and
name the function here when a new hot path appears.

## Issues

All tickets live in the hub: `gh issue list -R Tula-Solutions/tula-closeline --label repo:voice`.
