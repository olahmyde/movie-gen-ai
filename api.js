// The one seam between the screen and the GPU server (server/app.py).
// Served from the pod, every call goes to the real server. Opened anywhere else
// (your own computer), it runs in demo mode with placeholder results.

const api = (() => {
  // ?live forces the real server elsewhere (testing server/app.py locally); it sticks for the tab.
  let forced = false;
  try {
    if (new URLSearchParams(location.search).has("live")) sessionStorage.setItem("moviegen:live", "1");
    forced = sessionStorage.getItem("moviegen:live") === "1";
  } catch {}
  const demo = !location.hostname.endsWith(".proxy.runpod.net") && !forced;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const SESSION = "moviegen:session"; // a routing hint only; the server's cookie is the real check

  async function call(path, body, method) {
    const r = await fetch(path, body === undefined ? { method: method || "GET", credentials: "same-origin" } : {
      method: method || "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    if (r.status === 401 && !path.endsWith("/login")) {
      try { sessionStorage.removeItem(SESSION); } catch {}
      location.replace("login.html");
    }
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.detail || `The server answered ${r.status}.`);
    return data;
  }

  // Waits for a GPU job (clip or portrait) and returns its file's URL.
  async function poll(id, onProgress = () => {}, every = 3000) {
    for (;;) {
      await wait(every);
      const j = await call(`/api/clip/${id}`);
      onProgress(j.progress);
      if (j.state === "done") return j.url;
      if (j.state === "error") throw new Error(j.error);
    }
  }

  const real = {
    async signIn(email, password) {
      if (!email || !password) throw new Error("Enter your email and password.");
      await call("/api/login", { email, password });
      try { sessionStorage.setItem(SESSION, email); } catch {}
    },
    signOut() { try { sessionStorage.removeItem(SESSION); } catch {} call("/api/logout", {}).catch(() => {}); },
    gpuStatus: () => call("/api/gpu"),
    async gpuStart() { return call("/api/gpu"); }, // if this page loads, the pod is already running
    async gpuStop() { await call("/api/gpu/stop", {}); return { state: "stopped" }; },
    listVoices: () => call("/api/voices"),
    voiceSample: async (voice) => (await call("/api/voice/sample", { voice })).url,
    async cloneVoice(form) { // form: FormData with file, name, gender, age, consent
      const r = await fetch("/api/voices/clone", { method: "POST", credentials: "same-origin", body: form });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.detail || `The server answered ${r.status}.`);
      return data.id;
    },
    listFilms: async () => (await call("/api/films")).films,
    saveFilm: (f) => call(`/api/films/${f.id}`, f, "PUT"),
    deleteFilm: (id) => call(`/api/films/${id}`, undefined, "DELETE"),
    writeScript: (o) => call("/api/script", o),
    makeVoices: (scene, cast) => call("/api/voice", { lines: scene.lines, cast }),
    // extra: { quality, cast, voiceUrl, portraitUrl }; with a voice and a face the server lip-syncs the clip
    async makeClip(scene, onProgress, look, extra = {}) {
      const { id } = await call("/api/clip", { shot: scene.shot, look, seconds: scene.dur, ...extra });
      return { url: await poll(id, onProgress) };
    },
    async makePortrait(name, look, filmLook, onProgress) {
      const { id } = await call("/api/portrait", { name, look, filmLook });
      return poll(id, onProgress, 1500);
    },
    async uploadPortrait(file) {
      const form = new FormData();
      form.append("file", file);
      const r = await fetch("/api/portrait/upload", { method: "POST", credentials: "same-origin", body: form });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.detail || `The server answered ${r.status}.`);
      return data.url;
    },
    buildMovie: (film) => call("/api/movie", { scenes: film.scenes.map((s) => ({ clipUrl: s.clipUrl, voiceUrl: s.voiceUrl })) }),
  };

  let gpu = { state: "stopped", ratePerHour: 0.89, startedAt: null };
  function splitScenes(seconds) {
    const n = Math.max(2, Math.ceil(seconds / 5));
    return Array.from({ length: n }, () => Math.max(2, Math.round(seconds / n)));
  }
  const mock = {
    async signIn(email, password) {
      await wait(700);
      if (!email || !password) throw new Error("Enter your email and password.");
      try { sessionStorage.setItem(SESSION, email); } catch {}
    },
    signOut() { try { sessionStorage.removeItem(SESSION); } catch {} },
    async listVoices() {
      const v = [["kokoro:af_heart", "Heart", "woman", "adult", "American"], ["kokoro:af_sky", "Sky", "woman", "young", "American"],
        ["kokoro:am_michael", "Michael", "man", "adult", "American"], ["kokoro:am_santa", "Santa", "man", "older", "American"],
        ["kokoro:bf_emma", "Emma", "woman", "adult", "British"], ["kokoro:bm_george", "George", "man", "older", "British"],
        ["cb:default", "Chatterbox", "woman", "adult", "American"]];
      return { voices: v.map(([id, name, gender, age, accent]) => ({ id, name, gender, age, accent, engine: id.startsWith("cb") ? "Chatterbox" : "Kokoro" })),
        default: ["kokoro:af_heart", "kokoro:am_michael", "kokoro:bf_emma", "kokoro:bm_george"] };
    },
    async voiceSample() { return null; }, // demo: the browser's own speech stands in
    async cloneVoice() { throw new Error("Cloning needs the GPU server; it isn't available in demo mode."); },
    // Demo films live in this browser only; on the pod they're saved on the server for everyone.
    async listFilms() { try { return JSON.parse(localStorage.getItem("moviegen:demo-films")) || []; } catch { return []; } },
    async saveFilm(f) {
      const all = (await this.listFilms()).filter((x) => x.id !== f.id);
      const updatedAt = Date.now();
      try { localStorage.setItem("moviegen:demo-films", JSON.stringify([{ ...f, updatedAt }, ...all])); } catch {}
      return { updatedAt };
    },
    async deleteFilm(id) {
      try { localStorage.setItem("moviegen:demo-films", JSON.stringify((await this.listFilms()).filter((x) => x.id !== id))); } catch {}
    },
    async gpuStatus() { return { ...gpu }; },
    async gpuStart() { gpu.state = "starting"; await wait(2500); gpu = { ...gpu, state: "running", startedAt: Date.now() }; return { ...gpu }; },
    async gpuStop() { await wait(600); gpu = { ...gpu, state: "stopped", startedAt: null }; return { ...gpu }; },
    async writeScript({ idea, seconds, look }) {
      await wait(1800);
      const cast = [{ name: "Ada", voice: "kokoro:af_heart" }, { name: "Marcus", voice: "kokoro:am_michael" }];
      const beats = ["Arrival", "Recognition", "The old question", "What changed", "The offer", "Silence", "The answer", "Turning away", "Second thought", "Last light"];
      let t = 0;
      const scenes = splitScenes(seconds).map((dur, i) => {
        const s = { id: crypto.randomUUID(), title: beats[i % beats.length], start: t, dur, shot: `${look}. ${idea.slice(0, 120)}`, lines: [
          { who: cast[i % 2].name, text: i === 0 ? "I wasn't sure you'd come." : "Placeholder line, written by the model once the GPU is connected." },
        ] };
        t += dur;
        return s;
      });
      const words = idea.split(/[.!?]/)[0].split(" ").slice(0, 6);
      while (words.length > 1 && /^(a|an|the|of|to|and|her|his)$/i.test(words.at(-1))) words.pop();
      return { title: words.join(" ") || "Untitled film", cast, scenes };
    },
    async makeVoices() { await wait(1200); return { url: null }; },
    async makeClip(scene, onProgress) {
      for (let i = 1; i <= 12; i++) { await wait(350); onProgress(i / 12); }
      if (Math.random() < 0.1) throw new Error("The GPU ran out of memory on this shot. Try again, or shorten it.");
      return { url: null };
    },
    async buildMovie() { await wait(1500); return { url: null }; },
    async makePortrait() { await wait(1500); return null; },
    async uploadPortrait(file) { return URL.createObjectURL(file); }, // demo: shown in this browser only
  };

  return {
    demo,

    session() { try { return sessionStorage.getItem(SESSION); } catch { return null; } },
    ...(demo ? mock : real),
  };
})();
