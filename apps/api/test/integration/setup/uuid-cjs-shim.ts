import { randomUUID } from 'node:crypto';

/**
 * CommonJS stand-in for the `uuid` package.
 *
 * uuid@14 ships ESM only (`dist/index.js` and `dist-node/index.js` both use
 * `export`). Node 24 can `require()` an ES module, but jest 29's own CJS
 * runtime cannot, so any suite that transitively imports `uuid` — which is
 * everything reaching auth.service.ts or minio-service.ts — dies with
 * `SyntaxError: Unexpected token 'export'` before a single test runs.
 *
 * Rather than adding a dependency or a transform for node_modules, `^uuid$` is
 * mapped here in test/jest-integration.json. `crypto.randomUUID()` is a
 * CSPRNG-backed RFC 4122 v4 UUID — the same guarantee `uuid.v4()` gives.
 */
export const v4 = (): string => randomUUID();
export const v7 = (): string => randomUUID();
export const NIL = '00000000-0000-0000-0000-000000000000';

export function validate(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

export default { v4, v7, NIL, validate };
