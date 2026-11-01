// Reiner, RN-unabhängiger AES-256-GCM-Kern — extrahiert, damit er ohne Expo/native
// Module in Node getestet werden kann (Roundtrip + Tamper-Erkennung).
import { gcm } from "@noble/ciphers/aes.js";
import { bytesToHex, hexToBytes, concatBytes, utf8ToBytes, bytesToUtf8 } from "@noble/ciphers/utils.js";

export const KEY_BYTES = 32; // AES-256
export const NONCE_BYTES = 12; // GCM-Standard-Nonce

/** `plaintext` → hex(`nonce` ‖ `ciphertext`+16-Byte-Tag). */
export function encryptString(key: Uint8Array, nonce: Uint8Array, plaintext: string, aad?: Uint8Array): string {
  if (key.length !== KEY_BYTES) throw new Error("invalid key length");
  if (nonce.length !== NONCE_BYTES) throw new Error("invalid nonce length");
  // AAD bindet den Chiffretext an den Storage-Key (Domain-Separation) — ein von Key A
  // nach Key B kopierter Block schlägt dann fehl (Ciphertext-Swap unterbunden).
  const ct = gcm(key, nonce, aad).encrypt(utf8ToBytes(plaintext));
  return bytesToHex(concatBytes(nonce, ct));
}

/** hex(`nonce` ‖ `ciphertext`+Tag) → `plaintext`. Wirft bei Tag-Mismatch/Manipulation. */
export function decryptString(key: Uint8Array, hex: string, aad?: Uint8Array): string {
  if (key.length !== KEY_BYTES) throw new Error("invalid key length");
  const all = hexToBytes(hex);
  if (all.length < NONCE_BYTES + 16) throw new Error("invalid ciphertext length"); // Nonce + GCM-Tag Minimum
  const nonce = all.slice(0, NONCE_BYTES);
  const ct = all.slice(NONCE_BYTES);
  return bytesToUtf8(gcm(key, nonce, aad).decrypt(ct));
}
