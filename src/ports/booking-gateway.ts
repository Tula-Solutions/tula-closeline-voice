/** A free time as a Prospect sees it: a start and an end. */
export type BookingSlot = { startsAt: string; endsAt: string }

/** The time a Prospect was booked for. */
export type BookedTime = { startsAt: string; endsAt: string }

/** Any reason a booking did not happen: the time was taken, core was unreachable, no link exists. */
export class BookingFailedError extends Error {
  constructor(message = 'booking failed') {
    super(message)
    this.name = 'BookingFailedError'
  }
}

/**
 * Free times and Bookings of an Organization, held by core. The Agent reaches Reps only through
 * this port: it never names a Rep, core's routing picks one from the Organization's Booking Type.
 */
export type BookingGateway = {
  /** Free times in the window, soonest first, at most 100; throws {@link BookingFailedError}. */
  slots: (organizationId: string, window: { from: string; to: string }) => Promise<BookingSlot[]>
  /**
   * Books the time for the Call's Prospect. Idempotent on `idempotencyKey`. Throws
   * {@link BookingFailedError} when the time is not free or core cannot be reached.
   */
  book: (
    organizationId: string,
    input: { callId: string; startsAt: string; idempotencyKey: string }
  ) => Promise<BookedTime>
}
