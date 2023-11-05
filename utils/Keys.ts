import { lexicographicallyBigInt, lexicographicallyNumber } from "./Number.ts";

export function joinParts(...parts: (string | bigint | number)[]) {
  return parts
    .map((x) =>
      typeof x === "bigint"
        ? lexicographicallyBigInt(x)
        : typeof x === "number"
        ? lexicographicallyNumber(x)
        : x
    )
    .join(":");
}
