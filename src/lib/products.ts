/**
 * Validate a `specifications` payload as a flat string -> string object
 * (matches the `products_specifications_is_object` CHECK + the app's
 * `Record<string, string>` type). Returns `null` if `value` isn't a
 * plain object or any value isn't a string.
 */
export function parseSpecifications(value: unknown): Record<string, string> | null {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value)
  ) {
    return null
  }
  const entries = Object.entries(value as Record<string, unknown>)
  const result: Record<string, string> = {}
  for (const [key, v] of entries) {
    if (typeof v !== 'string') return null
    result[key] = v
  }
  return result
}
