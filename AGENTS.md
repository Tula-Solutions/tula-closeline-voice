# tula-closeline-voice

softphone, Copilot and Inbound Agent calls

Kind: **service**. Common standards for every Closeline repo are in `.claude/COMMON.md`, synced
from the hub (`tula-closeline`). This file holds only what is specific to this repo. Keep it under
200 lines: put detail in a path-scoped rule under `.claude/rules/` or a decision record in the hub.

## Commands

| Command                    | Use                                                                                                                                    |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `bun install`              | install, including the tagged `tula-closeline-*` libraries                                                                             |
| `bun run verify`           | the full gate, exactly what CI runs                                                                                                    |
| `bun run verify:changed`   | the quick gate the Stop hook runs                                                                                                      |
| `bun test`                 | tests                                                                                                                                  |
| `bun run test:integration` | the `*.integration.ts` suites against compose Postgres (`docker compose up -d --wait`; `POSTGRES_PORT` moves it); not part of `verify` |
| `bun run bench`            | the benchmarks and their budgets                                                                                                       |
| `bun run openapi`          | rewrite `openapi.json` after a route or schema change                                                                                  |

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
- `src/modules/agent-settings/` is the Inbound Agent settings and Qualification questions (`GET/PUT /v1/agent/settings`, `GET/POST /v1/agent/questions`, `GET/PATCH/DELETE /v1/agent/questions/{id}`, `PUT /v1/agent/question-order`). Reads need Owner, Admin or Manager; writes need Owner or Admin. No row means the defaults, with the Agent paused. `Agent.isPaused` / `assertNotPaused` (`agent.paused`) are for the conversation engine to call before answering or calling back. Questions are one ordered list per Organization (max 50, positions 1..n); every change goes through the store's `change`, which locks per Organization, and skip logic may only name an earlier question. No setting touches the Disclosure, the recording notice or the consent gate (ADR 0003).
- `src/modules/agent-tools/` runs the Inbound Agent's tools for a live Call: `contextFor(deps, scope)` says what the model may use (the one pending Qualification question, and the free times offered when the last Agent turn was `find_slots` or `book`); `run(deps, scope, toolCall)` runs `record_answer`, `find_slots` or `book` and returns what the Agent says (`{say, replace}`), or `null` for the other tools (`hand_off`, `end_call`, `revoke_consent` belong to other tickets). `record_answer` accepts only the pending question, parses the answer by kind (a failure re-asks), records skipped questions as `skipped`, and stores a summary (max 2000 characters) when none is left. Beside a tool call the model's own text is never spoken, only what the tool says. `book` re-reads the free times and books only one offered on the previous turn, with the idempotency key `voice-book-<callId>-<turnIndex>`; a failure is told to the Prospect with other times. The `QualificationStore` port (Postgres `voice.inquiries` / `qualification_answers`; no Inquiry for the Call means nothing is recorded, the intake ticket creates it) and the `BookingGateway` port (memory adapter, or `src/adapters/core-http/booking-gateway.ts` over core's public Booking Type link routes: 3 s per attempt, 2 jittered retries on a network error or 5xx, every failure a `BookingFailedError`) are the only ways out. Over HTTP the Prospect's contact is a fixed placeholder in `local` only, so `book` fails closed elsewhere until core has a contact lookup. Tool arguments are validated; model output is untrusted.
- `src/modules/conversation/` is the Inbound Agent engine in text mode: `converse(deps, {organizationId, conversation: {kind: 'call'|'chat'|'try', id}, turnIndex, text})`. `turnIndex` is the Prospect turn's even index and the idempotency key (the Agent turn is `turnIndex + 1`); a retry returns the stored exchange (`replayed: true`, `toolCall: null`) and never asks the model again. Order: `assertNotPaused`, retrieve evidence through the `EvidenceSearch` port (Organization-scoped; Documents are citable, Moments are wording examples only), defer to a Rep without calling the model when fewer than `MIN_EVIDENCE_PASSAGES` (1) passages reach `MIN_EVIDENCE_SCORE` (0.5, a starting value to tune), else `LlmPort.complete` with a Zod schema (reply, cited labels, deferred, at most one tool call from the contract's `AGENT_TOOLS` with strict arguments). A reply that cites nothing, cites a passage that was not retrieved, or breaks the schema (an out-of-set tool included) is stored as a deferral. Retrieved text and the Prospect message go into delimited, escaped data sections, never into instructions. The engine validates a tool call but never runs it. `AgentTurnStore` (`voice.agent_turns` and `agent_turn_sources`) is the only way to reach the turns; the production `EvidenceSearch` is `src/adapters/playbook-http/` (the Playbook's `POST /internal/v1/playbook/search/documents`, bearer secret and `X-Organization-Id`; 2.5 s per attempt, one jittered retry on a timeout or 503, the Playbook's 504 is `server.timeout`, every other failure `server.unavailable`; no Moments until an internal route exists). `MIN_EVIDENCE_SCORE` is still untuned: it needs real Playbook scores.
- `src/modules/handoff/` is the warm Handoff of an Agent Call to a Rep: `start(deps, {organizationId, callId, reason})` (called by `AgentCall.hear` on a `hand_off` tool call or a deferral) rings the Line's Rep or its Team's online Reps one at a time (max 5, `HANDOFF_RING_TIMEOUT_MS` each), plays the Disclosure line (`HANDOFF_DISCLOSURE_WORDING`) before `telephony.bridge`, seeds the Copilot Transcript with the earlier turns, and stores the timing; with no Rep it writes a `no_rep` row and the Agent offers a Booking. `POST /v1/handoffs/{id}/accept|decline` answer an offer. Not a hot path, no benchmark. Core has no presence route yet, so "online" is the Team's online Reps and a decline or timeout means unavailable.
- `src/modules/call/` places and lists Calls (`POST/GET /v1/calls`, `GET /v1/calls/{id}`,
  `PUT /v1/calls/{id}/wrap-up`). `state.ts` holds the one edge table (`canTransition`): `live` is
  unreachable without a stored Disclosure version, and the stores enforce it. Placing needs an
  `Idempotency-Key`, stores the `ringing` Call in the idempotency transaction, then dials after
  commit and leaves it `ringing` (the Copilot flag is kept in `copilot.dialed`, process memory). The
  provider's `in-progress` status callback (`Calls.onProviderStatus`, via the webhook) claims
  `ringing` to `connecting` and runs, in the background, the Disclosure (`DISCLOSURE_WORDING`,
  version 1, in `service.ts`; no setting, ADR 0003), the bridge, the Recording, `live`; the
  Disclosure step has `numberTimeoutMs` plus 20 s because the provider waits for the words. A
  Disclosure failure ends the Call `failed`; no-answer, busy, failed and a hang-up while ringing
  fail it with the matching reason. A lost Copilot flag fails the Call closed. Visibility: Rep own, Manager own plus `teamRepsOf`, Owner and
  Admin all; any other Call is `call.not_found`. `Calls.end` is service-only (no route yet).
  The place-Call path is not a hot path: a Rep places a few Calls a minute and it is bound by the
  provider's latency, so it has no benchmark.
- `src/modules/transcript/` is the Copilot live Transcript. A Rep dials with `copilot: true`; the Call
  plays `COPILOT_DISCLOSURE_WORDING` (version 3, `aiAssisted`, no setting, ADR 0003) and only after it is
  stored and the Call is `live` does `Transcript.start` fork both tracks (`forkTracks`) and open one
  speech-to-text stream per track (`transcribe` port: AssemblyAI when `ASSEMBLYAI_API_KEY` is set, the
  kit memory stand-in when `ENVIRONMENT=local`, else fails closed). A Call is a Copilot Call when its
  stored Disclosure has `aiAssisted` and it has a Rep. Final turns are saved once each through
  `CallTurnStore` (`voice.call_turns`, sequence per track; O(1) per turn, no hot-path benchmark).
  `GET /v1/calls/{callId}/copilot/stream` is SSE (`copilot.status`, `transcript.turn`,
  `transcript.unavailable`); ids are cursors `r<n>.p<m>` and `Last-Event-ID` resumes from the store.
  A speech-to-text failure never touches the Call: it marks the Transcript unavailable and the stream
  says so. Shortcut: open streams and the unavailable flag live in process memory (one instance,
  `container.copilot`); move them to a column before running more than one instance. The Twilio media
  websocket that feeds `Transcript.pushAudio` is not built yet.
- Ports (`src/ports/`): `CallStore` (Postgres and memory; every event row is written in the same
  transaction as the change), `LineStore`, `IdempotencyStore` (stored answers of `Idempotency-Key`
  requests; `POST /v1/lines` reserves the key, buys, inserts the Line and completes the key in one
  transaction, see `src/modules/idempotency/service.ts`), `NumberProvisioner` (buy, port, release a number),
  `OrganizationDirectory` (Teams, Reps and a Manager's Team Reps via `teamRepsOf`, owned by core; `src/adapters/core-http/` asks core's
  `/internal/v1/directory/*` routes with a per-attempt timeout and bounded jittered retry on
  network errors and 5xx, and any failure is `server.unavailable`; an Organization that is not
  `active` has no Membership). Memory adapters are in `src/adapters/memory/`;
  `src/adapters/twilio/number-provisioner.ts` is the Twilio `NumberProvisioner` (API key over basic
  auth; 5 s per attempt, 3 jittered attempts for reads only, the purchase POST is never retried):
  `buy` searches then buys, names it `Closeline (bought)` and points `VoiceUrl` at
  `/webhooks/twilio/inbound`; `port` attaches a number the account already owns, any other is
  `line.number_unavailable`; `release` deletes only a `Closeline (bought)` number, else clears its
  `VoiceUrl`. `src/adapters/unconfigured/` fails closed with `server.unavailable` elsewhere.
- `src/modules/recording/` copies a Call's Recording and announces the Call. A final Call state (wrapped by `publishOnFinal`) and a completed recording callback queue a `voice.recording_finish` job on `JOBS_QUEUE_URL`; `runJobs` (scheduled from `server.ts`) runs `finish`, which streams the Recording from the provider into the object store at `recordings/<callId>.wav` (size capped by `RECORDING_MAX_BYTES`), publishes `voice.call.ended` on `QUEUE_URL` with an id derived from the Call id (so a redelivery repeats the same id), then marks the row `stored` and deletes the provider's copy. `GET/DELETE /v1/calls/{id}/recording`: a 300 s signed URL for the caller's visible Calls; delete is Owner/Admin and schedules the file `RECORDING_PURGE_DELAY_MS` out, `purgeRecordings` removes it (via `voice.orgs_with_due_recordings`) and keeps a tombstone row. `GET /internal/v1/calls/{id}/recording` streams the file (shared secret plus `X-Organization-Id`). `PHONE_HASH_KEY` makes the event's `prospectPhoneHash`. Limits: no outbox for the enqueue, no consumer dedupe, no event if the recording callback never arrives.
- `src/modules/webhook/` receives Twilio status and recording callbacks (unauthenticated, verified by
  `X-Twilio-Signature` over `WEBHOOK_BASE_URL` + path; bad signature is 403 and changes nothing;
  `CallEventStore` appends one `provider_callback` row per event id, duplicates change nothing).
  `POST /webhooks/twilio/inbound` starts an inbound Call: `lines.byNumber(To)`, then `Calls.ringInbound`
  inserts it `ringing` once per provider call id (a retry is `duplicate`), rings the assigned Rep or the
  Team's online Reps (`directory.onlineRepsOfTeam`, core has no route yet so it fails closed), and
  nothing else is kept in memory. `POST /v1/calls/{id}/answer` is decided by one conditional
  update in `CallStore.claimInbound` (`ringing` to `connecting`); the loser gets `call.not_ringing`, and
  the winner's repeat returns the Call. `modules/call/missed-sweep.ts` (a jittered schedule started from
  `server.ts`) pages `voice.orgs_with_stale_ringing` and, per Organization, moves inbound Calls
  `ringing` longer than `RING_TIMEOUT_MS` to `missed` in one conditional update, then hangs them up.
  Missed Calls on a Team Line have no Rep, so only Owner and Admin list them.
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
`QUEUE_URL`, `JOBS_QUEUE_URL`, `PHONE_HASH_KEY`, `STORAGE_BUCKET`, `TELEPHONY_PROVIDER` (`memory|twilio`), and with `twilio` the keys
`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_API_KEY_SID`, `TWILIO_API_KEY_SECRET`,
`TWILIO_TWIML_APP_SID`, `WEBHOOK_BASE_URL` (the public https origin Twilio signs; http only local), `ASSEMBLYAI_API_KEY` (optional; live speech-to-text),
`BOOKING_LINK_TOKENS` (a JSON map of Organization id to the token of its Booking Type link, a credential never logged; unset means no booking over HTTP, a shortcut until Agent settings carry the link), `PLAYBOOK_INTERNAL_URL` and `PLAYBOOK_INTERNAL_TOKEN` (the Playbook's origin and internal secret; same rules as the core pair), `CORE_INTERNAL_URL` and `CORE_INTERNAL_TOKEN` (core's origin and the `Authorization: Bearer` secret
in its `INTERNAL_API_TOKENS`; set together; required outside local, where unset means an empty
in-memory directory),
and the purge schedule keys `TWILIO_PURGE_INTERVAL_MS` (default 900000) and
`TWILIO_PURGE_MAX_ORGANIZATIONS` (default 200), `TWILIO_PURGE_QUERY_TIMEOUT_MS` (default 10000), `RING_TIMEOUT_MS` (default 30000), `HANDOFF_RING_TIMEOUT_MS` (default 20000), `MISSED_SWEEP_INTERVAL_MS` (default 5000) and `MISSED_SWEEP_MAX_ORGANIZATIONS` (default 200), and the Agent's vendor prices in micro-cents per unit, `STT_PRICE_MICRO_CENTS_PER_SECOND`, `TTS_PRICE_MICRO_CENTS_PER_CHARACTER`, `LLM_INPUT_PRICE_MICRO_CENTS_PER_TOKEN` and `LLM_OUTPUT_PRICE_MICRO_CENTS_PER_TOKEN` (local defaults, required elsewhere). The deployment keys have
local defaults only when `ENVIRONMENT=local` and are required elsewhere; `QUEUE_ENDPOINT` and
`STORAGE_ENDPOINT` are local-only. Add a key in both files.

## Hot paths

The per-request middleware stack (`createBaseApp`) and `/healthz`, and the Twilio webhook handler
(`Webhooks.receive`, `POST /webhooks/twilio/*`: signature check, then one idempotent insert; O(body
size), and one Agent turn on a live Call (`AgentCall.hear`: Call read, cap check, `converse`
with its idempotent turn inserts and one atomic cost add, streaming TTS; O(1) in the Organization,
and reads a bounded window of recent turns). Budgets are in `bench/` (`bench/webhook.bench.test.ts`,
`bench/agent-turn.bench.test.ts`).

A benchmark times `measure(operation)`: a warm-up, then several batches, gated on the fastest, so a
noisy runner cannot fail it but a real regression (every batch slower) does. Budget is about 5x the
typical best batch, written in the file. `bun run bench` is part of `verify`. Add a benchmark and
name the function here when a new hot path appears.

## Issues

All tickets live in the hub: `gh issue list -R Tula-Solutions/tula-closeline --label repo:voice`.
