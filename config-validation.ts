/** Checks shared by the configuration parsers. A failed check throws `ConfigProblem`, which names keys and never echoes values. */
export class ConfigProblem extends Error {}

export function fail(problem: string): never {
  throw new ConfigProblem(problem);
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function integerInRange(
  value: unknown,
  name: string,
  min: number,
  max: number,
): number {
  if (typeof value !== "number" || !Number.isInteger(value))
    fail(`${name} must be an integer`);
  if (value < min || value > max)
    fail(`${name} must be between ${min} and ${max}`);
  return value;
}

export function checkedString(
  value: unknown,
  name: string,
  pattern: RegExp,
  message: string,
): string {
  if (typeof value !== "string" || value.trim() === "")
    fail(`${name} is not set`);
  if (!pattern.test(value)) fail(message);
  return value;
}

export function parseLocale(value: unknown, name = "locale"): string {
  if (typeof value !== "string" || value === "")
    fail(`${name} must be a non-empty BCP-47 language tag`);
  try {
    return Intl.getCanonicalLocales(value)[0]!;
  } catch {
    return fail(`${name} must be a valid BCP-47 language tag`);
  }
}
