/**
 * PostgreSQL stores whatsapp_events.event_timestamp as BIGINT. Providers may
 * send either whole milliseconds or fractional seconds, so every write path
 * must normalize the value before it reaches SQL.
 */
export function normalizeWhatsappEventTimestamp(value) {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  const rounded = Math.round(numeric);
  return Number.isSafeInteger(rounded) ? rounded : null;
}

export function firstWhatsappEventTimestamp(...candidates) {
  for (const candidate of candidates) {
    const normalized = normalizeWhatsappEventTimestamp(candidate);
    if (normalized !== null) return normalized;
  }
  return null;
}
