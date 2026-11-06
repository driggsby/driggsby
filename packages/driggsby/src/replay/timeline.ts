// Call seconds and replay seconds, mapped piecewise-linearly through a
// timeline's keys (each key is [call second, replay second]).

export function toReal(keys: readonly (readonly [number, number])[], playSecond: number): number {
  if (playSecond <= 0) return 0;
  for (let i = 1; i < keys.length; i++) {
    const [r0, p0] = keys[i - 1] ?? [0, 0];
    const [r1, p1] = keys[i] ?? [0, 0];
    if (playSecond <= p1) return p1 === p0 ? r1 : r0 + ((playSecond - p0) / (p1 - p0)) * (r1 - r0);
  }
  return keys[keys.length - 1]?.[0] ?? 0;
}

export function toPlay(keys: readonly (readonly [number, number])[], callSecond: number): number {
  for (let i = 1; i < keys.length; i++) {
    const [r0, p0] = keys[i - 1] ?? [0, 0];
    const [r1, p1] = keys[i] ?? [0, 0];
    if (callSecond <= r1) return r1 === r0 ? p1 : p0 + ((callSecond - r0) / (r1 - r0)) * (p1 - p0);
  }
  return keys[keys.length - 1]?.[1] ?? 0;
}
