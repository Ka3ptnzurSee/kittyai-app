import { test } from "node:test";
import assert from "node:assert";
import { randomBytes } from "node:crypto";
import { encryptString, decryptString, KEY_BYTES, NONCE_BYTES } from "../cryptoCore.ts";
import { utf8ToBytes } from "@noble/ciphers/utils.js";

const key = () => randomBytes(KEY_BYTES);
const nonce = () => randomBytes(NONCE_BYTES);

test("encryptString/decryptString: Roundtrip (inkl. Umlaute/Emoji)", () => {
  const msg = JSON.stringify({ a: 1, text: "Grüße 😀 Hallo Welt" });
  const k = key();
  const hex = encryptString(k, nonce(), msg);
  assert.strictEqual(decryptString(k, hex), msg);
});

test("Layout: hex beginnt mit 12-Byte-Nonce (24 Hex-Zeichen)", () => {
  const hex = encryptString(key(), nonce(), "test");
  assert.strictEqual(hex.length % 2, 0);
  // 12 Byte Nonce = 24 Hex-Zeichen; Rest = ciphertext + 16-Byte-Tag
  assert.ok(hex.length >= 24 + 32, `zu kurz: ${hex.length}`);
});

test("decryptString wirft bei manipuliertem Chiffretext (Tag-Mismatch)", () => {
  const k = key();
  const hex = encryptString(k, nonce(), "geheim");
  // 1 Byte im Ciphertext kippen (nach dem Nonce-Präfix)
  const idx = 24 + 4; // mitten im Ciphertext
  const flipped = hex.slice(0, idx) + (hex[idx] === "0" ? "1" : "0") + hex.slice(idx + 1);
  assert.throws(() => decryptString(k, flipped));
});

test("decryptString wirft bei falschem Key", () => {
  const hex = encryptString(key(), nonce(), "geheim");
  assert.throws(() => decryptString(key(), hex));
});

test("AAD-Bindung: mit falschem AAD schlägt die Entschlüsselung fehl", () => {
  const k = key();
  const hex = encryptString(k, nonce(), "geheim", utf8ToBytes("pi-store:v1:chats"));
  // richtiges AAD entschlüsselt
  assert.strictEqual(decryptString(k, hex, utf8ToBytes("pi-store:v1:chats")), "geheim");
  // falsches AAD (anderer Storage-Key) wirft → Ciphertext-Swap unterbunden
  assert.throws(() => decryptString(k, hex, utf8ToBytes("pi-store:v1:folders")));
});

test("encryptString/decryptString weisen falsche Key-Länge ab", () => {
  const shortKey = randomBytes(16); // AES-128 statt AES-256
  assert.throws(() => encryptString(shortKey, nonce(), "x"), /invalid key length/);
  const hex = encryptString(key(), nonce(), "x");
  assert.throws(() => decryptString(shortKey, hex), /invalid key length/);
});

test("encryptString weist falsche Nonce-Länge ab", () => {
  assert.throws(() => encryptString(key(), randomBytes(8), "x"), /invalid nonce length/);
});

test("Nonce-Neuverwendung mit gleichem Key ist NICHT gefordert (jeder Aufruf neue Nonce)", () => {
  // Sicherheits-Eigenschaft: unterschiedliche Nonces ⇒ unterschiedliche Chiffretexte.
  const k = key();
  const a = encryptString(k, randomBytes(NONCE_BYTES), "gleich");
  const b = encryptString(k, randomBytes(NONCE_BYTES), "gleich");
  assert.notStrictEqual(a, b);
});
