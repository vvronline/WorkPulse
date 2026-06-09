/**
 * Barrel for client-side shared types.
 *
 * Import from `@/types` (or relative `../types`) rather than reaching into
 * individual files, so the public type surface stays stable as the internal
 * organisation evolves.
 */
export * from "./domain";
export * from "./api";