// Verschlüsselte Persistenz für sensible Inhalte (Chats, Ordner).
//
// Problem: AsyncStorage legt Werte im Klartext ab (Android: SQLite, iOS: plist).
// Gesprächsinhalte sind damit auf gerooteten/jailbrokenen Geräten und in Backups lesbar.
//
// Lösung: AES-256-GCM mit einem einmalig erzeugten Master-Key, der im Keychain/Keystore
// (expo-secure-store) liegt. Der Chiffretext (nonce || ciphertext+tag, hex-codiert) bleibt
// in AsyncStorage, ist dort aber ohne den Key unlesbar.
//
// Migration: Bestehende Klartext-Bestände werden beim ersten Laden übernommen, neu
// verschlüsselt und der Klartext entfernt (siehe App.tsx-Ladelogik).
import * as SecureStore from "expo-secure-store";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Crypto from "expo-crypto";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/ciphers/utils.js";
import { encryptString, decryptString, KEY_BYTES, NONCE_BYTES } from "./cryptoCore";

const MASTER_KEY_NAME = "pi-master-key";

/** AAD zur Domain-Separation: bindet den Chiffretext an den Storage-Key-Namen,
 *  sodass ein unter Key A erzeugter Block nicht unter Key B entschlüsselt werden kann. */
const aadFor = (storageKey: string): Uint8Array => utf8ToBytes(`pi-store:v1:${storageKey}`);

/** Wird geworfen, wenn Chiffretext vorhanden, aber nicht entschlüsselbar ist
 *  (Key verloren/korrupt) — unterscheidbar von „nicht vorhanden" (`null`). */
export class SecureStoreError extends Error {
  constructor(key: string) {
    super(`Entschlüsselung fehlgeschlagen (${key})`);
    this.name = "SecureStoreError";
  }
}

/** Liest den Master-Key AUS dem Keychain (erzeugt NIE einen). `null` = kein Key vorhanden.
 *  Wirft `SecureStoreError` bei korruptem Key (nicht-hex oder falsche Länge). */
async function readKey(): Promise<Uint8Array | null> {
  const existing = await SecureStore.getItemAsync(MASTER_KEY_NAME);
  if (!existing) return null;
  let parsed: Uint8Array;
  try {
    parsed = hexToBytes(existing);
  } catch {
    throw new SecureStoreError(MASTER_KEY_NAME); // korrupter (nicht-hex) Key
  }
  if (parsed.length !== KEY_BYTES) throw new SecureStoreError(MASTER_KEY_NAME); // falsche Länge
  return parsed;
}

// Single-Flight: der Master-Key wird pro Prozess-Lebensdauer genau einmal ERZEUGT (nur im
// WRITE-Pfad). Der READ-Pfad (secureGet) nutzt readKey() direkt und liest bei jedem Aufruf
// frisch vom Keychain — und erzeugt NIE einen Key. So wird nach einem Geräte-Restore
// (Chiffretext da, Key fehlt) kein frischer Key persistiert, der einen evtl. später
// eintreffenden echten Key verdrängt.
let keyPromise: Promise<Uint8Array> | null = null;
function masterKey(): Promise<Uint8Array> {
  if (!keyPromise) {
    keyPromise = (async () => {
      const existing = await readKey();
      if (existing) return existing;
      const key = Crypto.getRandomBytes(KEY_BYTES);
      // THIS_DEVICE_ONLY: Key wird NICHT in iOS-Backups gesichert — sonst wäre der
      // Chiffretext (AsyncStorage liegt im Backup) zusammen mit dem Key wiederherstellbar
      // und die Verschlüsselung gegenüber Backup-Extraktion wirkungslos.
      // Hinweis: kSecAttrAccessible ist auf iOS nach dem Anlegen UNVERÄNDERLICH — die
      // Option greift also nur beim Erzeugen. Da dieses Feature noch nicht released ist,
      // existiert kein Alt-Key mit anderer Accessibility; eine Laufzeit-Migration ist nicht nötig.
      await SecureStore.setItemAsync(MASTER_KEY_NAME, bytesToHex(key), {
        keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
      });
      return key;
    })().catch((e) => {
      // Fehlerfall nicht dauerhaft memoisieren — nächster Aufruf versucht es neu.
      keyPromise = null;
      throw e;
    });
  }
  return keyPromise;
}

/** Wert AES-256-GCM-verschlüsselt unter `key` in AsyncStorage ablegen.
 *  VORAUSSETZUNG: der Caller hat den Bestand vorher gelesen (secureGet) bzw. es gibt
 *  keinen Alt-Bestand. secureSet erzeugt bei fehlendem Key einen frischen — nach einem
 *  Geräte-Restore (Chiffretext da, Key weg) würde das den Altbestand unlesbar machen.
 *  Die App-Ladelogik garantiert die Reihenfolge (erst lesen, dann storageBlockedRef). */
export async function secureSet(key: string, value: string): Promise<void> {
  // Selbstschutz: existiert unter `key` bereits Chiffretext, aber kein Master-Key
  // (Geräte-Restore), darf KEIN frischer Key erzeugt werden — das würde den Altbestand
  // dauerhaft unlesbar machen. Die Invariante wird hier im Modul erzwungen, nicht nur im Caller.
  const existingHex = await AsyncStorage.getItem(key);
  if (existingHex && !(await readKey())) {
    throw new SecureStoreError(key);
  }
  const k = await masterKey();
  const nonce = Crypto.getRandomBytes(NONCE_BYTES);
  await AsyncStorage.setItem(key, encryptString(k, nonce, value, aadFor(key)));
}

/** Verschlüsselten Wert lesen. `null` = Schlüssel nicht vorhanden. Wirft
 *  `SecureStoreError`, wenn Chiffretext da ist, aber nicht entschlüsselbar
 *  (Key weg/korrupt) — der Caller kann das von „leer" unterscheiden. */
export async function secureGet(key: string): Promise<string | null> {
  const hex = await AsyncStorage.getItem(key);
  if (!hex) return null;
  const k = await readKey(); // read-only — erzeugt keinen Key
  if (!k) throw new SecureStoreError(key); // Chiffretext da, aber Key fehlt (Restore ohne Key)
  try {
    return decryptString(k, hex, aadFor(key));
  } catch {
    throw new SecureStoreError(key);
  }
}
