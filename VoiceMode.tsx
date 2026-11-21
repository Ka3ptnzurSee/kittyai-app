/**
 * VoiceMode.tsx - Sprache-zu-Sprache-Modus (Freisprechen) fuer die KittyAI-App.
 *
 * Ablauf: Mikrofon hoert zu -> Stille beendet den Satz -> der Text geht durch den
 * NORMALEN Chat (send() in App.tsx, also gleiche Tools/Modelle/Plugins wie tippen)
 * -> waehrend die Antwort streamt, wird sie satzweise vorgelesen.
 *
 * Stimme: /api/voice/tts erkennt die Sprache und nimmt fuer Englisch Kittys
 * geklonte Stimme (PocketTTS, ~1-2 s pro Satz), fuer Deutsch Edge-Neural.
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import { Animated, Easing, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useAudioPlayer, useAudioPlayerStatus } from "expo-audio";
import { File, Paths } from "expo-file-system";
import { ExpoSpeechRecognitionModule, useSpeechRecognitionEvent } from "expo-speech-recognition";
import { takeSentences, voiceHooks } from "./voice";

type Phase = "hoeren" | "denkt" | "spricht" | "pause";

export type VoiceModeProps = {
  visible: boolean;
  serverUrl: string;
  authHeaders: () => Record<string, string>;
  busy: boolean;
  colors: {
    accent: string;
    text: string;
    muted: string;
    surface: string;
    surface2?: string;
    border: string;
    background?: string;
  };
  onSend: (text: string, voice?: boolean) => void;
  onInterrupt: () => void;
  onClose: () => void;
  language?: string;
};

const SILENCE_MS = 1800;   // so lange muss es still sein, damit der Satz als fertig gilt
const RESTART_MS = 350;    // kleine Pause, bevor das Mikro wieder aufgeht
const FINAL_GRACE_MS = 1200; // nach stop() so lange auf das FINALE Ergebnis warten

export default function VoiceMode(props: VoiceModeProps) {
  const { visible, serverUrl, authHeaders, busy, colors, onSend, onInterrupt, onClose } = props;
  const language = props.language || "de-DE";

  const player = useAudioPlayer();
  const status = useAudioPlayerStatus(player);

  const [phase, setPhase] = useState<Phase>("hoeren");
  const [transcript, setTranscript] = useState("");
  const [answer, setAnswer] = useState("");
  const [engine, setEngine] = useState("");
  const [metrics, setMetrics] = useState("");
  const [error, setError] = useState("");
  const [handsfree, setHandsfree] = useState(true);

  const phaseRef = useRef<Phase>("hoeren");
  const visibleRef = useRef(visible);
  const busyRef = useRef(busy);
  const queueRef = useRef<string[]>([]);
  const bufferRef = useRef("");
  const answerRef = useRef("");
  const transcriptRef = useRef("");
  const finalSegmentsRef = useRef(""); // finale Segmente werden angehängt (iOS liefert segmentweise)
  const interimRef = useRef("");       // laufendes Teil-Ergebnis, nur für die Anzeige
  const sentRef = useRef(false);
  const playingRef = useRef(false);
  const wasPlayingRef = useRef(false);
  const handsfreeRef = useRef(true);
  const silenceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const restartRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const watchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // true, sobald stop() angefordert wurde: dann kein neues Stille-Fenster mehr
  // aufziehen, sondern auf das finale Ergebnis (end-Event) warten.
  const stoppingRef = useRef(false);
  // Zeitpunkt des letzten start()-Aufrufs. iOS liefert in "end"/"result" KEINE
  // Session-ID — ein Nachzügler-`end` der alten Session würde sonst die gerade
  // frisch gestartete Aufnahme per stop() killen.
  const startedAtRef = useRef(0);
  // Zaehler fuer fehlgeschlagene start()-Versuche (Deckel gegen Endlosschleife).
  const startFailsRef = useRef(0);
  // Zaehler fuer Sessions, die sofort (< 600 ms) wieder enden. Ohne Deckel
  // entstuende ein start->end->start-Karussell (Dauer-Mikro, Akku).
  const earlyEndsRef = useRef(0);
  // Latch gegen parallele start()-Aufrufe zweier Timer (await der Permission).
  const startingRef = useRef(false);
  const startingAtRef = useRef(0);
  // true = eine Session ist gerade offen (zwischen start() und end/stop). Schuetzt
  // vor einem zweiten start() in eine laufende Session (doppelte Erkennung).
  const listeningRef = useRef(false);
  // true = wir haben ein stop() angefordert und warten auf dessen end-Event.
  // Jedes stop() erzeugt genau ein end — damit lassen sich Nachzuegler zuordnen.
  const stopPendingRef = useRef(false);
  // true = Events der gerade gestoppten Session verwerfen (Abbruch/Schliessen).
  // Ohne das fuellt das von stop() ausgeloeste Final-`result` die Refs wieder und
  // der end-Handler schickt das abgebrochene Fragment doch noch ab.
  const suppressRef = useRef(false);
  const turnStartRef = useRef(0);
  const firstAudioRef = useRef(0);

  useEffect(() => { phaseRef.current = phase; }, [phase]);
  useEffect(() => { visibleRef.current = visible; }, [visible]);
  useEffect(() => { busyRef.current = busy; }, [busy]);
  useEffect(() => { handsfreeRef.current = handsfree; }, [handsfree]);

  const clearTimers = () => {
    if (silenceRef.current) { clearTimeout(silenceRef.current); silenceRef.current = null; }
    if (restartRef.current) { clearTimeout(restartRef.current); restartRef.current = null; }
    if (watchdogRef.current) { clearTimeout(watchdogRef.current); watchdogRef.current = null; }
  };

  /** MP3 fuer einen Satz holen (Server waehlt Klon- oder Edge-Stimme). */
  const synth = useCallback(async (text: string): Promise<string> => {
    const base = serverUrl.replace(/\/+$/, "");
    const res = await fetch(base + "/api/voice/tts", {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) throw new Error("TTS HTTP " + res.status);
    const data = (await res.json()) as { audioBase64?: string; engine?: string; language?: string; error?: string };
    if (!data.audioBase64) throw new Error(data.error || "keine Audiodaten");
    setEngine([data.engine, data.language].filter(Boolean).join(" / "));
    const file = new File(Paths.cache, "vm-" + Date.now() + "-" + Math.random().toString(36).slice(2, 7) + ".mp3");
    file.create({ overwrite: true, intermediates: true });
    await file.write(data.audioBase64, { encoding: "base64" });
    return file.uri;
  }, [serverUrl, authHeaders]);

  /** Naechsten Satz abspielen; Queue wird waehrend des Sprechens gefuellt. */
  const pump = useCallback(async () => {
    if (playingRef.current || !visibleRef.current) return;
    const next = queueRef.current.shift();
    if (!next) {
      if (!busyRef.current) {
        setPhase("pause");
        if (handsfree) {
          if (restartRef.current) clearTimeout(restartRef.current);
          restartRef.current = setTimeout(() => { restartRef.current = null; startListening(); }, RESTART_MS);
        }
      }
      return;
    }
    playingRef.current = true;
    setPhase("spricht");
    try {
      const uri = await synth(next);
      if (!firstAudioRef.current) firstAudioRef.current = Date.now();
      player.replace({ uri });
      player.play();
    } catch (e) {
      playingRef.current = false;
      setError(e instanceof Error ? e.message : String(e));
      pump();
    }
  }, [player, synth, handsfree]);

  const enqueue = useCallback((sentences: string[]) => {
    if (!sentences.length) return;
    for (const s of sentences) queueRef.current.push(s);
    pump();
  }, [pump]);

  /** Mikrofon oeffnen. */
  const startListening = useCallback(async () => {
    if (!visibleRef.current) return;
    // Es laeuft schon eine Session (Timer-Rennen): nicht ein zweites start()
    // in dieselbe Session schicken — das erzeugt doppelte Erkennung.
    if (listeningRef.current && !stopPendingRef.current) return;
    // Zwei Timer (Stille-Neustart, Nachzuegler-end) koennen hier gleichzeitig
    // landen; das await der Permission oeffnet ein Wettfenster -> Latch.
    if (startingRef.current && Date.now() - startingAtRef.current < 5000) return;
    startingRef.current = true;
    startingAtRef.current = Date.now();
    try {
      const perm = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
      if (!perm.granted) {
        setError("Mikrofon/Spracherkennung nicht erlaubt (iOS-Einstellungen → KittyAI).");
        return;
      }
      // Waehrend des await kann das Overlay geschlossen worden sein -> sonst
      // liefe das Mikro unsichtbar weiter.
      if (!visibleRef.current) return;
      sentRef.current = false;
      stoppingRef.current = false;
      suppressRef.current = false;
      if (watchdogRef.current) { clearTimeout(watchdogRef.current); watchdogRef.current = null; }
      // Stille-Timer der vorigen Session darf die neue Aufnahme nicht stoppen.
      if (silenceRef.current) { clearTimeout(silenceRef.current); silenceRef.current = null; }
      transcriptRef.current = "";
      finalSegmentsRef.current = "";
      interimRef.current = "";
      setTranscript("");
      setPhase("hoeren");
      startedAtRef.current = Date.now();
      ExpoSpeechRecognitionModule.start({
        lang: language,
        interimResults: true,
        continuous: true,
        addsPunctuation: true,
        iosTaskHint: "dictation",
      });
      // Erst NACH erfolgreichem start() zuruecksetzen — sonst wuerde der Retry-Deckel
      // bei jedem Fehlversuch wieder auf 0 springen (Endlosschleife).
      startFailsRef.current = 0;
      listeningRef.current = true;
      stopPendingRef.current = false;
    } catch (e) {
      setError("Spracherkennung: " + (e instanceof Error ? e.message : String(e)));
      // Nicht stumm bleiben: start() scheitert z. B. am noch laufenden Shutdown
      // des Moduls. Nach 800 ms erneut versuchen, aber nicht endlos.
      if (startFailsRef.current < 5 && visibleRef.current) {
        startFailsRef.current += 1;
        if (restartRef.current) clearTimeout(restartRef.current);
        restartRef.current = setTimeout(() => { restartRef.current = null; startListening(); }, 800);
      }
    } finally {
      startingRef.current = false;
    }
  }, [language]);

  /** Mikro wieder aufmachen, damit man ohne Tap weiterreden kann (Freihändig). */
  const reopenMic = useCallback((delay: number = RESTART_MS) => {
    if (!handsfreeRef.current || !visibleRef.current) return;
    if (restartRef.current) clearTimeout(restartRef.current);
    restartRef.current = setTimeout(() => { restartRef.current = null; startListening(); }, delay);
  }, [startListening]);

  /**
   * Satz abschicken (ueber den normalen Chat).
   * Gesendet wird AUSSCHLIESSLICH der finale Text (finalSegmentsRef); das laufende
   * Interim-Fragment dient nur als Notanker, wenn iOS gar kein Final geliefert hat.
   * Grund: ein halbes Interim-Fragment wurde bisher als Nachricht abgeschickt.
   */
  const finishUtterance = useCallback(() => {
    stoppingRef.current = false;
    if (sentRef.current) return;
    if (watchdogRef.current) { clearTimeout(watchdogRef.current); watchdogRef.current = null; }
    // Ein noch laufender Stille-Timer würde später die naechste Aufnahme stoppen.
    if (silenceRef.current) { clearTimeout(silenceRef.current); silenceRef.current = null; }
    const finalText = finalSegmentsRef.current.trim();
    const interimText = interimRef.current.trim();
    const text = finalText || interimText;
    finalSegmentsRef.current = "";
    interimRef.current = "";
    stopPendingRef.current = true;
    listeningRef.current = false;
    try { ExpoSpeechRecognitionModule.stop(); } catch { /* schon aus */ }
    // Zu kurz oder nur Satzzeichen ("...", "?"): nichts senden, sondern wieder
    // aufnehmen — sonst entstehen leere Runden im Chat.
    const meaningful = text.replace(/[^\p{L}\p{N}]+/gu, "");
    if (meaningful.length < 2) {
      sentRef.current = false;
      transcriptRef.current = "";
      setTranscript("");
      setPhase("hoeren");
      if (restartRef.current) clearTimeout(restartRef.current);
      // 800 ms: erst wenn das Shutdown der Erkennung durch ist, sonst scheitert
      // start() am noch laufenden Modul und der Modus bliebe stumm.
      restartRef.current = setTimeout(() => { restartRef.current = null; startListening(); }, 800);
      return;
    }
    sentRef.current = true;
    turnStartRef.current = Date.now();
    firstAudioRef.current = 0;
    bufferRef.current = "";
    answerRef.current = "";
    queueRef.current = [];
    setAnswer("");
    setError("");
    setMetrics("");
    setPhase("denkt");
    onSend(text, true);
  }, [onSend, startListening]);

  /**
   * Stille erkannt -> NICHT direkt senden, sondern die Erkennung stoppen und dem
   * Geraet Zeit geben, sein FINALES Ergebnis zu liefern (end-Event / Watchdog).
   */
  const armSilence = useCallback(() => {
    if (stoppingRef.current) return;
    if (silenceRef.current) clearTimeout(silenceRef.current);
    silenceRef.current = setTimeout(() => {
      silenceRef.current = null;
      stoppingRef.current = true;
      stopPendingRef.current = true;
      try { ExpoSpeechRecognitionModule.stop(); } catch { /* schon aus */ }
      if (watchdogRef.current) clearTimeout(watchdogRef.current);
      watchdogRef.current = setTimeout(() => {
        watchdogRef.current = null;
        // Nur solange wir noch auf das Final warten — nach einem Neustart nicht
        // mehr den Text der naechsten Aeusserung abschicken.
        if (stoppingRef.current && !sentRef.current && visibleRef.current) finishUtterance();
      }, FINAL_GRACE_MS);
    }, SILENCE_MS);
  }, [finishUtterance]);

  // --- Spracherkennung -----------------------------------------------------
  useSpeechRecognitionEvent("result", (event) => {
    // Events einer bewusst gestoppten Session (Abbruch/Schliessen) verwerfen.
    if (suppressRef.current) return;
    // event.results sind Alternativen (results[0] = beste). iOS liefert Finals
    // segmentweise und prependet ab dem 2. Segment ein Leerzeichen -> anhängen
    // statt überschreiben, sonst bleibt nur das letzte Fragment übrig.
    const t = (event.results?.[0]?.transcript ?? "").trim();
    if (!t) return;
    earlyEndsRef.current = 0; // Session liefert Sprache -> Karussell-Zaehler zuruecksetzen
    if (event.isFinal) {
      finalSegmentsRef.current = finalSegmentsRef.current
        ? `${finalSegmentsRef.current} ${t}`
        : t;
      interimRef.current = "";
    } else if (!stoppingRef.current) {
      interimRef.current = t; // nur Anzeige, nie alleiniger Nachrichtentext
    }
    const shown = [finalSegmentsRef.current, interimRef.current].filter(Boolean).join(" ");
    transcriptRef.current = shown;
    setTranscript(shown);
    armSilence();
  });
  useSpeechRecognitionEvent("end", () => {
    if (suppressRef.current) return;
    // Buchhaltung: Session ist zu; gehoert dieses end zu unserem stop()?
    const fromOwnStop = stopPendingRef.current;
    stopPendingRef.current = false;
    listeningRef.current = false;
    // Unerwartetes end direkt nach einem start() (kein eigenes stop()) => Nachzuegler
    // der vorherigen Session (iOS liefert keine Session-ID). Nicht senden, aber auf
    // jeden Fall dafuer sorgen, dass wieder zugehoert wird — nie stumm bleiben.
    if (!fromOwnStop && Date.now() - startedAtRef.current < 600) {
      if (!restartRef.current && !sentRef.current && visibleRef.current) {
        if (earlyEndsRef.current < 5) {
          earlyEndsRef.current += 1;
          restartRef.current = setTimeout(() => { restartRef.current = null; startListening(); }, 800);
        } else {
          setError("Spracherkennung startet nicht — bitte Modus neu öffnen.");
        }
      }
      return;
    }
    // Der EINZIGE Sende-Pfad: nach stop() (Stille) oder wenn iOS die Session
    // selbst beendet. Hier liegt das finale Ergebnis vor.
    if (!sentRef.current && visibleRef.current && phaseRef.current === "hoeren") finishUtterance();
  });
  useSpeechRecognitionEvent("error", (event) => {
    if (event.error === "no-speech" || event.error === "aborted") return;
    setError("Spracherkennung: " + (event.message || event.error || "unbekannt"));
  });

  // --- Antwort-Stream mitlesen --------------------------------------------
  useEffect(() => {
    voiceHooks.delta = (delta: string) => {
      if (!visibleRef.current) return;
      bufferRef.current += delta;
      answerRef.current = (answerRef.current + delta).slice(-4000);
      setAnswer(answerRef.current);
      const { sentences, rest } = takeSentences(bufferRef.current);
      bufferRef.current = rest;
      enqueue(sentences);
    };
    voiceHooks.done = (full: string) => {
      if (!visibleRef.current) return;
      const { sentences, rest } = takeSentences(bufferRef.current, true);
      bufferRef.current = rest;
      enqueue(sentences);
      const took = Date.now() - turnStartRef.current;
      const firstAudio = firstAudioRef.current ? firstAudioRef.current - turnStartRef.current : null;
      setMetrics(
        (full ? full.length + " Zeichen · " : "") + (took / 1000).toFixed(1) + " s Antwort" +
        (firstAudio ? " · " + (firstAudio / 1000).toFixed(1) + " s bis Stimme" : ""),
      );
      // Nichts vorzulesen (leere Antwort) -> sonst bliebe der Modus stumm in
      // "denkt" stehen. Mikro wieder aufmachen, damit man weiterreden kann.
      if (!sentences.length && !queueRef.current.length && !playingRef.current) {
        sentRef.current = false;
        setPhase(handsfreeRef.current ? "hoeren" : "pause");
        reopenMic(600);
      }
    };
    // Turn fehlgeschlagen: Hinweis sichtbar machen (vorhandenes Fehlerfeld) und
    // wieder zuhören, statt stumm in der Denk-Phase zu bleiben.
    voiceHooks.error = (msg: string) => {
      if (!visibleRef.current) return;
      // Laufende Sprachausgabe stoppen und Puffer verwerfen: sonst hoert das gleich
      // wieder geoeffnete Mikro die eigene TTS, und Resttext der alten Antwort
      // wuerde in den naechsten Turn rutschen.
      queueRef.current = [];
      bufferRef.current = "";
      playingRef.current = false;
      try { player.pause(); } catch { /* aus */ }
      setError(msg || "Keine Antwort vom Server - bitte nochmal.");
      sentRef.current = false;
      setPhase(handsfreeRef.current ? "hoeren" : "pause");
      reopenMic(600);
    };
    return () => {
      voiceHooks.delta = undefined;
      voiceHooks.done = undefined;
      voiceHooks.error = undefined;
    };
  }, [enqueue, reopenMic, player]);

  // --- Wiedergabe-Ende -> naechster Satz ----------------------------------
  useEffect(() => {
    if (wasPlayingRef.current && !status.playing && status.didJustFinish) {
      playingRef.current = false;
      pump();
    }
    wasPlayingRef.current = status.playing;
  }, [status.playing, status.didJustFinish, pump]);

  // --- Ein/Aus -------------------------------------------------------------
  useEffect(() => {
    if (!visible) {
      clearTimers();
      queueRef.current = [];
      bufferRef.current = "";
      playingRef.current = false;
      suppressRef.current = true; // Events der schliessenden Session verwerfen
      listeningRef.current = false;
      stopPendingRef.current = false;
      try { ExpoSpeechRecognitionModule.stop(); } catch { /* aus */ }
      try { player.pause(); } catch { /* aus */ }
      return;
    }
    // Frisches Oeffnen: Zaehler zuruecksetzen, sonst traegt der Deckel aus einer
    // frueheren Sitzung in diese hinein.
    earlyEndsRef.current = 0;
    startFailsRef.current = 0;
    suppressRef.current = false;
    startListening();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  // --- Unterbrechen: Stimme stoppen, Chat abbrechen, wieder zuhoeren -------
  const interrupt = useCallback(() => {
    clearTimers();
    queueRef.current = [];
    bufferRef.current = "";
    playingRef.current = false;
    try { player.pause(); } catch { /* aus */ }
    // Resttext verwerfen, BEVOR stop() das end-Event auslöst: sonst würde das
    // abgebrochene Fragment doch noch abgeschickt.
    finalSegmentsRef.current = "";
    interimRef.current = "";
    transcriptRef.current = "";
    setTranscript("");
    suppressRef.current = true; // von stop() ausgeloestes Final-`result` verwerfen
    listeningRef.current = false;
    stopPendingRef.current = false;
    try { ExpoSpeechRecognitionModule.stop(); } catch { /* aus */ }
    onInterrupt();
    sentRef.current = false;
    setPhase("hoeren");
    if (restartRef.current) clearTimeout(restartRef.current);
    // 800 ms wie im uebrigen Code: start() direkt nach stop() scheitert am noch
    // laufenden Shutdown des Moduls (siehe Kommentar bei der Kurz-Text-Verwerfung).
    restartRef.current = setTimeout(() => { restartRef.current = null; startListening(); }, 800);
  }, [player, onInterrupt, startListening]);

  const orbPress = () => {
    if (phase === "hoeren") {
      finishUtterance();
    } else {
      interrupt();
    }
  };

  // Puls-Animation am Orb
  const pulse = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const active = phase === "hoeren" || phase === "spricht";
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: active ? 900 : 2000, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0, duration: active ? 900 : 2000, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      ]),
    );
    if (visible) loop.start();
    return () => loop.stop();
  }, [visible, phase, pulse]);

  if (!visible) return null;

  const label =
    phase === "hoeren" ? "Ich höre zu …"
    : phase === "denkt" ? "Kitty denkt …"
    : phase === "spricht" ? "Kitty spricht …"
    : "Tippen zum Weitersprechen";

  const scale = pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.12] });

  return (
    <View style={[styles.root, { backgroundColor: colors.background || colors.surface }]}>
      <View style={styles.topBar}>
        <Pressable onPress={onClose} style={styles.iconBtn} hitSlop={8} accessibilityLabel="Sprachmodus schließen">
          <Ionicons name="close" size={22} color={colors.text} />
        </Pressable>
        <Text style={[styles.topTitle, { color: colors.text }]}>Sprachmodus</Text>
        <Pressable
          onPress={() => setHandsfree((h) => !h)}
          style={styles.iconBtn}
          hitSlop={8}
          accessibilityLabel={handsfree ? "Freihändig: an" : "Freihändig: aus"}
        >
          <Ionicons name={handsfree ? "infinite" : "hand-left-outline"} size={20} color={handsfree ? colors.accent : colors.muted} />
        </Pressable>
      </View>

      <ScrollView contentContainerStyle={styles.body} showsVerticalScrollIndicator={false}>
        <Animated.View
          style={[
            styles.orb,
            {
              backgroundColor: phase === "spricht" ? colors.accent : (colors.surface2 || colors.surface),
              borderColor: colors.accent,
              transform: [{ scale }],
            },
          ]}
        >
          <Pressable onPress={orbPress} style={styles.orbHit} accessibilityLabel={label}>
            <Ionicons
              name={phase === "hoeren" ? "mic" : phase === "denkt" ? "ellipsis-horizontal" : phase === "spricht" ? "stop" : "mic-outline"}
              size={44}
              color={phase === "spricht" ? "#ffffff" : colors.accent}
            />
          </Pressable>
        </Animated.View>

        <Text style={[styles.phase, { color: colors.muted }]}>{label}</Text>

        {transcript ? (
          <Text style={[styles.transcript, { color: colors.text }]}>{transcript}</Text>
        ) : null}

        {answer ? (
          <Text style={[styles.answer, { color: colors.text }]} numberOfLines={12}>
            {answer}
          </Text>
        ) : null}

        <View style={styles.metaRow}>
          {engine ? <Text style={[styles.meta, { color: colors.muted }]}>{engine}</Text> : null}
          {metrics ? <Text style={[styles.meta, { color: colors.muted }]}>{metrics}</Text> : null}
        </View>

        {error ? <Text style={[styles.error, { color: "#e2574c" }]}>{error}</Text> : null}
      </ScrollView>

      <View style={styles.footer}>
        <Pressable onPress={interrupt} style={[styles.footerBtn, { borderColor: colors.border }]} accessibilityLabel="Unterbrechen">
          <Ionicons name="hand-left-outline" size={18} color={colors.text} />
          <Text style={[styles.footerText, { color: colors.text }]}>Unterbrechen</Text>
        </Pressable>
        <Pressable onPress={onClose} style={[styles.footerBtn, { borderColor: colors.border }]} accessibilityLabel="Sprachmodus beenden">
          <Ionicons name="chatbubble-ellipses-outline" size={18} color={colors.text} />
          <Text style={[styles.footerText, { color: colors.text }]}>Zum Text</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, zIndex: 50 },
  topBar: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 14, paddingTop: 8, paddingBottom: 4 },
  topTitle: { fontSize: 16, fontWeight: "700" },
  iconBtn: { padding: 8 },
  body: { flexGrow: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: 22, paddingVertical: 18, gap: 14 },
  orb: { width: 132, height: 132, borderRadius: 66, borderWidth: 2, alignItems: "center", justifyContent: "center" },
  orbHit: { width: 132, height: 132, borderRadius: 66, alignItems: "center", justifyContent: "center" },
  phase: { fontSize: 15, fontWeight: "600" },
  transcript: { fontSize: 17, textAlign: "center", lineHeight: 24 },
  answer: { fontSize: 15, textAlign: "center", lineHeight: 22, opacity: 0.9 },
  metaRow: { flexDirection: "row", gap: 10, flexWrap: "wrap", justifyContent: "center" },
  meta: { fontSize: 12 },
  error: { fontSize: 13, textAlign: "center" },
  footer: { flexDirection: "row", justifyContent: "center", gap: 12, paddingBottom: 26, paddingTop: 6 },
  footerBtn: { flexDirection: "row", alignItems: "center", gap: 7, borderWidth: 1, borderRadius: 999, paddingHorizontal: 16, paddingVertical: 10 },
  footerText: { fontSize: 14, fontWeight: "600" },
});

