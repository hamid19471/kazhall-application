import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 0015 — immutable delivery-address snapshot on `orders` (workstream C, lead).
 *
 * WHY. `orders."addressId"` is a live foreign key into `addresses`, and
 * `AddressService.update()` mutates that row in place. So editing a saved
 * address silently rewrote the delivery address of every past order that
 * pointed at it, and deleting one (`AddressService.remove()` is a hard
 * `DELETE`) either failed or orphaned the reference. Neither is acceptable for
 * a record of where goods were actually sent — a dispatched order's address is
 * a historical fact, not a pointer to the customer's current address book.
 *
 * The FK is KEPT (it is still useful for "which saved address did this come
 * from") and the snapshot is added ALONGSIDE it. `addressSnapshot` is the
 * authoritative delivery address for fulfilment and for any dispute; the FK is
 * provenance only.
 *
 * jsonb rather than six flat columns: the snapshot is read as a whole, never
 * filtered field-by-field, and a jsonb blob does not need a migration every
 * time the address shape gains a field. It carries `capturedAt` and the source
 * `addressId` so a reader can tell when it was taken and what it came from.
 *
 * BACKFILL. Existing orders are backfilled from the address they still point
 * at, stamped `capturedAt: null` and `backfilled: true`. That is deliberately
 * NOT a claim that the address was correct at order time — it is the address as
 * it stands TODAY, which is the only thing that can be known now. Rows whose
 * address was already deleted stay NULL rather than being invented.
 */
export class OrderAddressSnapshot1757000000015 implements MigrationInterface {
  name = 'OrderAddressSnapshot1757000000015';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "orders" ADD "addressSnapshot" jsonb`);

    await queryRunner.query(`
      UPDATE "orders" o
         SET "addressSnapshot" = jsonb_build_object(
               'addressId',      a."id",
               'province',       a."province",
               'city',           a."city",
               'address',        a."address",
               'postalCode',     a."postal_code",
               'receiverMobile', a."reciver_mobile",
               'capturedAt',     NULL,
               'backfilled',     true
             )
        FROM "addresses" a
       WHERE o."addressId" = a."id"
         AND o."addressSnapshot" IS NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "orders" DROP COLUMN "addressSnapshot"`,
    );
  }
}
