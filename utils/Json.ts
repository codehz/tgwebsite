export function parseJsonIfNotEmpty<T>(str: string): T | undefined {
  if (str) {
    return JSON.parse(str) as T;
  }
}