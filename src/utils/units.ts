/**
 * Metric or imperial display of ground motion (Project › Appearance). Only lengths convert:
 * displacement in metres or mm shows as inches, rates as in/yr (a velocity layer in m/yr too);
 * other layers keep their units.
 * Data, requests and CSV exports stay in the cube's own (SI) units.
 */
export type UnitSystem = 'metric' | 'imperial';

export interface DisplayUnit {
  /** Multiply a data value by this to display it. */
  factor: number;
  label: string;
  /** For rates: multiply a displayed value per year by this, labelled ``label``/yr; null when not a length. */
  rate: { factor: number; label: string } | null;
}

const METRES = ['m', 'meter', 'meters', 'metre', 'metres'];
const MM = ['mm', 'millimeter', 'millimeters', 'millimetre', 'millimetres'];
const MM_PER_IN = 25.4;

const lengthToMm = (u: string): number | null => (METRES.includes(u) ? 1000 : MM.includes(u) ? 1 : null);

export function displayUnit(unit: string | undefined, system: UnitSystem): DisplayUnit {
  const u = (unit ?? '').trim().toLowerCase();
  // A length per time (a velocity layer, "m/yr"): the length converts, the time stays.
  const [length, per] = u.split('/').map(part => part.trim());
  if (per && lengthToMm(length) !== null && !u.slice(u.indexOf('/') + 1).includes('/')) {
    if (system !== 'imperial') return { factor: 1, label: unit ?? '', rate: null };
    return { factor: lengthToMm(length)! / MM_PER_IN, label: `in/${per}`, rate: null };
  }
  const toMm = lengthToMm(u);
  if (toMm === null) return { factor: 1, label: unit ?? '', rate: null };
  if (system === 'imperial') return { factor: toMm / MM_PER_IN, label: 'in', rate: { factor: 1, label: 'in' } };
  // Metric keeps the data's own unit on the axis (metres stay metres) and gives rates in mm/yr.
  return { factor: 1, label: toMm === 1000 ? 'm' : 'mm', rate: { factor: toMm, label: 'mm' } };
}

const STORAGE_KEY = 'bowser-units';

export function readUnitSystem(): UnitSystem {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'imperial' ? 'imperial' : 'metric';
  } catch {
    return 'metric';
  }
}

export function saveUnitSystem(system: UnitSystem): void {
  try { localStorage.setItem(STORAGE_KEY, system); } catch { /* this session only */ }
}
