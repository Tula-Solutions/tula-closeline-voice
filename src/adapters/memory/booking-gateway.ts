import {
  type BookedTime,
  BookingFailedError,
  type BookingGateway,
  type BookingSlot,
} from '~/ports/booking-gateway'

/** The in-memory gateway plus the "calendar" a test seeds and reads. */
export type MemoryBookingGateway = BookingGateway & {
  /** Sets the free times of an Organization's Booking Type. */
  setSlots: (organizationId: string, slots: BookingSlot[]) => void
  /** Every Booking made for the Organization, in order. */
  calendar: (organizationId: string) => (BookedTime & { callId: string })[]
  /** Makes the next `book` call fail as core being unreachable. */
  failNextBook: () => void
}

/** An in-memory {@link BookingGateway}: an Organization can only book into its own slots. */
export function createMemoryBookingGateway(): MemoryBookingGateway {
  const free = new Map<string, BookingSlot[]>()
  const booked = new Map<string, (BookedTime & { callId: string; key: string })[]>()
  let failNext = false
  const taken = (org: string) => booked.get(org) ?? []
  return {
    setSlots: (org, slots) => void free.set(org, structuredClone(slots)),
    calendar: (org) => taken(org).map(({ key: _key, ...rest }) => rest),
    failNextBook: () => {
      failNext = true
    },
    async slots(org) {
      const mine = taken(org).map((b) => b.startsAt)
      return (free.get(org) ?? []).filter((slot) => !mine.includes(slot.startsAt))
    },
    async book(org, input) {
      const again = taken(org).find((b) => b.key === input.idempotencyKey)
      if (again !== undefined) {
        return { startsAt: again.startsAt, endsAt: again.endsAt }
      }
      if (failNext) {
        failNext = false
        throw new BookingFailedError('unreachable')
      }
      const slot = (await this.slots(org, { from: '', to: '' })).find(
        (s) => Date.parse(s.startsAt) === Date.parse(input.startsAt)
      )
      if (slot === undefined) {
        throw new BookingFailedError('slot taken')
      }
      booked.set(org, [...taken(org), { ...slot, callId: input.callId, key: input.idempotencyKey }])
      return { startsAt: slot.startsAt, endsAt: slot.endsAt }
    },
  }
}
