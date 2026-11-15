// Seeds ONLY what the pricing browser journey needs into a disposable database
// created by run.sh (docs/MONTHLY-PRICING.md §10):
//
//   - one branch and one cashier (role `sale`) with a known password;
//   - one simple product, offered on the site and at every branch, whose
//     opening stock is recorded through the real API with a purchase cost
//     (15 units @ 1 066 666 Rial, current price 1 500 000);
//   - one completed POS sale of it — the "old order" that must keep its price.
//
// Usage: node seed.mjs <apiBase> <database> <stateFile>
// The owner's username and both passwords are read from run.sh's state file,
// which must be mode 600; no secret is ever passed on the command line or
// printed. Prints the fixture ids as JSON. Uses `pg` and `bcrypt` from apps/api, which
// are already its dependencies; nothing is installed.
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const [apiBase, database, stateFile] = process.argv.slice(2);
if (!apiBase || !/^kazhal_pricing_e2e_\d+_\d+$/.test(database ?? "") || !stateFile) {
  console.error("usage: node seed.mjs <apiBase> <kazhal_pricing_e2e_*> <stateFile>");
  process.exit(2);
}
if ((statSync(stateFile).mode & 0o077) !== 0) {
  console.error(`refusing to read credentials from ${stateFile}: it must be mode 600`);
  process.exit(2);
}
const state = Object.fromEntries(
  readFileSync(stateFile, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.includes("="))
    .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
);
const { ADMIN_USER: adminUser, ADMIN_PASS: adminPass, CASHIER_PASS: cashierPass } = state;
if (!adminUser || !adminPass || !cashierPass) {
  console.error(`${stateFile} does not record ADMIN_USER, ADMIN_PASS and CASHIER_PASS`);
  process.exit(2);
}

const apiDir = join(dirname(fileURLToPath(import.meta.url)), "../../apps/api");
const require = createRequire(join(apiDir, "package.json"));
const { Client } = require("pg");
const bcrypt = require("bcrypt");

// Connection settings from apps/api/.env; only the database name is overridden.
const env = {};
for (const line of readFileSync(join(apiDir, ".env"), "utf8").split(/\r?\n/)) {
  const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (match) env[match[1]] = match[2];
}

const ORIGIN = apiBase.replace(":18000", ":18001");
const PRODUCT_CODE = "E2E-PRICING-1";
const CASHIER = "e2e_cashier";

async function call(method, path, { body, cookie, key } = {}) {
  const res = await fetch(`${apiBase}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Origin: ORIGIN,
      ...(cookie ? { Cookie: cookie } : {}),
      ...(key ? { "Idempotency-Key": key } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
  return { res, json: text ? JSON.parse(text) : null };
}

function cookiesOf(res) {
  return res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
}

const db = new Client({
  host: env.DB_HOST,
  port: Number(env.DB_PORT),
  user: env.DB_USERNAME,
  password: env.DB_PASSWORD,
  database,
});
await db.connect();
try {
  const [{ current }] = (await db.query("SELECT current_database() AS current")).rows;
  if (current !== database) throw new Error(`connected to ${current}, expected ${database}`);

  const { rows: [branch] } = await db.query(
    `INSERT INTO branches (name) VALUES ('شعبهٔ آزمون قیمت‌گذاری') RETURNING id`,
  );
  const hash = await bcrypt.hash(cashierPass, 10);
  const { rows: [cashier] } = await db.query(
    `INSERT INTO users (username, password, "branchId") VALUES ($1, $2, $3) RETURNING id`,
    [CASHIER, hash, branch.id],
  );
  await db.query(
    `INSERT INTO user_roles ("usersId", "rolesId") SELECT $1, id FROM roles WHERE name = 'sale'`,
    [cashier.id],
  );

  const admin = cookiesOf((await call("POST", "/auth/admin/login", { body: { username: adminUser, password: adminPass } })).res);
  const created = await call("POST", "/products", {
    cookie: admin,
    body: {
      title: "کالای آزمون قیمت‌گذاری",
      description: "disposable pricing browser fixture",
      productCode: PRODUCT_CODE,
      basePrice: 1_500_000,
      visibleOnSite: true,
      branchVisibility: "all",
      initialStock: 15,
      purchasePrice: 1_066_666,
    },
  });
  const productId = Number(created.json?.data?.id ?? created.json?.id);
  const { rows: [variant] } = await db.query(
    `SELECT id, price::text AS price FROM product_variants WHERE "productId" = $1 AND "isDefault"`,
    [productId],
  );

  const till = cookiesOf((await call("POST", "/auth/pos/login", { body: { username: CASHIER, password: cashierPass } })).res);
  await call("POST", "/orders/pos", {
    cookie: till,
    key: `e2e-${randomUUID()}`,
    body: { items: [{ productVariantId: variant.id, quantity: 1 }], paymentMethod: "cash" },
  });
  const { rows: [order] } = await db.query(
    `SELECT o.id, i.unit_price::text AS "unitPrice" FROM orders o JOIN order_items i ON i."orderId" = o.id
      WHERE i."variantId" = $1 ORDER BY o.id DESC LIMIT 1`,
    [variant.id],
  );

  process.stdout.write(
    JSON.stringify(
      {
        database,
        branchId: branch.id,
        cashier: CASHIER,
        productId,
        productCode: PRODUCT_CODE,
        variantId: variant.id,
        priceBefore: variant.price,
        orderId: order.id,
        orderUnitPrice: order.unitPrice,
      },
      null,
      2,
    ) + "\n",
  );
} finally {
  await db.end();
}
