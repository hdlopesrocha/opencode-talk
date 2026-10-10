<script setup>
import { ref } from "vue";

const REPO = "https://github.com/hdlopesrocha/opencode-talk";
const SITE = "https://hdlopesrocha.github.io/opencode-talk/";

const links = {
  repo: REPO,
  install: `${REPO}#install`,
  readme: `${REPO}#readme`,
  issues: `${REPO}/issues`,
  releases: `${REPO}/releases`,
  telegramSetup: `${REPO}/blob/main/docs/TELEGRAM_SETUP.md`,
  nostrSetup: `${REPO}/blob/main/docs/NOSTR_SETUP.md`,
  xmppSetup: `${REPO}/blob/main/docs/XMPP_SETUP.md`,
  api: `${REPO}/blob/main/docs/API.md`,
  pluginInstall: `${REPO}/blob/main/docs/PLUGIN_INSTALL.md`,
  opencode: "https://opencode.ai",
};

const activeChannel = ref("telegram");
const copied = ref(false);
const menuOpen = ref(false);

const installSnippet = `{ "$schema": "https://opencode.ai/config.json",
  "plugins": ["/path/to/opencode-talk"] }`;

function copyInstall() {
  navigator.clipboard?.writeText(installSnippet).then(
    () => {
      copied.value = true;
      setTimeout(() => (copied.value = false), 1600);
    },
    () => {},
  );
}

const voiceFeatures = [
  {
    icon: "🎙️",
    title: "Speech-to-text",
    body: "Press <leader>v or run /mic, speak, and the transcript becomes a prompt. Local faster-whisper by default — offline, private, no API key — or any OpenAI-compatible endpoint.",
  },
  {
    icon: "🔊",
    title: "Text-to-speech",
    body: "The main agent's replies are spoken aloud with neural edge-tts voices, automatic pt / en / fr detection, and a robotic spd-say fallback. Reasoning is opt-in.",
  },
  {
    icon: "✏️",
    title: "Editable send + polish",
    body: "/mic send opens an editable dialog so you can fix the transcript before sending. Optional polish step cleans it up with the model you already use.",
  },
  {
    icon: "📱",
    title: "Voice in Telegram",
    body: "Voice notes are transcribed and attached to the prompt; /talk sends agent replies back as spoken audio messages.",
  },
];

const channels = {
  telegram: {
    label: "Telegram",
    icon: "✈️",
    headline: "One group, one topic per session",
    points: [
      "Project/session menus: /menu, /projects, /sessions, /new, /use",
      "Model + reasoning switching: /models, /model <n|provider/model>",
      "In-place progress edits, agent photos, voice replies",
      "/telegram <bot-token> <group-id> registers the Opencode Talk forum group",
      "Creating a topic creates a session; renaming a session renames its topic",
      "Single-flight polling lock — safe with several OpenCode servers",
    ],
    cta: links.telegramSetup,
    ctaLabel: "Telegram setup guide",
  },
  xmpp: {
    label: "XMPP",
    icon: "💬",
    headline: "Same power over federated chat",
    points: [
      "Same commands as Telegram: /menu, /sessions, /models, /status, /abort",
      "/xmpp <jid> <password> [muc-room] connects the bot",
      "MUC room gets one thread per session",
      "Extra direct chats via /xmpp <contact-jid>",
      "/xmpp stop|start|talk|shut controls the bot",
    ],
    cta: links.xmppSetup,
    ctaLabel: "XMPP setup guide",
  },
  nostr: {
    label: "Nostr",
    icon: "🔑",
    headline: "Every session owns its own keypair",
    points: [
      "Pair with /nostr <your-npub>, get a welcome DM with model + reasoning",
      "Encrypted NIP-04 DMs drive the session from any Nostr client",
      "Scope projects, switch models, abort, receive agent images via Blossom",
      "/nostr off|on halts/resumes relay traffic",
    ],
    cta: links.nostrSetup,
    ctaLabel: "Nostr setup guide",
  },
};

const commands = [
  { cmd: "/mic", desc: "toggle record → transcribe → editable send (start|send|abort|off|status|help)" },
  { cmd: "/mic-setup", desc: "settings menu: backend, API key, TTS voices, speech toggles" },
  { cmd: "/sound", desc: "speak agent replies aloud (on|off|pause|status|help)" },
  { cmd: "/talk", desc: "list every command the plugin adds + send replies as voice in Telegram" },
  { cmd: "/sessions /new /use", desc: "list, create and switch sessions remotely" },
  { cmd: "/models /model", desc: "list and switch model + reasoning effort remotely" },
  { cmd: "/status /abort", desc: "inspect and stop the running turn" },
  { cmd: "/telegram /xmpp /nostr", desc: "pair and control each remote transport" },
];
</script>

<template>
  <div class="page">
    <header class="nav">
      <a class="brand" :href="SITE">
        <span class="brand-mark">◉</span>
        <span>opencode-talk</span>
      </a>
      <button class="nav-toggle" @click="menuOpen = !menuOpen" aria-label="Menu">☰</button>
      <nav class="nav-links" :class="{ open: menuOpen }">
        <a href="#voice">Voice</a>
        <a href="#remote">Remote</a>
        <a href="#how">How it works</a>
        <a href="#install">Install</a>
        <a href="#docs">Docs</a>
        <a class="btn btn-ghost" :href="links.repo" target="_blank" rel="noopener">★ GitHub</a>
      </nav>
    </header>

    <main>
      <!-- HERO -->
      <section class="hero">
        <div class="hero-inner">
          <p class="eyebrow">OpenCode plugin · voice + remote control</p>
          <h1>Talk to your agent.<br />Let it talk back.</h1>
          <p class="lede">
            <strong>opencode-talk</strong> gives
            <a :href="links.opencode" target="_blank" rel="noopener">OpenCode</a>
            two-way voice and full remote control: dictate prompts with
            <code>/mic</code>, hear replies aloud, and drive the same sessions
            from Telegram, XMPP, or any Nostr client.
          </p>
          <div class="cta-row">
            <a class="btn btn-primary" :href="links.repo" target="_blank" rel="noopener">
              View on GitHub →
            </a>
            <a class="btn" href="#install">Install the plugin</a>
            <a class="btn btn-ghost" :href="links.api" target="_blank" rel="noopener">Session API docs</a>
          </div>
          <div class="badges">
            <span class="badge">OpenCode v2</span>
            <span class="badge">offline STT</span>
            <span class="badge">neural TTS · pt/en/fr</span>
            <span class="badge">Telegram · XMPP · Nostr</span>
          </div>
          <pre class="terminal"><code><span class="p">$</span> opencode <span class="dim"># then press &lt;leader&gt;v and speak…</span>
<span class="ok">✔</span> transcript → editable dialog → session.prompt
<span class="ok">✔</span> agent reply → speakers (edge-tts, auto language)</code></pre>
        </div>
      </section>

      <!-- VOICE -->
      <section id="voice" class="section">
        <p class="kicker">Voice</p>
        <h2>Hands-free prompting, spoken answers</h2>
        <p class="sub">
          Local <code>faster-whisper</code> by default (private, no key), cloud
          transcription when you want speed, neural speech for every main-agent reply.
        </p>
        <div class="grid-4">
          <article v-for="f in voiceFeatures" :key="f.title" class="card">
            <div class="card-icon">{{ f.icon }}</div>
            <h3>{{ f.title }}</h3>
            <p v-html="f.body"></p>
          </article>
        </div>
        <div class="flow">
          <code>/mic → recorder (WAV) → speech-to-text → (edit) → session.prompt</code>
          <code>agent reply → text-to-speech (edge-tts) → speakers</code>
        </div>
      </section>

      <!-- REMOTE -->
      <section id="remote" class="section alt">
        <p class="kicker">Remote control</p>
        <h2>The same sessions, from your phone</h2>
        <p class="sub">
          An independent Session API (REST + SSE) plus a small OpenCode plugin.
          Voice and remote are independent halves — use either or both.
        </p>
        <div class="tabs">
          <button
            v-for="(c, key) in channels"
            :key="key"
            class="tab"
            :class="{ active: activeChannel === key }"
            @click="activeChannel = key"
          >
            {{ c.icon }} {{ c.label }}
          </button>
        </div>
        <div class="panel">
          <h3>{{ channels[activeChannel].headline }}</h3>
          <ul>
            <li v-for="p in channels[activeChannel].points" :key="p">{{ p }}</li>
          </ul>
          <a class="btn btn-small" :href="channels[activeChannel].cta" target="_blank" rel="noopener">
            {{ channels[activeChannel].ctaLabel }} →
          </a>
        </div>
        <div class="grid-3">
          <div class="mini-card">
            <h4>📡 Session API</h4>
            <p>REST + SSE over <code>@opencode/client</code>: session CRUD, message, abort, media store, fan-out.</p>
          </div>
          <div class="mini-card">
            <h4>🧩 Remote plugin</h4>
            <p>Typed RPC, compact progress events, <code>telegram_send_image</code> agent tool for screenshots &amp; charts.</p>
          </div>
          <div class="mini-card">
            <h4>⌨️ Any <code>/command</code></h4>
            <p>Forwarded to OpenCode as-is, so custom commands and skills work remotely too.</p>
          </div>
        </div>
      </section>

      <!-- HOW -->
      <section id="how" class="section">
        <p class="kicker">Commands</p>
        <h2>Everything you can say to it</h2>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Command</th><th>What it does</th></tr></thead>
            <tbody>
              <tr v-for="c in commands" :key="c.cmd">
                <td><code>{{ c.cmd }}</code></td>
                <td>{{ c.desc }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p class="hint">
          Full reference: <code>/talk help</code> inside OpenCode, or
          <a :href="links.readme" target="_blank" rel="noopener">the README on GitHub</a>.
        </p>
      </section>

      <!-- INSTALL -->
      <section id="install" class="section alt">
        <p class="kicker">Install</p>
        <h2>Running in under two minutes</h2>
        <div class="steps">
          <div class="step">
            <span class="step-n">1</span>
            <div>
              <h4>Clone the plugin</h4>
              <pre><code>git clone https://github.com/hdlopesrocha/opencode-talk.git
cd opencode-talk &amp;&amp; npm install  <span class="dim"># sets up .venv: edge-tts + faster-whisper</span></code></pre>
            </div>
          </div>
          <div class="step">
            <span class="step-n">2</span>
            <div>
              <h4>Register it <button class="copy" @click="copyInstall">{{ copied ? "✓ copied" : "⧉ copy" }}</button></h4>
              <p>in <code>~/.config/opencode/opencode.jsonc</code>:</p>
              <pre><code>{{ installSnippet }}</code></pre>
            </div>
          </div>
          <div class="step">
            <span class="step-n">3</span>
            <div>
              <h4>Restart &amp; talk</h4>
              <pre><code>opencode service restart
<span class="dim"># inside opencode: press &lt;leader&gt;v or run /mic</span></code></pre>
              <p>
                Needs OpenCode v2 plus one capture tool
                (<code>pw-record</code>, <code>parecord</code>, <code>arecord</code>, <code>sox</code> or <code>ffmpeg</code>).
              </p>
            </div>
          </div>
        </div>
        <div class="cta-row">
          <a class="btn btn-primary" :href="links.install" target="_blank" rel="noopener">Full install guide on GitHub →</a>
          <a class="btn" :href="links.releases" target="_blank" rel="noopener">Releases</a>
          <a class="btn btn-ghost" :href="links.issues" target="_blank" rel="noopener">Report an issue</a>
        </div>
      </section>

      <!-- DOCS -->
      <section id="docs" class="section">
        <p class="kicker">Docs</p>
        <h2>Go deeper</h2>
        <div class="grid-3">
          <a class="doc-card" :href="links.telegramSetup" target="_blank" rel="noopener">
            <h4>✈️ Telegram setup →</h4>
            <p>BotFather token, Opencode Talk forum group, topics-per-session, polling lock.</p>
          </a>
          <a class="doc-card" :href="links.xmppSetup" target="_blank" rel="noopener">
            <h4>💬 XMPP setup →</h4>
            <p>JID + password, MUC room registration, direct chats, bot controls.</p>
          </a>
          <a class="doc-card" :href="links.nostrSetup" target="_blank" rel="noopener">
            <h4>🔑 Nostr setup →</h4>
            <p>Relays, pairing with <code>/nostr &lt;npub&gt;</code>, encrypted DMs, Blossom images.</p>
          </a>
          <a class="doc-card" :href="links.api" target="_blank" rel="noopener">
            <h4>📡 Session API →</h4>
            <p>REST + SSE reference for building your own remote clients.</p>
          </a>
          <a class="doc-card" :href="links.pluginInstall" target="_blank" rel="noopener">
            <h4>🧩 Remote plugin install →</h4>
            <p>Installing the <code>telegram-bridge</code> half (RPC, progress events, image tool).</p>
          </a>
          <a class="doc-card" :href="links.readme" target="_blank" rel="noopener">
            <h4>📖 README →</h4>
            <p>Options, env overrides, troubleshooting, cloud STT examples, offline Piper TTS.</p>
          </a>
        </div>
      </section>
    </main>

    <footer class="footer">
      <p>
        <strong>opencode-talk</strong> — voice + remote control for
        <a :href="links.opencode" target="_blank" rel="noopener">OpenCode</a>.
      </p>
      <p class="dim">
        <a :href="links.repo" target="_blank" rel="noopener">GitHub</a> ·
        <a :href="links.install" target="_blank" rel="noopener">Install</a> ·
        <a :href="links.issues" target="_blank" rel="noopener">Issues</a> ·
        Built with Vue 3 + Vite, published to gh-pages.
      </p>
    </footer>
  </div>
</template>

<style scoped>
.page { min-height: 100vh; display: flex; flex-direction: column; }
.nav {
  position: sticky; top: 0; z-index: 10;
  display: flex; align-items: center; justify-content: space-between;
  padding: 0.7rem 1.4rem;
  background: rgba(10, 12, 20, 0.86); backdrop-filter: blur(10px);
  border-bottom: 1px solid #1e2433;
}
.brand { display: flex; gap: 0.5rem; align-items: center; font-weight: 800; font-size: 1.05rem; }
.brand-mark { color: #7dd3fc; }
.nav-links { display: flex; gap: 1rem; align-items: center; }
.nav-links a:not(.btn) { color: #b6bdd0; }
.nav-links a:not(.btn):hover { color: #fff; }
.nav-toggle { display: none; background: none; border: 1px solid #2a3348; border-radius: 8px; color: #fff; padding: 0.3rem 0.6rem; }
.hero {
  padding: 4.5rem 1.4rem 3rem;
  background:
    radial-gradient(700px 340px at 20% 0%, rgba(56, 189, 248, 0.16), transparent),
    radial-gradient(700px 340px at 85% 10%, rgba(167, 139, 250, 0.16), transparent);
}
.hero-inner { max-width: 920px; margin: 0 auto; text-align: center; }
.eyebrow { color: #7dd3fc; text-transform: uppercase; letter-spacing: 0.14em; font-size: 0.75rem; font-weight: 700; }
.hero h1 { font-size: clamp(2.2rem, 6vw, 3.8rem); line-height: 1.05; margin: 0.7rem 0 1rem; }
.lede { color: #b6bdd0; font-size: 1.12rem; max-width: 720px; margin: 0 auto 1.6rem; }
.cta-row { display: flex; gap: 0.7rem; justify-content: center; flex-wrap: wrap; margin-bottom: 1.2rem; }
.badges { display: flex; gap: 0.5rem; justify-content: center; flex-wrap: wrap; margin-bottom: 1.6rem; }
.badge { font-size: 0.75rem; border: 1px solid #2a3348; border-radius: 999px; padding: 0.25rem 0.7rem; color: #9fb0cc; background: #111624; }
.terminal {
  text-align: left; max-width: 640px; margin: 0 auto;
  background: #0b0f1a; border: 1px solid #1e2433; border-radius: 12px;
  padding: 1rem 1.2rem; font-size: 0.86rem; overflow-x: auto;
}
.p { color: #7dd3fc; } .dim { color: #64748b; } .ok { color: #4ade80; }
.section { max-width: 1080px; margin: 0 auto; padding: 3.5rem 1.4rem; width: 100%; }
.section.alt { background: #0d1220; border-top: 1px solid #161d30; border-bottom: 1px solid #161d30; max-width: none; }
.section.alt > * { max-width: 1080px; margin-left: auto; margin-right: auto; }
.kicker { color: #a78bfa; text-transform: uppercase; letter-spacing: 0.14em; font-size: 0.75rem; font-weight: 800; margin: 0; }
.section h2 { font-size: clamp(1.5rem, 4vw, 2.2rem); margin: 0.4rem 0 0.5rem; }
.sub { color: #9fb0cc; max-width: 760px; }
.grid-4 { display: grid; grid-template-columns: repeat(4, 1fr); gap: 0.9rem; margin-top: 1.6rem; }
.grid-3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 0.9rem; margin-top: 1.6rem; }
.card, .mini-card, .panel, .doc-card {
  background: #111624; border: 1px solid #1e2433; border-radius: 14px; padding: 1.1rem 1.15rem;
}
.card h3, .mini-card h4, .doc-card h4 { margin: 0.5rem 0; }
.card p, .mini-card p, .doc-card p { color: #9fb0cc; font-size: 0.92rem; }
.card-icon { font-size: 1.6rem; }
.doc-card { display: block; transition: border-color 0.15s, transform 0.15s; }
.doc-card:hover { border-color: #38bdf8; transform: translateY(-2px); }
.flow { display: grid; gap: 0.5rem; margin-top: 1.2rem; }
.flow code { background: #0b0f1a; border: 1px solid #1e2433; border-radius: 10px; padding: 0.7rem 1rem; font-size: 0.82rem; overflow-x: auto; }
.tabs { display: flex; gap: 0.6rem; margin: 1.4rem 0 1rem; flex-wrap: wrap; }
.tab { border: 1px solid #2a3348; background: #111624; color: #cbd5e1; border-radius: 999px; padding: 0.5rem 1.1rem; cursor: pointer; font-weight: 700; }
.tab.active { background: #38bdf8; border-color: #38bdf8; color: #06121f; }
.panel h3 { margin-top: 0; }
.panel ul { color: #b6bdd0; line-height: 1.7; }
.btn-small { display: inline-block; margin-top: 0.6rem; padding: 0.45rem 0.9rem; font-size: 0.85rem; }
.table-wrap { overflow-x: auto; margin-top: 1.4rem; border: 1px solid #1e2433; border-radius: 12px; }
table { width: 100%; border-collapse: collapse; font-size: 0.92rem; }
th, td { text-align: left; padding: 0.7rem 1rem; border-bottom: 1px solid #1a2133; }
th { background: #0d1322; color: #7dd3fc; font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.08em; }
td { color: #c3cadc; }
.hint { color: #8b95ad; }
.steps { display: grid; gap: 1rem; margin-top: 1.5rem; }
.step { display: flex; gap: 1rem; background: #111624; border: 1px solid #1e2433; border-radius: 14px; padding: 1.2rem; }
.step-n {
  flex: none; width: 2rem; height: 2rem; border-radius: 50%;
  background: #38bdf8; color: #06121f; font-weight: 800;
  display: flex; align-items: center; justify-content: center;
}
.step h4 { margin: 0 0 0.5rem; }
.step p { color: #9fb0cc; font-size: 0.9rem; }
pre { background: #0b0f1a; border: 1px solid #1e2433; border-radius: 10px; padding: 0.8rem 1rem; overflow-x: auto; font-size: 0.82rem; }
.copy { background: #1b2336; color: #7dd3fc; border: 1px solid #2a3348; border-radius: 8px; padding: 0.15rem 0.6rem; cursor: pointer; font-size: 0.78rem; }
.footer { text-align: center; padding: 2.2rem 1.4rem 3rem; color: #9fb0cc; border-top: 1px solid #1e2433; }
@media (max-width: 900px) {
  .grid-4, .grid-3 { grid-template-columns: 1fr; }
  .nav-toggle { display: block; }
  .nav-links { display: none; position: absolute; top: 100%; right: 0; left: 0; background: #0b0f1a; flex-direction: column; padding: 1rem; border-bottom: 1px solid #1e2433; }
  .nav-links.open { display: flex; }
}
</style>
