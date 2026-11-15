/**
 * Tiny class-name joiner.
 *
 * `clsx`/`tailwind-merge` are not installed and adding them would change the
 * lockfile, so this is the whole utility: falsy values are dropped, everything
 * else is joined with a space. It does NOT de-duplicate conflicting Tailwind
 * classes — put the caller's `className` LAST (every primitive here does) so it
 * wins by CSS source order.
 */
export type ClassValue = string | false | null | undefined;

export function cx(...values: ClassValue[]): string {
  let out = "";
  for (const value of values) {
    if (!value) continue;
    out = out.length === 0 ? value : `${out} ${value}`;
  }
  return out;
}
