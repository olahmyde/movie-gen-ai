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
  const voices = ["Warm, low", "Bright, quick", "Older, gravel", "Soft, close"];
  const SESSION = "moviegen:session"; // a routing hint only; the server's cookie is the real check

  async function call(path, body) {
    const r = await fetch(path, body === undefined ? { credentials: "same-origin" } : {
      method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    if (r.status === 401 && !path.endsWith("/login")) {
      try { sessionStorage.removeItem(SESSION); } catch {}
      location.replace("login.html");
    }
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.detail || `The server answered ${r.status}.`);
    return data;
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
    writeScript: (o) => call("/api/script", o),
    makeVoices: (scene, cast) => call("/api/voice", { lines: scene.lines, cast }),
    async makeClip(scene, onProgress, look) {
      const { id } = await call("/api/clip", { shot: scene.shot, look, seconds: scene.dur });
      for (;;) {
        await wait(3000);
        const j = await call(`/api/clip/${id}`);
        onProgress(j.progress);
        if (j.state === "done") return { url: j.url };
        if (j.state === "error") throw new Error(j.error);
      }
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
    async gpuStatus() { return { ...gpu }; },
    async gpuStart() { gpu.state = "starting"; await wait(2500); gpu = { ...gpu, state: "running", startedAt: Date.now() }; return { ...gpu }; },
    async gpuStop() { await wait(600); gpu = { ...gpu, state: "stopped", startedAt: null }; return { ...gpu }; },
    async writeScript({ idea, seconds, look }) {
      await wait(1800);
      const cast = [{ name: "Ada", voice: voices[0] }, { name: "Marcus", voice: voices[2] }];
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
  };

  return {
    demo,
    voices,
    session() { try { return sessionStorage.getItem(SESSION); } catch { return null; } },
    ...(demo ? mock : real),
  };
})();
