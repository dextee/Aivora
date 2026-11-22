/* Customer Contacts anomaly reasons: every quarantined record/contact carries a
 * plain-language explanation of WHY it is anomalous (additive to validation). */
import assert from "node:assert/strict";
import test from "node:test";
import { validateRows, ANOMALY_REASONS, explainAnomalies } from "../server/odai/business.mjs";

const catalog = [{ product_id: "P1", approved_selling_price: 19.9, currency: "SGD" }];
const customers = [{ customer_id: "C1" }];

test("quarantined purchase records carry human-readable reasons", () => {
  const rows = [
    { order_number: "O1", customer_id: "C1", product_id: "P1", purchase_date: "2026-01-01", quantity: 2, unit_price: 19.9, total_amount: 99.99, currency: "SGD" },
    { order_number: "O2", customer_id: "C1", product_id: "P1", purchase_date: "2026-01-02", quantity: 2, unit_price: 19.9, total_amount: 39.8, currency: "SGD" },
  ];
  const [bad, good] = validateRows(rows, customers, catalog);
  assert.equal(bad.status, "QUARANTINED");
  assert.ok(bad.errors.includes("ARITHMETIC_DISCREPANCY"));
  assert.ok(Array.isArray(bad.reasons) && bad.reasons.length === bad.errors.length);
  assert.match(bad.reasons.join(" "), /total does not equal unit price/i);
  assert.equal(good.status, "VERIFIED");
  assert.deepEqual(good.reasons, []);
});

test("unauthorized price and unknown customer are explained", () => {
  const rows = [{ order_number: "O3", customer_id: "GHOST", product_id: "P1", purchase_date: "2026-01-03", quantity: 1, unit_price: 5.0, total_amount: 5.0, currency: "SGD" }];
  const [r] = validateRows(rows, customers, catalog);
  assert.equal(r.status, "QUARANTINED");
  assert.ok(r.errors.includes("UNKNOWN_CUSTOMER"));
  assert.ok(r.errors.includes("UNAUTHORIZED_PRICE"));
  assert.match(r.reasons.join(" "), /does not match any single verified contact/i);
  assert.match(r.reasons.join(" "), /differs from the approved catalog selling price/i);
});

test("every error code has a plain-language reason; explainAnomalies maps codes", () => {
  for (const code of ["ORDER_ID_REQUIRED", "DUPLICATE_ORDER_ID", "DUPLICATE_PAYLOAD", "UNKNOWN_CUSTOMER", "INVALID_DATE", "INVALID_QUANTITY", "UNKNOWN_PRODUCT", "CURRENCY_MISMATCH", "INVALID_MONEY", "ARITHMETIC_DISCREPANCY", "UNAUTHORIZED_PRICE", "INVALID_EMAIL", "INVALID_PHONE", "CONSENT_UNVERIFIED", "DUPLICATE_CUSTOMER_ID"]) {
    assert.ok(ANOMALY_REASONS[code] && ANOMALY_REASONS[code].length > 20, "reason exists for " + code);
  }
  const explained = explainAnomalies(["INVALID_PHONE", "CONSENT_UNVERIFIED"]);
  assert.equal(explained.length, 2);
  assert.match(explained[0].reason, /valid dialable format/i);
  assert.match(explained[1].reason, /outreach is not authorized/i);
});