/** Runtime guards for the JSON-shaped domain boundary. */

export function assertExactKeys(value: unknown, expectedKeys: readonly string[], label: string): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a record`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain record`);
  }

  const expected = new Set(expectedKeys);
  const actual = Reflect.ownKeys(value);
  for (const key of actual) {
    if (typeof key !== "string" || !expected.has(key)) {
      throw new Error(`${label} contains unknown field ${typeof key === "string" ? key : String(key)}`);
    }
  }
  for (const key of expectedKeys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      throw new Error(`${label} is missing field ${key}`);
    }
  }
}
