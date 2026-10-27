/** True for a plain JSON object: not null, not an array. Used by shape checks. */
export function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
