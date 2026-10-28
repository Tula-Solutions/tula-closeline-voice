import {
  type AddLineRequest,
  decodeCursor,
  ERRORS,
  encodeCursor,
  formatId,
  type Line,
  type LineAssignment,
  type ListLinesQuery,
  lineCursorSchema,
  type linePageSchema,
  lineSchema,
  type Role,
  VOICE_ADMIN_ROLES,
  VOICE_ERRORS,
} from 'tula-closeline-contract'
import type { z } from 'zod'
import type { Container } from '~/container'
import { describeError } from '~/describe-error'
import { domainError } from '~/http/domain-error'
import type { Caller } from '~/modules/caller'
import { type IdempotentAnswer, idempotent } from '~/modules/idempotency/service'
import type { IdempotencyScope } from '~/ports/idempotency-store'
import { NumberTakenError, type StoredLine } from '~/ports/line-store'
import type { ProvisionedNumber } from '~/ports/number-provisioner'

/** One page of Lines. */
type LinePage = z.infer<typeof linePageSchema>

/** What the Lines service needs from the container. */
export type LineDeps = Pick<
  Container,
  'lines' | 'numbers' | 'numberTimeoutMs' | 'directory' | 'clock' | 'logger' | 'idempotency'
>

/** Drops what is internal to the service (the provider's id) before a Line leaves it. */
function toLine(stored: StoredLine): Line {
  const { providerSid: _providerSid, ...line } = stored
  return line
}

/** Owner and Admin only; the role comes from the verified token. */
function requireAdmin(caller: Caller): void {
  if (!(VOICE_ADMIN_ROLES as readonly Role[]).includes(caller.role)) {
    throw domainError(ERRORS['auth.forbidden'])
  }
}

/** Lists the Organization's Lines newest first, one cursor-paginated page at a time. */
export async function list(
  deps: LineDeps,
  caller: Caller,
  query: ListLinesQuery
): Promise<LinePage> {
  const cursor =
    query.cursor === undefined ? undefined : decodeCursor(query.cursor, lineCursorSchema)
  if (query.cursor !== undefined && cursor === undefined) {
    throw domainError(ERRORS['request.invalid'])
  }
  // One row more than asked tells whether another page follows without a count.
  const rows = await deps.lines.list(caller.organizationId, {
    limit: query.limit + 1,
    ...(cursor === undefined ? {} : { cursor }),
    ...(query.state === undefined ? {} : { state: query.state }),
  })
  const page = rows.slice(0, query.limit)
  const last = page.at(-1)
  return {
    items: page.map(toLine),
    nextCursor:
      rows.length > query.limit && last
        ? encodeCursor({ createdAt: last.createdAt, id: last.id })
        : null,
  }
}

/** Reads one Line of the caller's Organization. */
export async function get(deps: LineDeps, caller: Caller, id: Line['id']): Promise<Line> {
  const stored = await deps.lines.get(caller.organizationId, id)
  if (stored === undefined) {
    throw domainError(VOICE_ERRORS['line.not_found'])
  }
  return toLine(stored)
}

/**
 * Runs one call to the telephony provider under the deadline `deps.numberTimeoutMs`. A call that
 * outlives it (whether or not the adapter honours the signal) answers `server.unavailable`. A
 * result that still arrives after the deadline is handed to `late`, so a number the provider
 * went on to buy can be given back.
 */
async function withinDeadline<T>(
  deps: LineDeps,
  call: (signal: AbortSignal) => Promise<T>,
  late?: (result: T) => void
): Promise<T> {
  const signal = AbortSignal.timeout(deps.numberTimeoutMs)
  const expired = new Promise<never>((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  })
  const running = call(signal)
  // If the deadline wins, the call may still finish later: hand a late result on, and drop a late
  // rejection so it does not go unhandled.
  running.then(
    (value) => {
      if (signal.aborted) {
        late?.(value)
      }
    },
    () => undefined
  )
  let result: T
  try {
    result = await Promise.race([running, expired])
  } catch (error) {
    if (signal.aborted) {
      deps.logger.warn('line.provisioner.timeout', { timeoutMs: deps.numberTimeoutMs })
      throw domainError(ERRORS['server.unavailable'])
    }
    throw error
  }
  return result
}

/** Gives a number back to the provider under the deadline; a failure is logged, never thrown. */
async function giveBack(deps: LineDeps, providerSid: string): Promise<void> {
  await withinDeadline(deps, (signal) => deps.numbers.release(providerSid, signal)).catch(
    (releaseError: unknown) => {
      deps.logger.error('line.add.release_failed', describeError(releaseError))
    }
  )
}

/** The route name an add-Line `Idempotency-Key` is stored under. */
export const ADD_LINE_ROUTE = 'lines.add'

/**
 * Buys or ports a number and records it as a new, unassigned Line, inside `within` when given.
 * `held` is told the provider's id as soon as a number is paid for, so the caller can give it back
 * if anything after that fails.
 */
async function buyAndRecord(
  deps: LineDeps,
  caller: Caller,
  request: AddLineRequest,
  held: { providerSid: string | null },
  within?: IdempotencyScope
): Promise<Line> {
  const giveBackLate = (late: ProvisionedNumber): void => {
    void giveBack(deps, late.providerSid)
  }
  const provisioned: ProvisionedNumber =
    request.method === 'buy'
      ? await withinDeadline(
          deps,
          (signal) =>
            deps.numbers.buy({ country: request.country, areaCode: request.areaCode }, signal),
          giveBackLate
        )
      : await withinDeadline(
          deps,
          (signal) => deps.numbers.port(request.number, signal),
          giveBackLate
        )
  held.providerSid = provisioned.providerSid
  try {
    const stored = await deps.lines.insert(
      caller.organizationId,
      {
        id: formatId('line', crypto.randomUUID()),
        number: provisioned.number,
        country: provisioned.country,
        label: request.label ?? null,
        state: provisioned.state,
        providerSid: provisioned.providerSid,
        createdAt: deps.clock.now(),
      },
      within
    )
    return toLine(stored)
  } catch (error) {
    if (error instanceof NumberTakenError) {
      // Another live Line holds this number: giving it back would cut that Line off at the provider.
      held.providerSid = null
      throw domainError(VOICE_ERRORS['line.number_unavailable'])
    }
    throw error
  }
}

/**
 * Buys or ports a number and records it as a new, unassigned Line. The `Idempotency-Key` and the
 * Line are written in one transaction, so a repeat of the same request answers with the
 * stored Line (`replayed`) and does not buy or port again.
 */
export async function add(
  deps: LineDeps,
  caller: Caller,
  request: AddLineRequest,
  idempotencyKey: string
): Promise<IdempotentAnswer<201, Line>> {
  requireAdmin(caller)
  const held: { providerSid: string | null } = { providerSid: null }
  try {
    return await deps.idempotency.withOrganization(caller.organizationId, (scope) =>
      idempotent(
        deps,
        scope,
        caller,
        {
          key: idempotencyKey,
          route: ADD_LINE_ROUTE,
          request,
          status: 201,
          response: lineSchema,
        },
        () => buyAndRecord(deps, caller, request, held, scope)
      )
    )
  } catch (error) {
    // Anything failing after the purchase (the Line, the key, the commit) rolls the Line back:
    // the number is paid for but no Line holds it, so give it back and nothing is left behind.
    if (held.providerSid !== null) {
      await giveBack(deps, held.providerSid)
    }
    throw error
  }
}

const sameAssignment = (a: LineAssignment, b: LineAssignment): boolean =>
  a.kind === b.kind &&
  (a.kind !== 'team' || (b.kind === 'team' && a.teamId === b.teamId)) &&
  (a.kind !== 'rep' || (b.kind === 'rep' && a.membershipId === b.membershipId))

/** Sets who inbound Calls on a Line ring: a Team, one Rep, or nobody. */
export async function assign(
  deps: LineDeps,
  caller: Caller,
  id: Line['id'],
  assignment: LineAssignment
): Promise<Line> {
  requireAdmin(caller)
  const current = await get(deps, caller, id)
  if (current.state === 'released') {
    throw domainError(VOICE_ERRORS['line.released'])
  }
  if (sameAssignment(current.assignment, assignment)) {
    return current
  }
  const valid =
    assignment.kind === 'unassigned' ||
    (assignment.kind === 'team'
      ? await deps.directory.teamExists(caller.organizationId, assignment.teamId)
      : await deps.directory.isRep(caller.organizationId, assignment.membershipId))
  if (!valid) {
    throw domainError(VOICE_ERRORS['line.assignment_invalid'])
  }
  const stored = await deps.lines.assign(caller.organizationId, id, assignment)
  if (stored === undefined) {
    // Released between the read and the write.
    throw domainError(VOICE_ERRORS['line.released'])
  }
  return toLine(stored)
}

/** Gives a Line up: the number goes back to the provider once, the assignment is cleared. */
export async function release(deps: LineDeps, caller: Caller, id: Line['id']): Promise<Line> {
  requireAdmin(caller)
  const before = await deps.lines.get(caller.organizationId, id)
  if (before === undefined) {
    throw domainError(VOICE_ERRORS['line.not_found'])
  }
  const released =
    before.state === 'released'
      ? before
      : await deps.lines.release(caller.organizationId, id, deps.clock.now())
  if (released === undefined) {
    throw domainError(VOICE_ERRORS['line.not_found'])
  }
  // The provider id stays until the number is back, so a retry after a provider failure finishes
  // the job. Giving a number back is idempotent at the provider, so a concurrent repeat is safe.
  if (released.providerSid !== null) {
    const providerSid = released.providerSid
    await withinDeadline(deps, (signal) => deps.numbers.release(providerSid, signal))
    await deps.lines.clearProviderSid(caller.organizationId, id)
  }
  return toLine({ ...released, providerSid: null })
}
