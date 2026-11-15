import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 0014 — a blank idempotency key can never be stored (FINDING G).
 *
 * WHAT WAS WRONG BEFORE
 * ---------------------
 * `idempotency_keys.key` is `varchar(255) NOT NULL`, and that was the whole of
 * the shape guarantee. `''`, `'   '` and `'\t'` are all perfectly valid values
 * of that type, so the UNIQUE(scope, key) index — the primitive the entire
 * replay protocol is built on — was one careless caller away from being
 * meaningless: every request that sent a blank key would collide with every
 * other request that sent a blank key, in a completely unrelated sale, and
 * either 409 against a stranger's row or replay a stranger's response.
 *
 * The POS route now rejects that at the edge (`requirePosIdempotencyKey`
 * enforces 8–200 characters from `[A-Za-z0-9._:-]`), but the edge check only
 * covers the one route that has it. `IdempotencyScope` already declares
 * `online_order` and `payment_verify`, and those call sites are owned by other
 * workstreams and do not exist yet. A constraint in the database holds for all
 * three, today and for whatever is written next, which is the difference
 * between an invariant and a convention.
 *
 * WHY ONLY THE EMPTINESS CHECK, NOT THE FULL FORMAT
 * -------------------------------------------------
 * The 8–200 / charset rule is a POS CLIENT contract and belongs to the POS
 * route: another scope may legitimately key on a gateway's own reference,
 * whose format is not ours to choose. What no scope can ever legitimately want
 * is a key that is indistinguishable from every other blank key. So the
 * database enforces exactly the part that is universal.
 *
 * COMPATIBILITY
 * -------------
 * Added `NOT VALID`, deliberately. A plain `ADD CONSTRAINT ... CHECK` scans the
 * existing table and FAILS the whole migration if a single legacy row violates
 * it — turning a defence-in-depth improvement into a deployment outage on a
 * database nobody can inspect first. `NOT VALID` skips that scan while still
 * enforcing the check on every INSERT and UPDATE from this point on, which is
 * the entire benefit. Any pre-existing blank key is already dead weight (its
 * scope+key pair is unusable) and expires with the normal retention sweep; a
 * later `VALIDATE CONSTRAINT` can be run by hand once that is confirmed.
 *
 * No column is added, removed or retyped, so entity metadata is unchanged and
 * nothing outside this file needs to know the constraint exists.
 */
export class IdempotencyKeyShapeConstraint1757000000014 implements MigrationInterface {
  name = 'IdempotencyKeyShapeConstraint1757000000014';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "idempotency_keys" ` +
        `ADD CONSTRAINT "ck_idempotency_key_not_blank" ` +
        `CHECK (btrim("key") <> '') NOT VALID`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "idempotency_keys" ` +
        `DROP CONSTRAINT "ck_idempotency_key_not_blank"`,
    );
  }
}
