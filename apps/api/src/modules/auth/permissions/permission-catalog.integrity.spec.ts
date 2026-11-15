import { PERMISSION_CATALOG, PermissionSpec } from './permission.catalog';
import {
  StoredPermissionRow,
  diffCatalogue,
  formatCatalogueProblems,
} from './permission-catalog.integrity';

/**
 * The comparison that decides whether the process is allowed to start.
 *
 * Exhaustive and database-free on purpose: this is the one function whose
 * being wrong in the PERMISSIVE direction means a process boots with an
 * authorisation table that does not match its authorisation code, and whose
 * being wrong in the STRICT direction means a correct deployment refuses to
 * start. Both failures are expensive, so every branch is covered here rather
 * than inferred from the integration suite.
 */

/** A stored row that matches a spec exactly — the baseline for mutation. */
const rowFor = (
  spec: PermissionSpec,
  overrides: Partial<StoredPermissionRow> = {},
): StoredPermissionRow => ({
  code: spec.code,
  groupKey: spec.groupKey,
  labelFa: spec.labelFa,
  descriptionFa: spec.descriptionFa,
  risk: spec.risk,
  retiredAt: null,
  ...overrides,
});

const healthy = (): StoredPermissionRow[] =>
  PERMISSION_CATALOG.map((s) => rowFor(s));

describe('diffCatalogue', () => {
  it('reports nothing when the table matches the catalogue exactly', () => {
    expect(diffCatalogue(healthy())).toEqual([]);
  });

  it('accepts a retired row the code no longer declares', () => {
    const stored = healthy();
    stored.push({
      code: 'legacy.capability',
      groupKey: 'orders',
      labelFa: 'قدیمی',
      descriptionFa: 'یک دسترسی بازنشسته',
      risk: 'normal',
      retiredAt: new Date('2026-01-01T00:00:00Z'),
    });

    // Retirement is the SUPPORTED way to remove a capability, so its presence
    // must not be an error — otherwise the only way to retire one is to delete
    // the row, which is exactly the cascade the lifecycle exists to prevent.
    expect(diffCatalogue(stored)).toEqual([]);
  });

  it('fails when a required code is absent', () => {
    const stored = healthy().filter((r) => r.code !== 'orders.void');
    const problems = diffCatalogue(stored);

    expect(problems).toHaveLength(1);
    expect(problems[0].kind).toBe('missing');
    expect(problems[0].code).toBe('orders.void');
  });

  it('fails when an undeclared code is still ACTIVE', () => {
    const stored = healthy();
    stored.push(rowFor({ ...PERMISSION_CATALOG[0], code: 'ghost.capability' }));
    const problems = diffCatalogue(stored);

    expect(problems).toHaveLength(1);
    expect(problems[0].kind).toBe('unexpected_active');
    expect(problems[0].code).toBe('ghost.capability');
  });

  it('fails when a code the CODE still requires has been retired', () => {
    const stored = healthy().map((r) =>
      r.code === 'audit.read' ? { ...r, retiredAt: new Date() } : r,
    );
    const problems = diffCatalogue(stored);

    expect(problems).toHaveLength(1);
    expect(problems[0].kind).toBe('retired_but_required');
    expect(problems[0].code).toBe('audit.read');
  });

  it.each(['groupKey', 'labelFa', 'descriptionFa', 'risk'] as const)(
    'fails on a %s mismatch, naming both values',
    (field) => {
      const stored = healthy().map((r) =>
        r.code === 'orders.read' ? { ...r, [field]: 'DRIFTED' } : r,
      );
      const problems = diffCatalogue(stored);

      expect(problems).toHaveLength(1);
      expect(problems[0].kind).toBe('metadata_mismatch');
      expect(problems[0].code).toBe('orders.read');
      expect(problems[0].detail).toContain(field);
      expect(problems[0].detail).toContain('DRIFTED');
      // The value the code expects has to be in the message too, or the
      // operator still has to go and look it up.
      expect(problems[0].detail).toContain(
        PERMISSION_CATALOG.find((s) => s.code === 'orders.read')![field],
      );
    },
  );

  it('reports EVERY problem, not just the first', () => {
    const stored = healthy()
      .filter((r) => r.code !== 'orders.void')
      .filter((r) => r.code !== 'orders.return')
      .map((r) => (r.code === 'orders.read' ? { ...r, risk: 'normal' } : r));
    stored.push(rowFor({ ...PERMISSION_CATALOG[0], code: 'ghost.one' }));

    const problems = diffCatalogue(stored);
    const kinds = problems.map((p) => p.kind);

    // Two missing, one unexpected, and (because orders.read is 'sensitive' in
    // the catalogue) one mismatch. Finding one per restart would turn a single
    // fix into four deploys.
    expect(kinds.filter((k) => k === 'missing')).toHaveLength(2);
    expect(kinds.filter((k) => k === 'unexpected_active')).toHaveLength(1);
    expect(kinds.filter((k) => k === 'metadata_mismatch')).toHaveLength(1);
  });

  it('reports a duplicated code rather than picking a winner', () => {
    const stored = healthy();
    stored.push(rowFor(PERMISSION_CATALOG[0]));

    const problems = diffCatalogue(stored);
    expect(problems.map((p) => p.kind)).toContain('duplicate');
  });

  it('treats a null and an undefined retiredAt identically', () => {
    const stored = healthy().map((r) =>
      r.code === 'orders.read'
        ? ({ ...r, retiredAt: undefined } as unknown as StoredPermissionRow)
        : r,
    );
    // `undefined` arrives when a projection omits the column; it must not be
    // mistaken for "retired".
    expect(diffCatalogue(stored)).toEqual([]);
  });
});

describe('formatCatalogueProblems', () => {
  const message = formatCatalogueProblems(
    diffCatalogue(
      healthy()
        .filter((r) => r.code !== 'orders.void')
        .concat(rowFor({ ...PERMISSION_CATALOG[0], code: 'ghost.one' })),
    ),
  );

  it('names every offending code', () => {
    expect(message).toContain('orders.void');
    expect(message).toContain('ghost.one');
  });

  it('tells the operator what to do, per kind', () => {
    expect(message).toContain('FIX:');
    expect(message).toContain('migration');
  });

  it('warns against deleting rows, which would cascade', () => {
    expect(message).toContain('role_permissions');
  });

  it('says plainly that startup is refused', () => {
    expect(message).toContain('refusing to start');
  });
});
