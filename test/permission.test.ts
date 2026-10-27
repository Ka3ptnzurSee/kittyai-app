import { test } from "node:test";
import assert from "node:assert";
import { applyPermission, type PermissionRequest } from "../lib.ts";

const req = (over: Partial<PermissionRequest> = {}): PermissionRequest => ({
  permissionId: "p1",
  turnId: "t1",
  tool: "bash",
  title: "Claude möchte bash ausführen",
  description: "ls -la",
  status: "pending",
  ...over,
});

test("permission_required fügt eine pending-Karte hinzu", () => {
  const out = applyPermission(undefined, "permission_required", {
    permissionId: "p1",
    turnId: "t1",
    tool: "bash",
    title: "Claude möchte bash ausführen",
    description: "ls -la",
  });
  assert.deepStrictEqual(out, [
    {
      permissionId: "p1",
      turnId: "t1",
      tool: "bash",
      title: "Claude möchte bash ausführen",
      description: "ls -la",
      status: "pending",
    },
  ]);
});

test("permission_required dedupliziert per permissionId (Resume-Schutz)", () => {
  const existing = [req()];
  const out = applyPermission(existing, "permission_required", { permissionId: "p1" });
  assert.strictEqual(out, existing); // identische Referenz → kein Duplikat
  assert.strictEqual(out!.length, 1);
});

test("permission_required ohne permissionId lässt die Liste unverändert", () => {
  const existing = [req()];
  assert.strictEqual(applyPermission(existing, "permission_required", {}), existing);
  assert.strictEqual(applyPermission(undefined, "permission_required", {}), undefined);
});

test("permission_resolved setzt allow → allowed", () => {
  const out = applyPermission([req()], "permission_resolved", { permissionId: "p1", decision: "allow" });
  assert.strictEqual(out![0].status, "allowed");
});

test("permission_resolved setzt deny → denied", () => {
  const out = applyPermission([req()], "permission_resolved", { permissionId: "p1", decision: "deny" });
  assert.strictEqual(out![0].status, "denied");
});

test("permission_resolved setzt timeout → denied (Server-Timeout = Tool übersprungen)", () => {
  const out = applyPermission([req()], "permission_resolved", { permissionId: "p1", decision: "timeout" });
  assert.strictEqual(out![0].status, "denied");
});

test("permission_resolved ignoriert unbekannte permissionId", () => {
  const existing = [req()];
  assert.strictEqual(applyPermission(existing, "permission_resolved", { permissionId: "gibts-nicht", decision: "allow" }), existing);
});

test("permission_resolved ohne gültige decision ändert nichts", () => {
  const existing = [req()];
  assert.strictEqual(applyPermission(existing, "permission_resolved", { permissionId: "p1" }), existing);
  assert.strictEqual(applyPermission(existing, "permission_resolved", { permissionId: "p1", decision: "weiss-nicht" }), existing);
});

test("unbekannte Event-Typen werden unverändert durchgereicht", () => {
  const existing = [req()];
  assert.strictEqual(applyPermission(existing, "text", {}), existing);
  assert.strictEqual(applyPermission(existing, "tool_start", { id: "x" }), existing);
});
