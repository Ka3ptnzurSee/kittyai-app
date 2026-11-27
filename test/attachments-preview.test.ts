// Bilder im Chat (26.11.2026): Vorschau muss auch nach Reload stehen — der Server
// liefert die Anhänge mit dauerhafter URL, lokal hängt die flüchtige file://-URI.
import { test } from "node:test";
import assert from "node:assert";
import { preferServerAttachments } from "../lib.ts";

const resolve = (list: unknown[]) => list as { kind: string; url?: string }[];

test("Server-Anhänge ersetzen die flüchtige file://-URI in Reihenfolge", () => {
  const local = [
    { role: "user", text: "Bild", attachments: [{ kind: "image", url: "file:///Caches/a.jpg" }] },
    { role: "assistant", text: "Antwort" },
    { role: "user", text: "noch eins", attachments: [{ kind: "image", url: "file:///Caches/b.jpg" }] },
  ];
  const server = [
    { role: "user", attachments: [{ kind: "image", url: "https://x/generated/chat/a.jpg" }] },
    { role: "assistant" },
    { role: "user", attachments: [{ kind: "image", url: "https://x/generated/chat/b.jpg" }] },
  ];
  const out = preferServerAttachments(local, server, resolve);
  assert.equal((out[0].attachments as { url?: string }[])[0].url, "https://x/generated/chat/a.jpg");
  assert.equal((out[2].attachments as { url?: string }[])[0].url, "https://x/generated/chat/b.jpg");
  assert.equal(out[1].role, "assistant");
});

test("ohne Server-Anhänge bleibt lokal alles wie es ist", () => {
  const local = [{ role: "user", attachments: [{ kind: "image", url: "file:///a.jpg" }] }];
  const out = preferServerAttachments(local, [{ role: "user", text: "Bild" }], resolve);
  assert.deepEqual(out, local);
});

test("mehr lokale Bild-Blasen als Server-Anhänge: Rest bleibt unangetastet", () => {
  const local = [
    { role: "user", attachments: [{ kind: "image", url: "file:///a.jpg" }] },
    { role: "user", attachments: [{ kind: "image", url: "file:///b.jpg" }] },
  ];
  const server = [{ role: "user", attachments: [{ kind: "image", url: "https://x/1.jpg" }] }];
  const out = preferServerAttachments(local, server, resolve);
  assert.equal((out[0].attachments as { url?: string }[])[0].url, "https://x/1.jpg");
  assert.equal((out[1].attachments as { url?: string }[])[0].url, "file:///b.jpg");
});
