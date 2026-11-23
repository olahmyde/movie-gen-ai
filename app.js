// Not signed in: go to the landing page. This only routes people; the real lock is on the server.
if (!api.session()) location.replace("login.html");

const $ = (s, el = document) => el.querySelector(s);
const KEY = "moviegen:films";

let gpu = { state: "stopped" };
let store = load();
let tick = null;

/* Films: several projects, one open at a time */
function blankFilm() { return { id: crypto.randomUUID(), title: "New film", idea: "", look: "", cast: [], scenes: [], movie: null }; }
function load() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY));
    if (s?.films?.length) return s;
  } catch {}
  const f = blankFilm();
  return { films: [f], current: f.id };
}
function save() { try { localStorage.setItem(KEY, JSON.stringify(store)); } catch {} }
const film = () => store.films.find((f) => f.id === store.current) || store.films[0];

const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const running = () => gpu.state === "running";
const total = (scenes) => scenes.reduce((a, s) => a + s.dur, 0);

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), 4500);
}

/* GPU switch */
function renderGpu() {
  const box = $("#gpu"), btn = $("#gpu-toggle");
  box.dataset.state = gpu.state;
  $("#gpu-state").textContent = { stopped: "GPU stopped", starting: "GPU starting", running: "GPU running" }[gpu.state];
  btn.textContent = running() ? "Stop GPU" : "Start GPU";
  btn.disabled = gpu.state === "starting";
  btn.setAttribute("aria-busy", gpu.state === "starting");
  clearInterval(tick);
  const cost = $("#gpu-cost");
  if (running()) {
    const paint = () => {
      const hrs = (Date.now() - gpu.startedAt) / 3.6e6;
      cost.textContent = `$${gpu.ratePerHour.toFixed(2)} an hour, $${(hrs * gpu.ratePerHour).toFixed(2)} so far`;
    };
    paint(); tick = setInterval(paint, 10000);
  } else cost.textContent = "";
  $("#write-btn").disabled = !running();
  $("#write-hint").hidden = running();
  document.querySelectorAll("[data-act]").forEach((b) => (b.disabled = !running() || b.getAttribute("aria-busy") === "true"));
  renderSteps(); renderReel();
}

$("#gpu-toggle").addEventListener("click", async () => {
  if (running()) {
    if (!api.demo && !confirm("Stop the GPU? Billing stops, and this page stops working until the pod is started again on runpod.io.")) return;
    gpu = await api.gpuStop(); renderGpu();
    toast(api.demo ? "GPU stopped. Billing has stopped too." : "GPU stopping. Start the pod on runpod.io to use the studio again.");
    return;
  }
  gpu = { state: "starting" }; renderGpu();
  gpu = await api.gpuStart(); renderGpu();
});

$("#sign-out").addEventListener("click", () => { api.signOut(); location.replace("login.html"); });

/* Film switcher */
function renderFilms() {
  const sel = $("#film-select");
  sel.innerHTML = "";
  store.films.forEach((f) => {
    const o = new Option(f.title, f.id, false, f.id === store.current);
    sel.append(o);
  });
  $("#film-delete").disabled = store.films.length === 1 && !film().scenes.length;
}
$("#film-select").addEventListener("change", (e) => { stopPlayback(); store.current = e.target.value; save(); render(); });
$("#film-new").addEventListener("click", () => {
  stopPlayback();
  const f = blankFilm();
  store.films.unshift(f); store.current = f.id; save(); render();
  $("#idea").focus();
});
$("#film-delete").addEventListener("click", () => {
  const f = film();
  if (!confirm(`Delete "${f.title}"? Its script, voices and clips go with it. This can't be undone.`)) return;
  stopPlayback();
  store.films = store.films.filter((x) => x.id !== f.id);
  if (!store.films.length) store.films.push(blankFilm());
  store.current = store.films[0].id; save(); render();
  toast(`Deleted "${f.title}".`);
});

/* Script */
$("#idea-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const idea = String(f.get("idea")).trim();
  if (!idea) return;
  const cur = film();
  if (cur.scenes.length && !confirm("Rewrite the script? The scenes, voices and clips of this film are replaced.")) return;
  stopPlayback();
  const btn = $("#write-btn");
  btn.disabled = true; btn.setAttribute("aria-busy", "true"); btn.textContent = "Writing";
  $("#empty").hidden = true; $("#final").hidden = true;
  const list = $("#scenes");
  list.setAttribute("aria-busy", "true");
  list.innerHTML = '<li class="skeleton"></li><li class="skeleton"></li>';
  try {
    const s = await api.writeScript({ idea, seconds: Number(f.get("length")), look: f.get("look") });
    Object.assign(cur, { idea, look: f.get("look"), movie: null, ...s, scenes: s.scenes.map((x) => ({ ...x, voice: "none", clip: "none" })) });
    save();
  } catch (err) {
    $("#write-hint").hidden = false; $("#write-hint").dataset.tone = "error";
    $("#write-hint").textContent = `The script didn't come back: ${err.message}`;
  }
  btn.removeAttribute("aria-busy");
  list.setAttribute("aria-busy", "false");
  render(); renderGpu();
});

/* Cast */
function renderCast() {
  const f = film(), box = $("#cast"), ul = $("#cast-list");
  box.hidden = !f.cast.length;
  ul.innerHTML = "";
  f.cast.forEach((c, i) => {
    const li = document.createElement("li");
    li.innerHTML = `<span class="who" aria-hidden="true"></span>
      <div><div class="cast__name"></div>
      <div class="cast__row"><select></select><button class="btn btn--text" type="button">Hear</button></div></div>`;
    $(".who", li).textContent = c.name[0];
    $(".cast__name", li).textContent = c.name;
    const sel = $("select", li);
    sel.setAttribute("aria-label", `Voice for ${c.name}`);
    api.voices.forEach((v) => sel.append(new Option(v, v, false, v === c.voice)));
    sel.addEventListener("change", () => { c.voice = sel.value; save(); });
    $("button", li).setAttribute("aria-label", `Hear ${c.name}'s voice`);
    $("button", li).addEventListener("click", () => say([{ who: c.name, text: `Hi, I'm ${c.name}.` }]));
    ul.append(li);
  });
}

// Demo voice: the browser's own speech. With the server, each scene's voice file plays instead.
function say(lines) {
  if (!("speechSynthesis" in window)) return;
  speechSynthesis.cancel();
  const f = film();
  lines.forEach((l) => {
    const u = new SpeechSynthesisUtterance(l.text);
    u.pitch = f.cast.findIndex((c) => c.name === l.who) % 2 ? 0.7 : 1.1;
    speechSynthesis.speak(u);
  });
}

/* The screen: one preview component for a scene and for the movie */
function screenEl(host) {
  host.append($("#screen-tpl").content.cloneNode(true));
  return {
    host,
    frame: $(".screen__frame", host),
    empty: $(".screen__empty", host),
    card: $(".screen__card", host),
    meter: $(".meter", host),
    fill: $(".meter > span", host),
    play: $("[data-play]", host),
    clock: $("[data-clock]", host),
  };
}
// A scene with a real clip shows the clip; otherwise its title card.
function showCard(v, s, { controls = false } = {}) {
  let vid = $("video", v.frame);
  if (s.clipUrl) {
    if (!vid) { vid = document.createElement("video"); vid.playsInline = true; vid.preload = "metadata"; v.frame.append(vid); }
    vid.muted = !controls; vid.controls = controls;
    if (!vid.src.endsWith(s.clipUrl)) vid.src = s.clipUrl;
    v.card.hidden = true;
    return vid;
  }
  vid?.remove();
  v.card.hidden = false;
  $(".screen__title", v.card).textContent = s.title;
  $(".screen__shot", v.card).textContent = s.shot;
}

// Real voice file when the scene has one, the browser's speech otherwise.
let voicePlayer = null;
function voiceOf(s) {
  voicePlayer?.pause();
  if (s.voiceUrl) { voicePlayer = new Audio(s.voiceUrl); voicePlayer.play().catch(() => {}); }
  else say(s.lines);
}

let playback = null;
function stopPlayback() { playback?.stop(); playback = null; }

// Steps through the scenes: each clip (or title card) with its voice, on one shared clock.
function play(v, scenes, onEnd) {
  stopPlayback();
  const length = total(scenes);
  const t0 = performance.now();
  let raf, timer, i = -1;
  v.meter.hidden = false; v.meter.removeAttribute("data-burn");
  v.play.textContent = "Stop";
  const next = () => {
    i++;
    if (i >= scenes.length) return end();
    const vid = showCard(v, scenes[i]);
    if (vid) { vid.currentTime = 0; vid.play().catch(() => {}); }
    voiceOf(scenes[i]);
    timer = setTimeout(next, scenes[i].dur * 1000);
  };
  const frame = () => {
    const t = Math.min((performance.now() - t0) / 1000, length);
    v.fill.style.transform = `scaleX(${t / length})`;
    v.clock.textContent = `${fmt(t)} of ${fmt(length)}`;
    raf = requestAnimationFrame(frame);
  };
  const end = () => {
    clearTimeout(timer); cancelAnimationFrame(raf);
    if ("speechSynthesis" in window) speechSynthesis.cancel();
    voicePlayer?.pause();
    $("video", v.frame)?.pause();
    v.meter.hidden = true; v.fill.style.transform = "scaleX(0)";
    v.play.textContent = "Play";
    v.clock.textContent = fmt(length);
    if (playback?.v === v) playback = null;
    onEnd?.();
  };
  playback = { v, stop: end };
  next(); frame();
}

/* Scenes */
function render() {
  const f = film();
  renderFilms(); renderCast();
  $("#idea").value = f.idea;
  $("#write-btn").textContent = f.scenes.length ? "Rewrite the script" : "Write the script";
  $("#cut-h").textContent = f.title;
  $("#cut-meta").textContent = f.scenes.length ? `${f.scenes.length} scenes, ${fmt(total(f.scenes))} running time` : "";
  $("#empty").hidden = !!f.scenes.length;
  const list = $("#scenes");
  list.innerHTML = "";
  f.scenes.forEach((s) => list.append(sceneEl(s)));
  renderSteps(); renderReel(); renderFinal();
}

function renderSteps() {
  const f = film();
  const done = {
    gpu: running(),
    script: f.scenes.length > 0,
    clips: f.scenes.length > 0 && f.scenes.every((s) => s.clip === "done"),
    movie: !!f.movie,
  };
  let currentSet = false;
  document.querySelectorAll("#steps li").forEach((li) => {
    const k = li.dataset.step;
    const state = done[k] ? "done" : currentSet ? "todo" : ((currentSet = true), "current");
    li.dataset.state = state;
    if (state === "current") li.setAttribute("aria-current", "step"); else li.removeAttribute("aria-current");
  });
}

function sceneEl(s) {
  const li = $("#scene-tpl").content.firstElementChild.cloneNode(true);
  li.dataset.id = s.id;
  $("[data-title]", li).textContent = s.title;
  $("[data-time]", li).textContent = `${fmt(s.start)} to ${fmt(s.start + s.dur)}`;
  const shot = $("[data-shot]", li);
  shot.value = s.shot;
  shot.setAttribute("aria-label", `Shot for ${s.title}`);
  shot.addEventListener("change", () => { s.shot = shot.value; save(); });

  const lines = $("[data-lines]", li);
  s.lines.forEach((l) => {
    const row = document.createElement("li");
    row.className = "line";
    row.innerHTML = `<span class="line__who"></span><span></span><button class="btn btn--text" type="button">Hear</button>`;
    row.children[0].textContent = l.who;
    row.children[1].textContent = l.text;
    row.children[2].setAttribute("aria-label", `Hear ${l.who}'s line`);
    row.children[2].addEventListener("click", () => (s.voiceUrl ? voiceOf(s) : say([l])));
    lines.append(row);
  });

  const v = screenEl($("[data-screen]", li));
  v.play.setAttribute("aria-label", `Play ${s.title}`);
  v.play.addEventListener("click", () => (playback?.v === v ? stopPlayback() : play(v, [s])));
  li._view = v;
  paintScene(li, s);

  $('[data-act="voice"]', li).addEventListener("click", (e) => run(e.currentTarget, s, li, "voice"));
  $('[data-act="clip"]', li).addEventListener("click", (e) => run(e.currentTarget, s, li, "clip"));
  return li;
}

function paintScene(li, s) {
  const vs = $("[data-voice-status]", li), cs = $("[data-clip-status]", li), v = li._view;
  vs.textContent = { none: "Voices not made", busy: "Making voices", done: "Voices ready", error: "Voices failed" }[s.voice];
  vs.dataset.tone = s.voice;
  cs.textContent = { none: "Clip not made", busy: "Rendering", done: `Clip ready, ${s.dur} s`, error: s.err || "Clip failed" }[s.clip];
  cs.dataset.tone = s.clip;
  $('[data-act="voice"]', li).textContent = s.voice === "done" ? "Remake voices" : "Make voices";
  $('[data-act="clip"]', li).textContent = s.clip === "done" ? "Remake clip" : s.clip === "error" ? "Try again" : "Make clip";
  v.host.dataset.state = s.clip;
  v.empty.textContent = { none: "No clip yet", busy: "Rendering", error: "Render failed", done: "" }[s.clip];
  v.card.hidden = s.clip !== "done";
  if (s.clip === "done") showCard(v, s);
  v.play.disabled = s.clip !== "done";
  v.clock.textContent = fmt(s.dur);
}

async function run(btn, s, li, kind) {
  const f = film();
  btn.setAttribute("aria-busy", "true"); btn.disabled = true;
  s[kind] = "busy"; paintScene(li, s); renderReel();
  const v = li._view;
  try {
    if (kind === "voice") s.voiceUrl = (await api.makeVoices(s, f.cast)).url;
    else {
      if (playback?.v === v) stopPlayback();
      v.meter.hidden = false; v.meter.dataset.burn = "";
      s.clipUrl = (await api.makeClip(s, (p) => { v.fill.style.transform = `scaleX(${p})`; setReel(s.id, p); }, f.look)).url;
    }
    f.movie = null; // a new clip or voice makes the built movie stale
    s[kind] = "done"; delete s.err;
  } catch (err) {
    s[kind] = "error"; s.err = err.message;
  }
  v.meter.hidden = true; v.meter.removeAttribute("data-burn"); v.fill.style.transform = "scaleX(0)";
  btn.removeAttribute("aria-busy"); btn.disabled = !running();
  save(); paintScene(li, s); renderSteps(); renderReel(); renderFinal();
}

/* The reel */
function renderReel() {
  const f = film(), track = $("#reel-track");
  track.innerHTML = "";
  f.scenes.forEach((s) => {
    const d = document.createElement("div");
    d.className = "reel__span"; d.dataset.id = s.id;
    d.style.setProperty("--dur", s.dur);
    d.style.setProperty("--fill", s.clip === "done" ? 1 : 0);
    if (s.clip === "done") d.dataset.done = "";
    if (s.clip === "busy") d.dataset.busy = "";
    d.append(document.createElement("span"));
    d.firstChild.textContent = s.title;
    track.append(d);
  });
  const done = f.scenes.filter((s) => s.clip === "done");
  const all = f.scenes.length > 0 && done.length === f.scenes.length;
  $("#reel-meta").textContent = f.scenes.length ? `${fmt(total(done))} of ${fmt(total(f.scenes))} rendered, ${done.length} of ${f.scenes.length} clips` : "Nothing on the timeline";
  const btn = $("#export-btn");
  btn.disabled = !all || !running() || btn.getAttribute("aria-busy") === "true";
  btn.textContent = f.movie ? "Watch the movie" : "Build the movie";
  if (f.movie) btn.disabled = false;
}
function setReel(id, p) { const el = $(`.reel__span[data-id="${id}"]`); if (el) el.style.setProperty("--fill", p); }

/* The movie */
let finalView = null;
function renderFinal() {
  const f = film(), sec = $("#final");
  sec.hidden = !f.movie;
  if (!f.movie) return;
  if (!finalView) {
    finalView = screenEl($("#final-screen"));
    finalView.play.addEventListener("click", () => (playback?.v === finalView ? stopPlayback() : play(finalView, film().scenes)));
  }
  $("#final-meta").textContent = `${fmt(total(f.scenes))}, ${f.scenes.length} scenes, built ${new Date(f.movie.builtAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}`;
  // A built file plays in the browser's own player; demo mode steps through the scenes.
  showCard(finalView, { title: f.title, shot: f.idea, clipUrl: f.movie.url }, { controls: true });
  $(".screen__bar", finalView.host).hidden = !!f.movie.url;
  finalView.play.disabled = false;
  finalView.play.setAttribute("aria-label", `Play ${f.title}`);
  finalView.clock.textContent = fmt(total(f.scenes));
  $("#download-btn").disabled = !f.movie.url;
  $("#download-hint").textContent = f.movie.url ? "" : "In demo mode there's no file to download yet. With the server connected, this saves the MP4.";
}

$("#export-btn").addEventListener("click", async (e) => {
  const f = film(), btn = e.currentTarget;
  if (!f.movie) {
    btn.setAttribute("aria-busy", "true"); btn.disabled = true; btn.textContent = "Building";
    try { f.movie = { ...(await api.buildMovie(f)), builtAt: Date.now() }; save(); }
    catch (err) { toast(`The movie didn't build: ${err.message}`); }
    btn.removeAttribute("aria-busy");
    renderSteps(); renderReel(); renderFinal();
  }
  if (f.movie) $("#final").scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
});
$("#download-btn").addEventListener("click", () => {
  const f = film(), u = f.movie?.url;
  if (!u) return;
  const a = Object.assign(document.createElement("a"), { href: u, download: `${f.title}.mp4` });
  a.click();
});

/* Boot */
$("#demo-note").hidden = !api.demo;
// A busy job doesn't survive a reload; show it as not made.
store.films.forEach((f) => f.scenes.forEach((s) => ["voice", "clip"].forEach((k) => { if (s[k] === "busy") s[k] = "none"; })));
api.gpuStatus().then((g) => { gpu = g; render(); renderGpu(); });
