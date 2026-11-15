import { PERMISSION_CATALOG, PermissionSpec } from './permission.catalog';

/**
 * ===========================================================================
 * PERMISSION-CATALOGUE INTEGRITY — a READ-ONLY comparison, run at boot
 * ===========================================================================
 *
 * WHAT THIS REPLACES, AND WHY.
 *
 * The catalogue used to be applied to the database on every boot: 45
 * `INSERT … ON CONFLICT DO UPDATE` statements from `onModuleInit`, plus a
 * self-healing re-sync whenever a lookup missed. It was convenient — adding a
 * capability was a one-file change with no migration — and it was wrong, for
 * four separate reasons:
 *
 *  1. IT MADE THE APPLICATION A SCHEMA-CHANGE TOOL. A process that rewrites
 *     reference data at startup has no review point. The rows that decide who
 *     may void a sale changed because somebody edited a TypeScript file and
 *     restarted, with no migration, no diff against production, and no record
 *     in the migrations table of when it happened.
 *
 *  2. IT MADE ROLLBACK NON-DETERMINISTIC. Deploy N+1 relabels a permission and
 *     restarts; the row is rewritten. Roll back to deploy N; the OLD code
 *     restarts and rewrites the row again — so "roll back" silently mutated
 *     data rather than only reverting code. Which state you end in depends on
 *     restart order.
 *
 *  3. IT RACED. Several API instances booting together each ran the same 45
 *     upserts. `ON CONFLICT` makes that safe from corruption, but it is still
 *     N instances writing rows nobody asked them to write, taking row locks on
 *     a table every authenticated request reads.
 *
 *  4. THE SELF-HEAL HID REAL FAULTS. A missing catalogue row means a migration
 *     did not run. Re-inserting it on the spot converts "this database is not
 *     at the expected version" — which an operator must know about — into a
 *     warning in a log nobody reads.
 *
 * WHAT HAPPENS NOW. Migrations own the rows. Startup reads them, compares them
 * to the code catalogue, and either proceeds or REFUSES TO START. Zero writes.
 * A booting instance takes no locks and cannot race another one, because there
 * is nothing to race over.
 *
 * WHY FAIL-FAST RATHER THAN WARN. Every outcome of a mismatch is an
 * authorisation fault:
 *
 *  - a MISSING code means `@RequirePermissions('x')` names a capability no
 *    role can be granted. Every route guarded by it is unreachable, including,
 *    if the code is `rbac.manage`, the route that would fix it;
 *  - an UNEXPECTED active code means the database offers a grant the running
 *    code does not check. An administrator ticks it, the screen says the role
 *    has it, and no guard ever consults it — authority that exists in the UI
 *    and nowhere else;
 *  - a METADATA mismatch means the Persian sentence shown in the confirmation
 *    dialog is not the sentence the current code intends. The administrator is
 *    consenting to a description of a capability rather than the capability.
 *
 * A process that starts in any of those states serves wrong answers quietly.
 * Refusing to start is loud, immediate, and fixable.
 *
 * THE RETIRED-PERMISSION LIFECYCLE. A code is retired by a migration setting
 * `permissions.retiredAt`, never by deleting the row: `role_permissions` has
 * `ON DELETE CASCADE`, so a delete would silently strip the capability from
 * every custom role that held it and leave no trace it had ever been granted.
 * A retired row keeps those grants visible and inert — the resolver ignores
 * retired codes — which is what makes retirement auditable and reversible. An
 * unexpected code that is retired is therefore fine; an unexpected code that
 * is still active is a fault.
 */

/** One row as stored. `retiredAt` is the whole lifecycle. */
export interface StoredPermissionRow {
  code: string;
  groupKey: string;
  labelFa: string;
  descriptionFa: string;
  risk: string;
  retiredAt: Date | string | null;
}

export type CatalogueProblemKind =
  | 'missing'
  | 'unexpected_active'
  | 'retired_but_required'
  | 'metadata_mismatch'
  | 'duplicate';

export interface CatalogueProblem {
  kind: CatalogueProblemKind;
  code: string;
  /** Human-readable specifics, e.g. which field differs and both values. */
  detail: string;
}

const FIELDS: ReadonlyArray<keyof PermissionSpec & keyof StoredPermissionRow> =
  ['groupKey', 'labelFa', 'descriptionFa', 'risk'];

/**
 * The whole comparison, as a PURE function of two lists.
 *
 * Pure deliberately: the decision "does this database match this code" is the
 * part worth testing exhaustively, and a pure function lets those tests run
 * without a database, a Nest container or a migration. The service below is
 * then thin enough to be obviously correct.
 *
 * Every problem is collected before returning. Reporting only the first would
 * turn one operator fix into a restart-and-discover loop.
 */
export function diffCatalogue(
  stored: readonly StoredPermissionRow[],
  expected: readonly PermissionSpec[] = PERMISSION_CATALOG,
): CatalogueProblem[] {
  const problems: CatalogueProblem[] = [];

  const byCode = new Map<string, StoredPermissionRow>();
  for (const row of stored) {
    if (byCode.has(row.code)) {
      // Unreachable while `uq_permissions_code` exists — asserted anyway,
      // because the alternative is a silently arbitrary winner.
      problems.push({
        kind: 'duplicate',
        code: row.code,
        detail: 'appears more than once in the permissions table',
      });
      continue;
    }
    byCode.set(row.code, row);
  }

  for (const spec of expected) {
    const row = byCode.get(spec.code);
    if (!row) {
      problems.push({
        kind: 'missing',
        code: spec.code,
        detail: `required by the code catalogue (group "${spec.groupKey}", risk "${spec.risk}") but absent from the database`,
      });
      continue;
    }

    if (row.retiredAt !== null && row.retiredAt !== undefined) {
      problems.push({
        kind: 'retired_but_required',
        code: spec.code,
        detail: `marked retired in the database (retiredAt=${String(row.retiredAt)}) but still declared by the code catalogue`,
      });
      // Metadata of a retired row is not worth reporting on top of this.
      continue;
    }

    for (const field of FIELDS) {
      const want = spec[field];
      const got = row[field];
      if (want !== got) {
        problems.push({
          kind: 'metadata_mismatch',
          code: spec.code,
          detail: `${field}: database has ${JSON.stringify(got)}, code expects ${JSON.stringify(want)}`,
        });
      }
    }
  }

  const expectedCodes = new Set(expected.map((spec) => spec.code));
  for (const row of stored) {
    if (expectedCodes.has(row.code)) continue;
    if (row.retiredAt !== null && row.retiredAt !== undefined) continue; // retired: fine
    problems.push({
      kind: 'unexpected_active',
      code: row.code,
      detail:
        'active in the database but not declared by the code catalogue; no guard can ever check it',
    });
  }

  return problems;
}

const REMEDY: Readonly<Record<CatalogueProblemKind, string>> = {
  missing:
    'Add a migration that INSERTs these rows. Do not let the application write them at runtime.',
  unexpected_active:
    'Either restore the code that declares them, or add a migration setting "retiredAt" so they stop granting anything. Do not DELETE the rows — that cascades through role_permissions and silently strips the capability from every custom role that held it.',
  retired_but_required:
    'Add a migration clearing "retiredAt", or remove the code from permission.catalog.ts and from every @RequirePermissions() that names it.',
  metadata_mismatch:
    'Add a migration that UPDATEs these rows to the values the code declares. The Persian label and description are what an administrator reads before consenting to a grant, so they are part of the contract, not cosmetic.',
  duplicate:
    'The unique constraint "uq_permissions_code" is missing or was dropped. Restore it.',
};

const HEADING: Readonly<Record<CatalogueProblemKind, string>> = {
  missing: 'MISSING FROM THE DATABASE',
  unexpected_active: 'ACTIVE IN THE DATABASE BUT NOT DECLARED IN CODE',
  retired_but_required: 'RETIRED IN THE DATABASE BUT STILL REQUIRED BY CODE',
  metadata_mismatch: 'METADATA MISMATCH',
  duplicate: 'DUPLICATE CODE',
};

const ORDER: readonly CatalogueProblemKind[] = [
  'missing',
  'unexpected_active',
  'retired_but_required',
  'metadata_mismatch',
  'duplicate',
];

/**
 * Formats the problems as the message the process dies with.
 *
 * Grouped by kind, each group carrying its own remedy, because the operator
 * reading this at 3am needs to know what to DO, not merely that something is
 * wrong. Codes are listed in full — a truncated list means a second restart to
 * discover the rest.
 */
export function formatCatalogueProblems(
  problems: readonly CatalogueProblem[],
): string {
  const lines: string[] = [
    'Permission catalogue integrity check FAILED — refusing to start.',
    '',
    'The "permissions" table does not match permission.catalog.ts. Starting in',
    'this state would mean the authorisation the code declares is not the',
    'authorisation the database can express, so this is refused rather than',
    'logged.',
  ];

  for (const kind of ORDER) {
    const group = problems.filter((problem) => problem.kind === kind);
    if (group.length === 0) continue;
    lines.push('', `${HEADING[kind]} (${group.length}):`);
    for (const problem of group) {
      lines.push(`  - ${problem.code} — ${problem.detail}`);
    }
    lines.push(`  FIX: ${REMEDY[kind]}`);
  }

  lines.push(
    '',
    'Catalogue rows are owned by migrations in apps/api/src/migrations/.',
    'Adding, retiring, relabelling, re-grouping or re-risking a permission is',
    'an explicit migration — by design.',
  );

  return lines.join('\n');
}
