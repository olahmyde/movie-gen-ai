// The one seam between the screen and the GPU server.
// Today every call is a mock. When the RunPod server exists, swap each body for a fetch()
// to the same-named endpoint; the screen does not change.
//   POST /gpu/start, /gpu/stop        GET /gpu        -> { state, ratePerHour, startedAt }
//   POST /script  { idea, seconds, look }            -> { title, cast[], scenes[] }   (Ollama, Qwen3)
//   POST /voice   { lines[], cast[] }                -> { url }                      (Chatterbox / Dia)
//   POST /clip    { shot, look, voiceUrl, seconds }  -> job id, then GET /clip/:id   (ComfyUI, Wan 2.2)
//   POST /movie   { scenes[] }                       -> { url }                      (ffmpeg concat)
//   POST /login   { email, password }                -> sets an httpOnly session cookie; every route above checks it
// ponytail: mock only. The sign-in here is a placeholder; the server's password check is the real lock.

const api = (() => {
  const demo = true;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  let gpu = { state: "stopped", ratePerHour: 0.69, startedAt: null }; // RunPod RTX 4090 on-demand, approx.

  const voices = ["Warm, low", "Bright, quick", "Older, gravel", "Soft, close"];

  function splitScenes(seconds) {
    const n = seconds <= 30 ? 4 : seconds <= 60 ? 6 : 10;
    const base = Math.floor(seconds / n);
    return Array.from({ length: n }, (_, i) => (i < seconds - base * n ? base + 1 : base));
  }

  const SESSION = "moviegen:session";
  return {
    demo,
    voices,
    session() { try { return sessionStorage.getItem(SESSION); } catch { return null; } },
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
      const durs = splitScenes(seconds);
      const cast = [{ name: "Ada", voice: voices[0] }, { name: "Marcus", voice: voices[2] }];
      const beats = ["Arrival", "Recognition", "The old question", "What changed", "The offer", "Silence", "The answer", "Turning away", "Second thought", "Last light"];
      let t = 0;
      const scenes = durs.map((dur, i) => {
        const s = { id: crypto.randomUUID(), title: beats[i], start: t, dur, shot: `${look}. ${idea.slice(0, 120)}`, lines: [
          { who: cast[i % 2].name, text: i === 0 ? "I wasn't sure you'd come." : "Placeholder line, written by the model once the GPU is connected." },
        ] };
        t += dur;
        return s;
      });
      const words = idea.split(/[.!?]/)[0].split(" ").slice(0, 6);
      while (words.length > 1 && /^(a|an|the|of|to|and|her|his)$/i.test(words.at(-1))) words.pop();
      const title = words.join(" ") || "Untitled film";
      return { title, cast, scenes };
    },

    async makeVoices(scene) {
      await wait(1200);
      return { url: null }; // demo: the browser's own speech plays the lines instead
    },

    async makeClip(scene, onProgress) {
      const steps = 12;
      for (let i = 1; i <= steps; i++) { await wait(350); onProgress(i / steps); }
      if (Math.random() < 0.1) throw new Error("The GPU ran out of memory on this shot. Try again, or shorten it.");
      return { url: null };
    },

    async buildMovie() {
      await wait(1500);
      return { url: null }; // demo: no file; the player steps through the scenes instead
    },
  };
})();
