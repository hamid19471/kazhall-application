import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 0001 — BASELINE.
 *
 * Recreates the full pre-existing 20-table schema exactly as `synchronize`
 * produced it: 16 entity tables plus the 4 ManyToMany join tables
 * (`user_roles`, `product_category`, `bookmark_products`,
 * `variant_product_attribute_value`).
 *
 * Constraint/index identifiers are TypeORM's own generated hashes so that a
 * database built from migrations is byte-for-byte comparable with one built by
 * `synchronize` — running `schema:log` against a migrated database must print
 * no pending changes for these tables.
 *
 * Everything from docs/ARCHITECTURE.md section 4 ("Schema changes") lands in
 * 0002 and later.
 */
export class BaselineSchema1757000000001 implements MigrationInterface {
  name = 'BaselineSchema1757000000001';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ---------------------------------------------------------------- tables
    await queryRunner.query(
      `CREATE TABLE "roles" ("id" SERIAL NOT NULL, "name" character varying NOT NULL, "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "UQ_648e3f5447f725579d7d4ffdfb7" UNIQUE ("name"), CONSTRAINT "PK_c1433d71a4838793a49dcad46ab" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE TABLE "branches" ("id" SERIAL NOT NULL, "name" character varying NOT NULL, "address" character varying, "phone" character varying, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "UQ_8387ed27b3d4ca53ec3fc7b029c" UNIQUE ("name"), CONSTRAINT "PK_7f37d3b42defea97f1df0d19535" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE TABLE "users" ("id" SERIAL NOT NULL, "mobile" character varying, "username" character varying, "password" character varying, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), "branchId" integer, CONSTRAINT "UQ_d376a9f93bba651f32a2c03a7d3" UNIQUE ("mobile"), CONSTRAINT "UQ_fe0bb3f6520ee0469504521e710" UNIQUE ("username"), CONSTRAINT "PK_a3ffb1c0c8416b9fc6f907b7433" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE TABLE "refresh_tokens" ("tokenId" uuid NOT NULL, "userId" integer NOT NULL, "tokenHash" character varying NOT NULL, "expiresAt" TIMESTAMP NOT NULL, "revoked" boolean NOT NULL DEFAULT false, CONSTRAINT "PK_48064cd66bef5bbbcc3eb196229" PRIMARY KEY ("tokenId"))`,
    );
    await queryRunner.query(
      `CREATE TABLE "addresses" ("id" SERIAL NOT NULL, "province" character varying NOT NULL, "city" character varying NOT NULL, "address" text NOT NULL, "postal_code" character varying(10) NOT NULL, "reciver_mobile" character varying(11) NOT NULL, "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), "userId" integer, CONSTRAINT "PK_745d8f43d3af10ab8247465e450" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE TABLE "customers" ("id" SERIAL NOT NULL, "mobile" character varying NOT NULL, "name" character varying, CONSTRAINT "UQ_6d1cb2e8c3ca15f7293464edad8" UNIQUE ("mobile"), CONSTRAINT "PK_133ec679a801fab5e070f73d3ea" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE TABLE "categories" ("id" SERIAL NOT NULL, "title" character varying NOT NULL, "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_24dbc6126a28ff948da33e97d3b" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE TABLE "products" ("id" SERIAL NOT NULL, "title" character varying NOT NULL, "description" character varying NOT NULL, "basePrice" bigint, "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_0806c755e0aca124e67c0cf6d7d" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE TABLE "product_variants" ("id" SERIAL NOT NULL, "price" bigint, "stock" integer NOT NULL DEFAULT '0', "sku" character varying NOT NULL, "productId" integer, CONSTRAINT "UQ_46f236f21640f9da218a063a866" UNIQUE ("sku"), CONSTRAINT "PK_281e3f2c55652d6a22c0aa59fd7" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE TABLE "product_images" ("id" SERIAL NOT NULL, "url" character varying NOT NULL, "sortOrder" integer, "productId" integer, CONSTRAINT "PK_1974264ea7265989af8392f63a1" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE TABLE "product_attribute" ("id" SERIAL NOT NULL, "name" character varying NOT NULL, CONSTRAINT "UQ_05d080e931ec850c1e0219ee111" UNIQUE ("name"), CONSTRAINT "PK_f9b91f38df3dbbe481d9e056e5e" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE TABLE "product_attribute_value" ("id" SERIAL NOT NULL, "value" character varying NOT NULL, "attributeId" integer, CONSTRAINT "PK_b95764a58737e9768a0a79ff1a6" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE TABLE "cart_items" ("id" SERIAL NOT NULL, "quantity" integer NOT NULL DEFAULT '1', "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), "userId" integer, "productId" integer, "variantId" integer, CONSTRAINT "UQ_0b6d1659abfc7f1a86f789b94e2" UNIQUE ("userId", "productId", "variantId"), CONSTRAINT "PK_6fccf5ec03c172d27a28a82928b" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."orders_channel_enum" AS ENUM('online', 'pos')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."orders_status_enum" AS ENUM('pending', 'paid', 'processing', 'shipped', 'delivered', 'canceled', 'failed', 'refunded')`,
    );
    await queryRunner.query(
      `CREATE TABLE "orders" ("id" SERIAL NOT NULL, "channel" "public"."orders_channel_enum" NOT NULL, "userId" integer, "branchId" integer, "customerId" integer, "status" "public"."orders_status_enum" NOT NULL DEFAULT 'pending', "paid_at" TIMESTAMP, "addressId" integer, "total_price" bigint NOT NULL DEFAULT '0', "discount_code" character varying, "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_710e2d4957aa5878dfe94e4ac2f" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE TABLE "order_items" ("id" SERIAL NOT NULL, "quantity" integer NOT NULL DEFAULT '1', "unit_price" bigint NOT NULL DEFAULT '0', "total_price" bigint NOT NULL DEFAULT '0', "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), "orderId" integer, "productId" integer, "variantId" integer, CONSTRAINT "PK_005269d8574e6fac0493715c308" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."payment_status_enum" AS ENUM('pending', 'success', 'failed', 'refunded')`,
    );
    await queryRunner.query(
      `CREATE TABLE "payment" ("id" SERIAL NOT NULL, "track_id" character varying, "amount" bigint NOT NULL, "status" "public"."payment_status_enum" NOT NULL DEFAULT 'pending', "paid_at" TIMESTAMP, "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), "orderId" integer, CONSTRAINT "PK_fcaec7df5adf9cac408c686b2ab" PRIMARY KEY ("id"))`,
    );

    // ----------------------------------------------------------- join tables
    await queryRunner.query(
      `CREATE TABLE "user_roles" ("usersId" integer NOT NULL, "rolesId" integer NOT NULL, CONSTRAINT "PK_38ffcfb865fc628fa337d9a0d4f" PRIMARY KEY ("usersId", "rolesId"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_99b019339f52c63ae615358738" ON "user_roles" ("usersId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_13380e7efec83468d73fc37938" ON "user_roles" ("rolesId")`,
    );
    await queryRunner.query(
      `CREATE TABLE "product_category" ("product_id" integer NOT NULL, "category_id" integer NOT NULL, CONSTRAINT "PK_c14c8e52460c8062f62e7e8f416" PRIMARY KEY ("product_id", "category_id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_0374879a971928bc3f57eed0a5" ON "product_category" ("product_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_2df1f83329c00e6eadde0493e1" ON "product_category" ("category_id")`,
    );
    await queryRunner.query(
      `CREATE TABLE "bookmark_products" ("product_id" integer NOT NULL, "user_id" integer NOT NULL, CONSTRAINT "PK_5c68c075686921e7efd7bc4c766" PRIMARY KEY ("product_id", "user_id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_a64de33e3e3efeeae920062563" ON "bookmark_products" ("product_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_ab67587a3a313d89af74d48b48" ON "bookmark_products" ("user_id")`,
    );
    await queryRunner.query(
      `CREATE TABLE "variant_product_attribute_value" ("productVariantsId" integer NOT NULL, "productAttributeValueId" integer NOT NULL, CONSTRAINT "PK_49e217e96aa3b9a448284992049" PRIMARY KEY ("productVariantsId", "productAttributeValueId"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_c1b0558eb5e4b8d40a50ff68c1" ON "variant_product_attribute_value" ("productVariantsId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_b38035b4450d04abc91d3fa9d8" ON "variant_product_attribute_value" ("productAttributeValueId")`,
    );

    // ---------------------------------------------------------- foreign keys
    await queryRunner.query(
      `ALTER TABLE "users" ADD CONSTRAINT "FK_246426dfd001466a1d5e47322f4" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "refresh_tokens" ADD CONSTRAINT "FK_610102b60fea1455310ccd299de" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "addresses" ADD CONSTRAINT "FK_95c93a584de49f0b0e13f753630" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "product_variants" ADD CONSTRAINT "FK_f515690c571a03400a9876600b5" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "product_images" ADD CONSTRAINT "FK_b367708bf720c8dd62fc6833161" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "product_attribute_value" ADD CONSTRAINT "FK_72a07a05e866d7f19ddb2457127" FOREIGN KEY ("attributeId") REFERENCES "product_attribute"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "cart_items" ADD CONSTRAINT "FK_84e765378a5f03ad9900df3a9ba" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "cart_items" ADD CONSTRAINT "FK_72679d98b31c737937b8932ebe6" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "cart_items" ADD CONSTRAINT "FK_5a27845bc2d79be6f1fa3d2c036" FOREIGN KEY ("variantId") REFERENCES "product_variants"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "orders" ADD CONSTRAINT "FK_151b79a83ba240b0cb31b2302d1" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "orders" ADD CONSTRAINT "FK_873d9661d948ee484150cf4c73d" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "orders" ADD CONSTRAINT "FK_e5de51ca888d8b1f5ac25799dd1" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "orders" ADD CONSTRAINT "FK_37636d260931dcf46d11892f614" FOREIGN KEY ("addressId") REFERENCES "addresses"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "order_items" ADD CONSTRAINT "FK_f1d359a55923bb45b057fbdab0d" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "order_items" ADD CONSTRAINT "FK_cdb99c05982d5191ac8465ac010" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "order_items" ADD CONSTRAINT "FK_516736b9807228bb17b2d0a3e2a" FOREIGN KEY ("variantId") REFERENCES "product_variants"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "payment" ADD CONSTRAINT "FK_d09d285fe1645cd2f0db811e293" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "user_roles" ADD CONSTRAINT "FK_99b019339f52c63ae6153587380" FOREIGN KEY ("usersId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE`,
    );
    await queryRunner.query(
      `ALTER TABLE "user_roles" ADD CONSTRAINT "FK_13380e7efec83468d73fc37938e" FOREIGN KEY ("rolesId") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE`,
    );
    await queryRunner.query(
      `ALTER TABLE "product_category" ADD CONSTRAINT "FK_0374879a971928bc3f57eed0a59" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE`,
    );
    await queryRunner.query(
      `ALTER TABLE "product_category" ADD CONSTRAINT "FK_2df1f83329c00e6eadde0493e16" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "bookmark_products" ADD CONSTRAINT "FK_a64de33e3e3efeeae9200625634" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE`,
    );
    await queryRunner.query(
      `ALTER TABLE "bookmark_products" ADD CONSTRAINT "FK_ab67587a3a313d89af74d48b480" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "variant_product_attribute_value" ADD CONSTRAINT "FK_c1b0558eb5e4b8d40a50ff68c16" FOREIGN KEY ("productVariantsId") REFERENCES "product_variants"("id") ON DELETE CASCADE ON UPDATE CASCADE`,
    );
    await queryRunner.query(
      `ALTER TABLE "variant_product_attribute_value" ADD CONSTRAINT "FK_b38035b4450d04abc91d3fa9d81" FOREIGN KEY ("productAttributeValueId") REFERENCES "product_attribute_value"("id") ON DELETE CASCADE ON UPDATE CASCADE`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Foreign keys first, then join tables, then tables, then enum types —
    // the exact reverse of up().
    await queryRunner.query(
      `ALTER TABLE "variant_product_attribute_value" DROP CONSTRAINT "FK_b38035b4450d04abc91d3fa9d81"`,
    );
    await queryRunner.query(
      `ALTER TABLE "variant_product_attribute_value" DROP CONSTRAINT "FK_c1b0558eb5e4b8d40a50ff68c16"`,
    );
    await queryRunner.query(
      `ALTER TABLE "bookmark_products" DROP CONSTRAINT "FK_ab67587a3a313d89af74d48b480"`,
    );
    await queryRunner.query(
      `ALTER TABLE "bookmark_products" DROP CONSTRAINT "FK_a64de33e3e3efeeae9200625634"`,
    );
    await queryRunner.query(
      `ALTER TABLE "product_category" DROP CONSTRAINT "FK_2df1f83329c00e6eadde0493e16"`,
    );
    await queryRunner.query(
      `ALTER TABLE "product_category" DROP CONSTRAINT "FK_0374879a971928bc3f57eed0a59"`,
    );
    await queryRunner.query(
      `ALTER TABLE "user_roles" DROP CONSTRAINT "FK_13380e7efec83468d73fc37938e"`,
    );
    await queryRunner.query(
      `ALTER TABLE "user_roles" DROP CONSTRAINT "FK_99b019339f52c63ae6153587380"`,
    );
    await queryRunner.query(
      `ALTER TABLE "payment" DROP CONSTRAINT "FK_d09d285fe1645cd2f0db811e293"`,
    );
    await queryRunner.query(
      `ALTER TABLE "order_items" DROP CONSTRAINT "FK_516736b9807228bb17b2d0a3e2a"`,
    );
    await queryRunner.query(
      `ALTER TABLE "order_items" DROP CONSTRAINT "FK_cdb99c05982d5191ac8465ac010"`,
    );
    await queryRunner.query(
      `ALTER TABLE "order_items" DROP CONSTRAINT "FK_f1d359a55923bb45b057fbdab0d"`,
    );
    await queryRunner.query(
      `ALTER TABLE "orders" DROP CONSTRAINT "FK_37636d260931dcf46d11892f614"`,
    );
    await queryRunner.query(
      `ALTER TABLE "orders" DROP CONSTRAINT "FK_e5de51ca888d8b1f5ac25799dd1"`,
    );
    await queryRunner.query(
      `ALTER TABLE "orders" DROP CONSTRAINT "FK_873d9661d948ee484150cf4c73d"`,
    );
    await queryRunner.query(
      `ALTER TABLE "orders" DROP CONSTRAINT "FK_151b79a83ba240b0cb31b2302d1"`,
    );
    await queryRunner.query(
      `ALTER TABLE "cart_items" DROP CONSTRAINT "FK_5a27845bc2d79be6f1fa3d2c036"`,
    );
    await queryRunner.query(
      `ALTER TABLE "cart_items" DROP CONSTRAINT "FK_72679d98b31c737937b8932ebe6"`,
    );
    await queryRunner.query(
      `ALTER TABLE "cart_items" DROP CONSTRAINT "FK_84e765378a5f03ad9900df3a9ba"`,
    );
    await queryRunner.query(
      `ALTER TABLE "product_attribute_value" DROP CONSTRAINT "FK_72a07a05e866d7f19ddb2457127"`,
    );
    await queryRunner.query(
      `ALTER TABLE "product_images" DROP CONSTRAINT "FK_b367708bf720c8dd62fc6833161"`,
    );
    await queryRunner.query(
      `ALTER TABLE "product_variants" DROP CONSTRAINT "FK_f515690c571a03400a9876600b5"`,
    );
    await queryRunner.query(
      `ALTER TABLE "addresses" DROP CONSTRAINT "FK_95c93a584de49f0b0e13f753630"`,
    );
    await queryRunner.query(
      `ALTER TABLE "refresh_tokens" DROP CONSTRAINT "FK_610102b60fea1455310ccd299de"`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" DROP CONSTRAINT "FK_246426dfd001466a1d5e47322f4"`,
    );

    await queryRunner.query(
      `DROP INDEX "public"."IDX_b38035b4450d04abc91d3fa9d8"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_c1b0558eb5e4b8d40a50ff68c1"`,
    );
    await queryRunner.query(`DROP TABLE "variant_product_attribute_value"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_ab67587a3a313d89af74d48b48"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_a64de33e3e3efeeae920062563"`,
    );
    await queryRunner.query(`DROP TABLE "bookmark_products"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_2df1f83329c00e6eadde0493e1"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_0374879a971928bc3f57eed0a5"`,
    );
    await queryRunner.query(`DROP TABLE "product_category"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_13380e7efec83468d73fc37938"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_99b019339f52c63ae615358738"`,
    );
    await queryRunner.query(`DROP TABLE "user_roles"`);

    await queryRunner.query(`DROP TABLE "payment"`);
    await queryRunner.query(`DROP TYPE "public"."payment_status_enum"`);
    await queryRunner.query(`DROP TABLE "order_items"`);
    await queryRunner.query(`DROP TABLE "orders"`);
    await queryRunner.query(`DROP TYPE "public"."orders_status_enum"`);
    await queryRunner.query(`DROP TYPE "public"."orders_channel_enum"`);
    await queryRunner.query(`DROP TABLE "cart_items"`);
    await queryRunner.query(`DROP TABLE "product_attribute_value"`);
    await queryRunner.query(`DROP TABLE "product_attribute"`);
    await queryRunner.query(`DROP TABLE "product_images"`);
    await queryRunner.query(`DROP TABLE "product_variants"`);
    await queryRunner.query(`DROP TABLE "products"`);
    await queryRunner.query(`DROP TABLE "categories"`);
    await queryRunner.query(`DROP TABLE "customers"`);
    await queryRunner.query(`DROP TABLE "addresses"`);
    await queryRunner.query(`DROP TABLE "refresh_tokens"`);
    await queryRunner.query(`DROP TABLE "users"`);
    await queryRunner.query(`DROP TABLE "branches"`);
    await queryRunner.query(`DROP TABLE "roles"`);
  }
}
