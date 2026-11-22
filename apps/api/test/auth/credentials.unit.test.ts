import { randomBytes, scryptSync } from "node:crypto";
import { expect, it } from "vitest";
import { hashPassword, verifyPassword } from "../../src/modules/auth/credentials.js";

it("uses a separate scrypt salt per password and verifies the exact password", async () => {
  const password = "  a long password  ";
  const [first, second] = await Promise.all([hashPassword(password), hashPassword(password)]);
  const format = /^scrypt\$32768\$8\$3\$67108864\$[a-f0-9]{32}\$[a-f0-9]{128}$/;
  expect(first).toMatch(format);
  expect(second).toMatch(format);
  expect(first.split("$")[5]).not.toBe(second.split("$")[5]);
  await expect(verifyPassword(password, first)).resolves.toBe(true);
  await expect(verifyPassword(password.trim(), first)).resolves.toBe(false);
});

it("rejects missing or malformed stored credentials", async () => {
  const results = await Promise.all([
    verifyPassword("a long password", undefined),
    verifyPassword("a long password", "scrypt$2$8$3$67108864$00$00"),
  ]);
  expect(results).toEqual([false, false]);
});

it("verifies a password with the scrypt parameters encoded in the stored hash", async () => {
  const password = "a long password";
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, 64, { N: 16384, r: 4, p: 2, maxmem: 32 * 1024 * 1024 });
  const stored = `scrypt$16384$4$2$33554432$${salt.toString("hex")}$${key.toString("hex")}`;
  await expect(verifyPassword(password, stored)).resolves.toBe(true);
  await expect(verifyPassword(`${password}!`, stored)).resolves.toBe(false);
});
