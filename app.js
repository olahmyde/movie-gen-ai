// Not signed in: go to the landing page. This only routes people; the real lock is on the server.
if (!api.session()) location.replace("login.html");

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const CURRENT = "moviegen:current"; // which film this browser had open; the films themselves live on the server

let gpu = { state: "stopped" };
let store = { films: [], current: null };
let voiceList = [], defaultVoices = [];
let costTimer = null;

const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const running = () => gpu.state === "running";
const total = (scenes) => scenes.reduce((a, s) => a + s.dur, 0);
const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const film = () => store.films.find((f) => f.id === store.current) || store.films[0];
const voiceById = (id) => voiceList.find((v) => v.id === id);
const voiceLabel = (v) => (v ? `${v.name}, ${[v.accent, v.gender].filter(Boolean).join(" ")}${v.age ? `, ${v.age}` : ""}` : "Choose a voice");

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), 4500);
}

// Calls fn(secondsElapsed) every second until the returned stop() is called.
function tick(fn) {
  const t0 = Date.now();
  fn(0);
  const id = setInterval(() => fn(Math.floor((Date.now() - t0) / 1000)), 1000);
  return () => clearInterval(id);
}

/* Films and saving: every change to the open film is saved to the server shortly after */
function blankFilm() { return { id: crypto.randomUUID(), title: "New film", idea: "", look: "", cast: [], scenes: [], movie: null }; }

let saveTimer = null, saving = Promise.resolve();
function save() {
  const f = film();
  if (!f) return;
  setSaveState("Saving");
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const copy = JSON.parse(JSON.stringify(f));
    saving = saving.then(() => api.saveFilm(copy))
      .then((r) => { f.updatedAt = r.updatedAt; setSaveState(`Saved ${new Date(r.updatedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`); })
      .catch((err) => { setSaveState(`Not saved: ${err.message}`, "error"); });
  }, 600);
}
function setSaveState(text, tone = "") {
  const el = $("#save-state");
  el.textContent = text; el.dataset.tone = tone;
}
function remember() { try { localStorage.setItem(CURRENT, store.current); } catch {} }

/* GPU switch */
function renderGpu() {
  const box = $("#gpu"), btn = $("#gpu-toggle");
  box.dataset.state = gpu.state;
  $("#gpu-state").textContent = { stopped: "GPU stopped", starting: "GPU starting", running: "GPU running" }[gpu.state];
  btn.textContent = running() ? "Stop GPU" : "Start GPU";
  btn.disabled = gpu.state === "starting";
  btn.setAttribute("aria-busy", gpu.state === "starting");
  clearInterval(costTimer);
  const cost = $("#gpu-cost");
  if (running()) {
    const paint = () => {
      const hrs = (Date.now() - gpu.startedAt) / 3.6e6;
      cost.textContent = `$${gpu.ratePerHour.toFixed(2)} an hour, $${(hrs * gpu.ratePerHour).toFixed(2)} so far`;
    };
    paint(); costTimer = setInterval(paint, 10000);
  } else cost.textContent = "";
  $("#write-btn").disabled = !running() || $("#write-btn").getAttribute("aria-busy") === "true";
  $("#write-hint").hidden = running();
  $$("[data-act]").forEach((b) => (b.disabled = !running() || b.getAttribute("aria-busy") === "true"));
  renderBatch(); renderSteps(); renderReel();
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

/* Film switcher, new, delete, rename */
function renderFilms() {
  const sel = $("#film-select");
  sel.innerHTML = "";
  store.films.forEach((f) => sel.append(new Option(f.title, f.id, false, f.id === store.current)));
  $("#film-delete").disabled = store.films.length === 1 && !film().scenes.length;
}
$("#film-select").addEventListener("change", (e) => { stopPlayback(); store.current = e.target.value; remember(); render(); });
$("#film-new").addEventListener("click", () => {
  stopPlayback();
  const f = blankFilm();
  store.films.unshift(f); store.current = f.id; remember(); save(); render();
  $("#idea").focus();
});
$("#film-delete").addEventListener("click", async () => {
  const f = film();
  if (!confirm(`Delete "${f.title}"? Its script, voices and clips go with it, for everyone. This can't be undone.`)) return;
  stopPlayback();
  try { await api.deleteFilm(f.id); } catch (err) { return toast(`Couldn't delete it: ${err.message}`); }
  store.films = store.films.filter((x) => x.id !== f.id);
  if (!store.films.length) { store.films.push(blankFilm()); }
  store.current = store.films[0].id; remember(); render();
  toast(`Deleted "${f.title}".`);
});

function renaming(on) {
  $("#rename-form").hidden = !on;
  $("#cut-h").hidden = on;
  $("#rename-btn").hidden = on;
  if (on) { $("#rename-input").value = film().title; $("#rename-input").select(); }
  else $("#rename-btn").focus();
}
$("#rename-btn").addEventListener("click", () => renaming(true));
$("#rename-cancel").addEventListener("click", () => renaming(false));
$("#rename-input").addEventListener("keydown", (e) => { if (e.key === "Escape") renaming(false); });
$("#rename-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const name = $("#rename-input").value.trim();
  if (!name) return;
  film().title = name; save();
  renaming(false); render();
});

/* Script */
$("#idea-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = new FormData(e.target);
  const idea = String(form.get("idea")).trim();
  if (!idea) return;
  const cur = film();
  if (cur.scenes.length && !confirm("Rewrite the script? The scenes, voices and clips of this film are replaced.")) return;
  stopPlayback();
  const btn = $("#write-btn");
  btn.disabled = true; btn.setAttribute("aria-busy", "true");
  $("#empty").hidden = true; $("#final").hidden = true; $("#batch").hidden = true;
  const list = $("#scenes");
  list.setAttribute("aria-busy", "true");
  list.innerHTML = `<li class="writing" role="status"><p class="writing__title">Writing the script</p><p class="writing__time num" data-t>0:00</p>
    <p class="writing__hint" data-hint></p><div class="meter writing__meter"><span></span></div></li>
    <li class="skeleton"></li><li class="skeleton"></li>`;
  const status = $(".writing", list);
  const r = status.getBoundingClientRect();
  if (r.top < 0 || r.bottom > innerHeight) status.scrollIntoView({ block: "center", behavior: reduced() ? "auto" : "smooth" });
  // Typical 4090 timings: the writer model loads in about 40 s on the first script after the GPU starts.
  const stopTick = tick((sec) => {
    $("[data-t]", list).textContent = fmt(sec);
    btn.textContent = `Writing ${fmt(sec)}`;
    $("[data-hint]", list).textContent = sec < 8 ? "Sending your idea to the writer model."
      : sec < 50 ? "Loading the writer model. The first script after the GPU starts takes about a minute; later ones take seconds."
      : "Writing the scenes, the shots and every character's lines.";
  });
  try {
    const s = await api.writeScript({ idea, seconds: Number(form.get("length")), look: form.get("look") });
    const named = cur.title !== "New film" ? cur.title : null; // a film you named keeps your name
    Object.assign(cur, { idea, look: form.get("look"), movie: null, ...s, scenes: s.scenes.map((x) => ({ ...x, voice: "none", clip: "none" })) });
    if (named) cur.title = named;
    save();
  } catch (err) {
    $("#write-hint").hidden = false; $("#write-hint").dataset.tone = "error";
    $("#write-hint").textContent = `The script didn't come back: ${err.message}`;
  }
  stopTick();
  btn.removeAttribute("aria-busy");
  list.setAttribute("aria-busy", "false");
  render(); renderGpu();
});

/* Cast: each character's voice, chosen in the picker */
function renderCast() {
  const f = film(), box = $("#cast"), ul = $("#cast-list");
  box.hidden = !f.cast.length;
  ul.innerHTML = "";
  f.cast.forEach((c, i) => {
    if (!voiceById(c.voice)) c.voice = defaultVoices[i % defaultVoices.length] || voiceList[0]?.id;
    const li = document.createElement("li");
    li.innerHTML = `<span class="who" aria-hidden="true"></span>
      <div class="cast__main"><div class="cast__name"></div>
        <button class="voicepick" type="button"><span class="voicepick__text"><span class="voicepick__label"></span><span class="voicepick__meta"></span></span><span class="voicepick__change">Change</span></button></div>
      <button class="btn btn--text" type="button" data-hear>Play</button>`;
    $(".who", li).textContent = c.name[0];
    $(".cast__name", li).textContent = c.name;
    const vo = voiceById(c.voice);
    $(".voicepick__label", li).textContent = vo?.name || "Choose a voice";
    $(".voicepick__meta", li).textContent = vo ? [vo.accent, vo.gender, vo.age].filter(Boolean).join(", ") : "";
    $(".voicepick", li).setAttribute("aria-label", `Voice for ${c.name}: ${voiceLabel(voiceById(c.voice))}. Change`);
    $(".voicepick", li).addEventListener("click", () => openPicker(c));
    const hear = $("[data-hear]", li);
    hear.setAttribute("aria-label", `Play ${c.name}'s voice`);
    hear.addEventListener("click", () => hearVoice(hear, c.voice, c.name));
    ul.append(li);
  });
}

// The real voice model reads a sample line; the first sample of a voice takes a few seconds,
// then it's cached on the server.
let voicePlayer = null;
async function hearVoice(btn, voice, who) {
  if (btn.getAttribute("aria-busy") === "true") return;
  const label = btn.textContent;
  btn.setAttribute("aria-busy", "true");
  const stop = tick((sec) => (btn.textContent = sec < 2 ? "Loading" : `Loading ${fmt(sec)}`));
  try {
    const url = await api.voiceSample(voice);
    if (url) { voicePlayer?.pause(); voicePlayer = new Audio(url); voicePlayer.play().catch(() => {}); }
    else say([{ who, text: `This is the browser's demo voice, not the real one.` }]);
  } catch (err) {
    toast(`That voice didn't load: ${err.message}`);
  }
  stop();
  btn.removeAttribute("aria-busy");
  btn.textContent = label;
}

// Demo only: the browser's own speech when there's no server.
function say(lines) {
  if (!("speechSynthesis" in window)) return;
  speechSynthesis.cancel();
  lines.forEach((l) => speechSynthesis.speak(new SpeechSynthesisUtterance(l.text)));
}

/* The voice picker */
const dialog = $("#voice-dialog");
let pickingFor = null;
function openPicker(c) {
  pickingFor = c;
  $("#picker-h").textContent = `Voice for ${c.name}`;
  renderPicker();
  dialog.showModal();
}
function renderPicker() {
  const gender = $('input[name="f-gender"]:checked', dialog).value, age = $('input[name="f-age"]:checked', dialog).value;
  const shown = voiceList.filter((v) => (!gender || v.gender === gender) && (!age || v.age === age));
  const ul = $("#voice-list");
  ul.innerHTML = "";
  shown.forEach((v) => {
    const li = document.createElement("li");
    li.className = "voice";
    li.innerHTML = `<label class="voice__pick"><input type="radio" name="voice"><span class="voice__name"></span><span class="voice__meta"></span></label>
      <button class="btn btn--text" type="button">Play</button>`;
    const radio = $("input", li);
    radio.value = v.id; radio.checked = v.id === pickingFor?.voice;
    $(".voice__name", li).textContent = v.name;
    $(".voice__meta", li).textContent = [v.accent, v.gender, v.age, v.engine === "Kokoro" ? "" : v.engine.toLowerCase()].filter(Boolean).join(", ");
    radio.addEventListener("change", () => { pickingFor.voice = v.id; markVoicesStale(pickingFor.name); save(); renderCast(); });
    const play = $("button", li);
    play.setAttribute("aria-label", `Play ${v.name}`);
    play.addEventListener("click", () => hearVoice(play, v.id, pickingFor?.name));
    ul.append(li);
  });
  const empty = $("#voice-empty");
  empty.hidden = shown.length > 0;
  empty.textContent = age === "child"
    ? "No child voices yet. Open voice models don't include children, so add one from a recording below, with a parent's permission."
    : "No voices match. Try Any, or add one from a recording below.";
  if (!shown.length && age === "child") $("#clone").open = true;
  // A voice cloned from here starts as whoever the filters describe.
  if (gender) $('#clone-form [name="gender"]').value = gender;
  if (age) $('#clone-form [name="age"]').value = age;
}
dialog.addEventListener("change", (e) => { if (e.target.name === "f-gender" || e.target.name === "f-age") renderPicker(); });
$("#picker-done").addEventListener("click", () => dialog.close());

// A character's new voice makes that character's scene voices out of date.
function markVoicesStale(name) {
  film().scenes.forEach((s) => {
    if (s.voice === "done" && s.lines.some((l) => l.who === name)) { s.voice = "none"; delete s.voiceUrl; film().movie = null; }
  });
  renderScenes();
}

$("#clone-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = $("#clone-btn"), hint = $("#clone-hint");
  btn.disabled = true; btn.setAttribute("aria-busy", "true"); btn.textContent = "Adding";
  hint.dataset.tone = "";
  try {
    const id = await api.cloneVoice(new FormData(e.target));
    voiceList = (await api.listVoices()).voices;
    if (pickingFor) { pickingFor.voice = id; markVoicesStale(pickingFor.name); save(); renderCast(); }
    e.target.reset();
    $$('input[name="f-gender"], input[name="f-age"]', dialog).forEach((r) => (r.checked = r.value === ""));
    renderPicker();
    hint.textContent = "Added, and chosen for this character. Play it to check it.";
  } catch (err) {
    hint.dataset.tone = "error"; hint.textContent = err.message;
  }
  btn.disabled = false; btn.removeAttribute("aria-busy"); btn.textContent = "Add voice";
});

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

function voiceOf(s) {
  voicePlayer?.pause();
  if (s.voiceUrl) { voicePlayer = new Audio(s.voiceUrl); voicePlayer.play().catch(() => {}); }
  else if (api.demo) say(s.lines);
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

/* Rendering */
function render() {
  const f = film();
  renderFilms(); renderCast();
  $("#idea").value = f.idea;
  $("#write-btn").textContent = f.scenes.length ? "Rewrite the script" : "Write the script";
  $("#cut-h").textContent = f.title;
  $("#cut-meta").textContent = f.scenes.length ? `${f.scenes.length} scenes, ${fmt(total(f.scenes))} running time` : "";
  if (f.updatedAt && !$("#save-state").textContent) setSaveState(`Saved ${new Date(f.updatedAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}`);
  $("#empty").hidden = !!f.scenes.length;
  renderScenes();
  renderBatch(); renderSteps(); renderReel(); renderFinal();
}

function renderScenes() {
  const list = $("#scenes");
  list.innerHTML = "";
  film().scenes.forEach((s) => list.append(sceneEl(s)));
  $$("[data-act]").forEach((b) => (b.disabled = !running()));
}

function renderSteps() {
  const f = film();
  if (!f) return;
  const done = {
    gpu: running(),
    script: f.scenes.length > 0,
    clips: f.scenes.length > 0 && f.scenes.every((s) => s.clip === "done"),
    movie: !!f.movie,
  };
  let currentSet = false;
  $$("#steps li").forEach((li) => {
    const state = done[li.dataset.step] ? "done" : currentSet ? "todo" : ((currentSet = true), "current");
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
  shot.addEventListener("change", () => {
    s.shot = shot.value;
    if (s.clip === "done") { s.clip = "none"; delete s.clipUrl; film().movie = null; paintScene(li, s); renderReel(); }
    save();
  });

  const lines = $("[data-lines]", li);
  s.lines.forEach((l) => {
    const row = document.createElement("li");
    row.className = "line";
    row.innerHTML = `<span class="line__who"></span><span></span>`;
    row.children[0].textContent = l.who;
    row.children[1].textContent = l.text;
    lines.append(row);
  });

  const v = screenEl($("[data-screen]", li));
  v.play.setAttribute("aria-label", `Play ${s.title}`);
  v.play.addEventListener("click", () => (playback?.v === v ? stopPlayback() : play(v, [s])));
  li._view = v;
  paintScene(li, s);

  $("[data-play-voice]", li).setAttribute("aria-label", `Play the voices of ${s.title}`);
  $("[data-play-voice]", li).addEventListener("click", () => voiceOf(s));
  $('[data-act="voice"]', li).addEventListener("click", () => runTask(s, "voice"));
  $('[data-act="clip"]', li).addEventListener("click", () => runTask(s, "clip"));
  return li;
}

const STATE_TEXT = {
  voice: { none: "Not made yet", busy: "Making", done: "Ready", error: "Failed" },
  clip: { none: "Not made yet", busy: "Rendering", done: "Ready", error: "Failed" },
};
function paintScene(li, s) {
  const v = li._view;
  for (const kind of ["voice", "clip"]) {
    const st = $(kind === "voice" ? "[data-voice-status]" : "[data-clip-status]", li);
    if (s[kind] !== "busy") st.textContent = s[kind] === "error" ? `Failed: ${s.err || "try again"}` : STATE_TEXT[kind][s[kind]] + (kind === "clip" && s.clip === "done" ? `, ${s.dur} s` : "");
    st.dataset.tone = s[kind];
    $(`[data-task="${kind}"]`, li).dataset.state = s[kind];
    const btn = $(`[data-act="${kind}"]`, li);
    const noun = kind === "voice" ? "voices" : "clip";
    btn.textContent = s[kind] === "done" ? `Remake ${noun}` : s[kind] === "error" ? "Try again" : `Make ${noun}`;
    btn.hidden = s[kind] === "busy";
  }
  $("[data-play-voice]", li).hidden = s.voice !== "done";
  v.host.dataset.state = s.clip;
  if (s.clip !== "busy") v.empty.textContent = { none: "No clip yet", error: "Render failed", done: "" }[s.clip];
  v.card.hidden = s.clip !== "done";
  if (s.clip === "done") showCard(v, s);
  v.play.disabled = s.clip !== "done";
  v.clock.textContent = fmt(s.dur);
}

const sceneLi = (s) => $(`.scene[data-id="${s.id}"]`);

// Makes one scene's voices or clip, showing how long it's been against what's normal on the 4090.
async function runTask(s, kind) {
  const f = film();
  if (s[kind] === "busy") return;
  s[kind] = "busy";
  let li = sceneLi(s);
  if (li) paintScene(li, s);
  renderReel(); renderBatch();
  const stopTick = tick((sec) => {
    li = sceneLi(s);
    if (!li) return;
    const st = $(kind === "voice" ? "[data-voice-status]" : "[data-clip-status]", li);
    st.textContent = kind === "voice" ? `Making ${fmt(sec)}, usually under a minute` : `Rendering ${fmt(sec)}, usually 3 to 4 minutes`;
    if (kind === "clip") li._view.empty.textContent = `Rendering ${fmt(sec)}`;
  });
  try {
    if (kind === "voice") s.voiceUrl = (await api.makeVoices(s, f.cast)).url;
    else {
      const v = sceneLi(s)?._view;
      if (v && playback?.v === v) stopPlayback();
      const onProgress = (p) => {
        const view = sceneLi(s)?._view;
        if (view) { view.meter.hidden = false; view.meter.dataset.burn = ""; view.fill.style.transform = `scaleX(${p})`; }
        setReel(s.id, p);
      };
      s.clipUrl = (await api.makeClip(s, onProgress, f.look)).url;
    }
    f.movie = null; // a new clip or voice makes the built movie stale
    s[kind] = "done"; delete s.err;
  } catch (err) {
    s[kind] = "error"; s.err = err.message;
  }
  stopTick();
  li = sceneLi(s);
  if (li) {
    const v = li._view;
    v.meter.hidden = true; v.meter.removeAttribute("data-burn"); v.fill.style.transform = "scaleX(0)";
    paintScene(li, s);
    $(`[data-act="${kind}"]`, li).disabled = !running();
  }
  save(); renderBatch(); renderSteps(); renderReel(); renderFinal();
}

/* Make every scene: voices first, then clips, one after another (one GPU) */
let batchRunning = false;
function renderBatch() {
  const f = film();
  if (!f) return;
  const todo = f.scenes.filter((s) => s.voice !== "done" || s.clip !== "done").length;
  $("#batch").hidden = !f.scenes.length || (!todo && !batchRunning);
  const btn = $("#make-all");
  btn.disabled = !running() || batchRunning;
  btn.textContent = batchRunning ? "Making every scene" : `Make every scene (${todo} left)`;
}
$("#make-all").addEventListener("click", async () => {
  const f = film();
  batchRunning = true; renderBatch();
  for (const kind of ["voice", "clip"]) {
    for (const s of f.scenes) {
      if (film() !== f || !running()) break; // switched film or GPU stopped: stop the batch
      if (s[kind] === "done" || s[kind] === "busy") continue;
      await runTask(s, kind);
    }
  }
  batchRunning = false; renderBatch();
  const left = f.scenes.filter((s) => s.voice !== "done" || s.clip !== "done").length;
  toast(left ? `${left} scenes still need work. Check the ones marked Failed.` : "Every scene is made. Build the movie when you're ready.");
});

/* The reel */
function renderReel() {
  const f = film(), track = $("#reel-track");
  if (!f) return;
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
    btn.setAttribute("aria-busy", "true"); btn.disabled = true;
    const stop = tick((sec) => (btn.textContent = `Building ${fmt(sec)}`));
    try { f.movie = { ...(await api.buildMovie(f)), builtAt: Date.now() }; save(); }
    catch (err) { toast(`The movie didn't build: ${err.message}`); }
    stop();
    btn.removeAttribute("aria-busy");
    renderSteps(); renderReel(); renderFinal();
  }
  if (f.movie) $("#final").scrollIntoView({ behavior: reduced() ? "auto" : "smooth" });
});
$("#download-btn").addEventListener("click", () => {
  const f = film(), u = f.movie?.url;
  if (!u) return;
  Object.assign(document.createElement("a"), { href: u, download: `${f.title}.mp4` }).click();
});

/* Boot: films from the server, then the GPU state and the voices */
$("#demo-note").hidden = !api.demo;
setSaveState("Loading films");
Promise.all([
  api.gpuStatus(),
  api.listVoices().catch(() => ({ voices: [], default: [] })),
  api.listFilms().catch((err) => { toast(`Couldn't load your films: ${err.message}`); return []; }),
]).then(async ([g, v, films]) => {
  gpu = g; voiceList = v.voices; defaultVoices = v.default;
  // Films made before saving moved to the server lived in this browser only: move them up once.
  try {
    const old = JSON.parse(localStorage.getItem("moviegen:films"))?.films?.filter((f) => f.scenes?.length && !films.some((x) => x.id === f.id)) || [];
    for (const f of old) { await api.saveFilm(f); films.push(f); }
    localStorage.removeItem("moviegen:films");
    if (old.length) toast(`Moved ${old.length} film${old.length > 1 ? "s" : ""} from this browser to the studio.`);
  } catch {}
  // A job that was running when the page closed didn't finish here; show it as not made.
  films.forEach((f) => f.scenes.forEach((s) => ["voice", "clip"].forEach((k) => { if (s[k] === "busy") s[k] = "none"; })));
  store.films = films.length ? films : [blankFilm()];
  let last = null;
  try { last = localStorage.getItem(CURRENT); } catch {}
  store.current = store.films.some((f) => f.id === last) ? last : store.films[0].id;
  setSaveState(films.length ? "" : "Not saved yet");
  render(); renderGpu();
});
