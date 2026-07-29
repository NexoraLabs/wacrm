/**
 * The whole product is built for Colombian merchants (WhatsApp
 * numbers, Wompi billing, message copy) but hosts run wherever the
 * platform (EasyPanel) puts them — typically UTC. Anything that needs
 * "is it currently daytime for the business" must read the clock in
 * this zone explicitly rather than relying on the server's local TZ.
 */
export const BUSINESS_TIMEZONE = 'America/Bogota'

/** Minutes since local midnight in `BUSINESS_TIMEZONE`. */
export function businessMinutesOfDay(now: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: BUSINESS_TIMEZONE,
    hour: 'numeric',
    minute: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(now)
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? 0)
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? 0)
  return hour * 60 + minute
}

/** Human-readable local date/time, e.g. "Wednesday, July 29, 2026, 08:59"
 *  — for grounding an LLM prompt, not for parsing. */
export function businessDateTimeString(now: Date): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: BUSINESS_TIMEZONE,
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    hourCycle: 'h23',
  }).format(now)
}

/** Spanish time-of-day greeting for the current moment in
 *  `BUSINESS_TIMEZONE` — "Buenos días" 05:00–12:00, "Buenas tardes"
 *  12:00–19:00, otherwise "Buenas noches". */
export function businessGreeting(now: Date): string {
  const mins = businessMinutesOfDay(now)
  if (mins >= 5 * 60 && mins < 12 * 60) return 'Buenos días'
  if (mins >= 12 * 60 && mins < 19 * 60) return 'Buenas tardes'
  return 'Buenas noches'
}
