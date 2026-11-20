/**
 * The readable reason in a FastAPI error body: `detail` as a string, or the first
 * `msg` of a validation (422) list, without pydantic's "Value error, " prefix.
 * Null when the body carries neither.
 */
export function errorDetail(body: unknown): string | null {
  const detail = (body as { detail?: unknown } | null)?.detail;
  if (typeof detail === 'string' && detail) return detail;
  if (Array.isArray(detail) && typeof detail[0]?.msg === 'string') {
    return detail[0].msg.replace(/^Value error, /, '');
  }
  return null;
}
