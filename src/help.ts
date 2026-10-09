/** Usage text shown by `/mic help` and `/sound help` (TUI dialog / server log). */

export const MIC_HELP = [
  "Microphone commands:",
  "",
  "/mic          Start or stop recording (toggle)",
  "/mic start    Start recording (begin, gravar)",
  "/mic send     Stop, transcribe and send (submit, enviar)",
  "/mic abort    Cancel the recording (cancel, parar)",
  "/mic off      Cancel and discard (same as abort)",
  "/mic status   Show recorder state and backend",
  "/mic help     Show this help",
  "",
  "The transcript opens in an editable dialog before sending; set OPENCODE_VOICE_SUBMIT=send to send directly.",
].join("\n")

export const SOUND_HELP = [
  "Speech commands:",
  "",
  "/sound        Toggle speech on/off",
  "/sound on     Enable speech (start, ligar)",
  "/sound off    Disable speech and stop speaking (stop, desligar)",
  "/sound pause  Silence now, keep speech on (silence, calar)",
  "/sound status Show switch, engine, voices and limits",
  "/sound help   Show this help",
  "",
  "Speech reads the main agent's replies; enable the agent's reasoning with OPENCODE_VOICE_TTS_REASONING=1. Configure voices and the API with /mic-setup.",
].join("\n")
