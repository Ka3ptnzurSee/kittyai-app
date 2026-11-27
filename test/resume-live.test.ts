// Rückkehr in die App (26.11.2026): laufenden Turn live fortsetzen statt
// "Antwort wird geladen …" + Session-Polling.
import { test } from "node:test";
import assert from "node:assert";
import { shouldResumeLive } from "../lib.ts";

test("mit Anker, Bubble und Frage: live fortsetzen", () => {
  assert.equal(shouldResumeLive({ hasAnchorTurnId: "req-3-abc", hasAssistantBubble: true, hasUserMessage: true }), true);
});

test("ohne Anker (fremder App-Lauf) oder ohne Bubble: kein Resume", () => {
  assert.equal(shouldResumeLive({ hasAnchorTurnId: "", hasAssistantBubble: true, hasUserMessage: true }), false);
  assert.equal(shouldResumeLive({ hasAnchorTurnId: "   ", hasAssistantBubble: true, hasUserMessage: true }), false);
  assert.equal(shouldResumeLive({ hasAnchorTurnId: "x", hasAssistantBubble: false, hasUserMessage: true }), false);
  assert.equal(shouldResumeLive({ hasAnchorTurnId: "x", hasAssistantBubble: true, hasUserMessage: false }), false);
});

test("laufender Stream / schon laufender Resume / readOnly sperren den Resume", () => {
  const base = { hasAnchorTurnId: "x", hasAssistantBubble: true, hasUserMessage: true };
  assert.equal(shouldResumeLive({ ...base, hasActiveStream: true }), false);
  assert.equal(shouldResumeLive({ ...base, alreadyResuming: true }), false);
  assert.equal(shouldResumeLive({ ...base, readOnly: true }), false);
  assert.equal(shouldResumeLive(undefined as unknown as { hasAnchorTurnId?: string }), false);
});
