import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 0002 — the four NEW tables from docs/ARCHITECTURE.md section 4.
 *
 *   stock_reservations  basket + order holds       (lead-authored entity)
 *   stock_movements     append-only physical ledger with balanceAfter
 *   idempotency_keys    UNIQUE(scope,key) replay protection
 *   order_actions       post-creation audit with its own actor
 *
 * The four `WHERE status = 'active'` PARTIAL indexes on stock_reservations are
 * what make availability aggregation cheap: only live holds are indexed, so the
 * index never grows with historical rows.
 */
export class InventoryAuditTables1757000000002 implements MigrationInterface {
  name = 'InventoryAuditTables1757000000002';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ---------------------------------------------------- stock_reservations
    await queryRunner.query(
      `CREATE TYPE "public"."stock_reservations_kind_enum" AS ENUM('basket', 'order')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."stock_reservations_status_enum" AS ENUM('active', 'released', 'consumed', 'revoked')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."stock_reservations_releasereason_enum" AS ENUM('sold_in_store', 'reservation_expired', 'basket_item_removed', 'quantity_reduced', 'converted_to_order', 'order_cancelled', 'payment_failed', 'fulfilled')`,
    );
    await queryRunner.query(
      `CREATE TABLE "stock_reservations" ("id" SERIAL NOT NULL, "variantId" integer NOT NULL, "kind" "public"."stock_reservations_kind_enum" NOT NULL, "status" "public"."stock_reservations_status_enum" NOT NULL DEFAULT 'active', "quantity" integer NOT NULL, "userId" integer, "cartItemId" integer, "orderId" integer, "expiresAt" TIMESTAMP WITH TIME ZONE NOT NULL, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "releasedAt" TIMESTAMP WITH TIME ZONE, "releaseReason" "public"."stock_reservations_releasereason_enum", CONSTRAINT "PK_46ec0f5605d70f64654ad4e7bd9" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_res_active_variant" ON "stock_reservations" ("variantId") WHERE status = 'active'`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_res_active_expiry" ON "stock_reservations" ("expiresAt") WHERE status = 'active'`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_res_active_cart_item" ON "stock_reservations" ("cartItemId") WHERE status = 'active'`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_res_active_order" ON "stock_reservations" ("orderId") WHERE status = 'active'`,
    );
    await queryRunner.query(
      `ALTER TABLE "stock_reservations" ADD CONSTRAINT "FK_9db9f46b85339dae1a4a5fb61e9" FOREIGN KEY ("variantId") REFERENCES "product_variants"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "stock_reservations" ADD CONSTRAINT "FK_3fe2a1353f1d9a91e3f11157a85" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );

    // ------------------------------------------------------- stock_movements
    await queryRunner.query(
      `CREATE TYPE "public"."stock_movements_reason_enum" AS ENUM('pos_sale', 'online_fulfillment', 'cancellation_restore', 'return_restore', 'manual_adjustment')`,
    );
    await queryRunner.query(
      `CREATE TABLE "stock_movements" ("id" SERIAL NOT NULL, "variantId" integer NOT NULL, "delta" integer NOT NULL, "balanceAfter" integer NOT NULL, "reason" "public"."stock_movements_reason_enum" NOT NULL, "orderId" integer, "actorUserId" integer, "actorDisplaySnapshot" character varying, "branchId" integer, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_57a26b190618550d8e65fb860e7" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_movement_variant_created" ON "stock_movements" ("variantId", "createdAt")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_movement_order" ON "stock_movements" ("orderId")`,
    );
    await queryRunner.query(
      `ALTER TABLE "stock_movements" ADD CONSTRAINT "FK_b1e10f38c51868fba8bac1e12c9" FOREIGN KEY ("variantId") REFERENCES "product_variants"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "stock_movements" ADD CONSTRAINT "FK_b0a0b4aa53cb3feafaee55e8a80" FOREIGN KEY ("actorUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );

    // ------------------------------------------------------ idempotency_keys
    await queryRunner.query(
      `CREATE TYPE "public"."idempotency_keys_scope_enum" AS ENUM('pos_sale', 'online_order', 'payment_verify')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."idempotency_keys_status_enum" AS ENUM('in_progress', 'completed')`,
    );
    await queryRunner.query(
      `CREATE TABLE "idempotency_keys" ("id" SERIAL NOT NULL, "scope" "public"."idempotency_keys_scope_enum" NOT NULL, "key" character varying(255) NOT NULL, "requestHash" character varying(64) NOT NULL, "status" "public"."idempotency_keys_status_enum" NOT NULL DEFAULT 'in_progress', "responseStatus" integer, "responseBody" jsonb, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "completedAt" TIMESTAMP WITH TIME ZONE, CONSTRAINT "uq_idempotency_scope_key" UNIQUE ("scope", "key"), CONSTRAINT "PK_8ad20779ad0411107a56e53d0f6" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_idempotency_created" ON "idempotency_keys" ("createdAt")`,
    );

    // ---------------------------------------------------------- order_actions
    await queryRunner.query(
      `CREATE TYPE "public"."order_actions_action_enum" AS ENUM('status_change', 'void', 'return', 'refund')`,
    );
    await queryRunner.query(
      `CREATE TABLE "order_actions" ("id" SERIAL NOT NULL, "orderId" integer NOT NULL, "action" "public"."order_actions_action_enum" NOT NULL, "fromStatus" character varying, "toStatus" character varying, "actorUserId" integer, "actorDisplaySnapshot" character varying NOT NULL, "reason" text, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_3fabb2d5cd38912199c59b9b4ff" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_order_action_order" ON "order_actions" ("orderId", "createdAt")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_order_action_actor" ON "order_actions" ("actorUserId")`,
    );
    await queryRunner.query(
      `ALTER TABLE "order_actions" ADD CONSTRAINT "FK_ba2dbd64497ef3c72e22361a39e" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "order_actions" ADD CONSTRAINT "FK_618764f59ec45915c7494848d13" FOREIGN KEY ("actorUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "order_actions" DROP CONSTRAINT "FK_618764f59ec45915c7494848d13"`,
    );
    await queryRunner.query(
      `ALTER TABLE "order_actions" DROP CONSTRAINT "FK_ba2dbd64497ef3c72e22361a39e"`,
    );
    await queryRunner.query(`DROP INDEX "public"."idx_order_action_actor"`);
    await queryRunner.query(`DROP INDEX "public"."idx_order_action_order"`);
    await queryRunner.query(`DROP TABLE "order_actions"`);
    await queryRunner.query(`DROP TYPE "public"."order_actions_action_enum"`);

    await queryRunner.query(`DROP INDEX "public"."idx_idempotency_created"`);
    await queryRunner.query(`DROP TABLE "idempotency_keys"`);
    await queryRunner.query(
      `DROP TYPE "public"."idempotency_keys_status_enum"`,
    );
    await queryRunner.query(`DROP TYPE "public"."idempotency_keys_scope_enum"`);

    await queryRunner.query(
      `ALTER TABLE "stock_movements" DROP CONSTRAINT "FK_b0a0b4aa53cb3feafaee55e8a80"`,
    );
    await queryRunner.query(
      `ALTER TABLE "stock_movements" DROP CONSTRAINT "FK_b1e10f38c51868fba8bac1e12c9"`,
    );
    await queryRunner.query(`DROP INDEX "public"."idx_movement_order"`);
    await queryRunner.query(
      `DROP INDEX "public"."idx_movement_variant_created"`,
    );
    await queryRunner.query(`DROP TABLE "stock_movements"`);
    await queryRunner.query(`DROP TYPE "public"."stock_movements_reason_enum"`);

    await queryRunner.query(
      `ALTER TABLE "stock_reservations" DROP CONSTRAINT "FK_3fe2a1353f1d9a91e3f11157a85"`,
    );
    await queryRunner.query(
      `ALTER TABLE "stock_reservations" DROP CONSTRAINT "FK_9db9f46b85339dae1a4a5fb61e9"`,
    );
    await queryRunner.query(`DROP INDEX "public"."idx_res_active_order"`);
    await queryRunner.query(`DROP INDEX "public"."idx_res_active_cart_item"`);
    await queryRunner.query(`DROP INDEX "public"."idx_res_active_expiry"`);
    await queryRunner.query(`DROP INDEX "public"."idx_res_active_variant"`);
    await queryRunner.query(`DROP TABLE "stock_reservations"`);
    await queryRunner.query(
      `DROP TYPE "public"."stock_reservations_releasereason_enum"`,
    );
    await queryRunner.query(
      `DROP TYPE "public"."stock_reservations_status_enum"`,
    );
    await queryRunner.query(
      `DROP TYPE "public"."stock_reservations_kind_enum"`,
    );
  }
}
