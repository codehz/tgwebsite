export function requireBigInt(
  str: string | undefined | null
): bigint | undefined {
  return str && /^[0-9]+$/.test(str) ? BigInt(str) : undefined;
}

export function requireInt(
  str: string | undefined | null,
  defaults?: undefined
): number | undefined;
export function requireInt(
  str: string | undefined | null,
  defaults: number
): number;
export function requireInt(
  str: string | undefined | null,
  defaults?: number | undefined
): number | undefined {
  return str && /^[0-9]+$/.test(str) ? Number.parseInt(str, 10) : defaults;
}

export function assertIntRange(target: number, min: number, max: number): void {
  if (target < min || target > max) throw new RangeError();
}

export function lexicographicallyBigInt(input: bigint): string {
  return input.toString(16).padStart(16, "0");
}

export function lexicographicallyNumber(input: number): string {
  return input.toString(16).padStart(14, "0");
}

export function parselexicographicallyNumber(input: string): number {
  return Number.parseInt(input, 16);
}
