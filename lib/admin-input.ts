export function parsePositiveSafeInteger(raw: string | null): number | null {
  if (raw === null || !/^[1-9]\d*$/.test(raw)) return null
  const value = Number(raw)
  return Number.isSafeInteger(value) ? value : null
}
