// Not signed in: go to the landing page. This only routes people; the real lock is on the server.
if (!api.session()) location.replace("login.html");

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const CURRENT = "moviegen:current"; // which film this browser had open; the films live on the server

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
const describe = (v) => (v ? [v.accent, v.gender, v.age].filter(Boolean).join(", ") : "");

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), 4500);
}

// A button that's working: it pulses and says what it's doing, without a counter.
function busy(btn, label) {
  const was = btn.textContent;
  btn.setAttribute("aria-busy", "true"); btn.disabled = true; btn.textContent = label;
  return () => { btn.removeAttribute("aria-busy"); btn.disabled = false; btn.textContent = was; };
}

/* ---------- Saving: every change to the open film reaches the server a moment later ---------- */
function blankFilm() { return { id: crypto.randomUUID(), title: "Untitled film", idea: "", look: "", quality: "draft", cast: [], scenes: [], movie: null }; }

let saveTimer = null, saving = Promise.resolve();
function save() {
  const f = film();
  if (!f) return;
  setSaveState("Saving");
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const copy = JSON.parse(JSON.stringify(f));
    saving = saving.then(() => api.saveFilm(copy))
      .then((r) => { f.updatedAt = r.updatedAt; setSaveState("Saved"); })
      .catch((err) => setSaveState(`Not saved: ${err.message}`, "error"));
  }, 600);
}
function setSaveState(text, tone = "") { const el = $("#save-state"); el.textContent = text; el.dataset.tone = tone; }
function remember() { try { localStorage.setItem(CURRENT, store.current); } catch {} }

/* ---------- GPU ---------- */
function renderGpu() {
  const box = $("#gpu"), btn = $("#gpu-toggle");
  box.dataset.state = gpu.state;
  $("#gpu-state").textContent = { stopped: "GPU stopped", starting: "GPU starting", running: "GPU running" }[gpu.state];
  btn.textContent = running() ? "Stop GPU" : "Start GPU";
  btn.disabled = gpu.state === "starting";
  clearInterval(costTimer);
  const cost = $("#gpu-cost");
  if (running()) {
    const paint = () => { cost.textContent = `$${gpu.ratePerHour.toFixed(2)} an hour, $${(((Date.now() - gpu.startedAt) / 3.6e6) * gpu.ratePerHour).toFixed(2)} so far`; };
    paint(); costTimer = setInterval(paint, 10000);
  } else cost.textContent = "";
  if ($("#write-btn").getAttribute("aria-busy") !== "true") $("#write-btn").disabled = !running();
  $("#write-hint").hidden = running();
  renderBoard(); renderSteps(); renderReel();
}
$("#gpu-toggle").addEventListener("click", async () => {
  if (running()) {
    if (!api.demo && !confirm("Stop the GPU? Billing stops, and the studio stops working until the pod is started again on runpod.io.")) return;
    gpu = await api.gpuStop(); renderGpu();
    toast(api.demo ? "GPU stopped. Billing has stopped too." : "GPU stopping. Start the pod on runpod.io to use the studio again.");
    return;
  }
  gpu = { state: "starting" }; renderGpu();
  gpu = await api.gpuStart(); renderGpu();
});
$("#sign-out").addEventListener("click", () => { api.signOut(); location.replace("login.html"); });

/* ---------- Library ---------- */
function showLibrary(on) {
  stopPlayback();
  $("#library").hidden = !on;
  $("#studio").hidden = on;
  $("#reel").hidden = on;
  $("#bar-title").hidden = on;
  $("#films-btn").hidden = on;
  if (on) renderLibrary(); else render();
}
function renderLibrary() {
  const ul = $("#films");
  ul.innerHTML = "";
  store.films.forEach((f) => {
    const li = document.createElement("li");
    li.className = "filmcard";
    const firstClip = f.scenes.find((s) => s.clipUrl)?.clipUrl;
    li.innerHTML = `<button class="filmcard__open" type="button"><span class="frame"></span><span class="filmcard__title"></span><span class="filmcard__meta num"></span></button>
      <button class="btn btn--text filmcard__delete" type="button">Delete</button>`;
    const frame = $(".frame", li);
    if (firstClip) {
      const v = Object.assign(document.createElement("video"), { src: `${firstClip}#t=0.5`, muted: true, preload: "metadata", playsInline: true });
      frame.append(v);
    } else frame.append(Object.assign(document.createElement("span"), { className: "frame__label", textContent: f.scenes.length ? "No clips yet" : "Empty" }));
    $(".filmcard__title", li).textContent = f.title;
    const done = f.scenes.filter((s) => s.clip === "done").length;
    $(".filmcard__meta", li).textContent = f.scenes.length ? `${f.scenes.length} scenes, ${done} rendered${f.updatedAt ? `, ${new Date(f.updatedAt).toLocaleDateString([], { month: "short", day: "numeric" })}` : ""}` : "No script yet";
    $(".filmcard__open", li).setAttribute("aria-label", `Open ${f.title}`);
    $(".filmcard__open", li).addEventListener("click", () => { store.current = f.id; remember(); showLibrary(false); });
    $(".filmcard__delete", li).setAttribute("aria-label", `Delete ${f.title}`);
    $(".filmcard__delete", li).addEventListener("click", async () => {
      if (!confirm(`Delete "${f.title}"? Its script, voices and clips go with it, for everyone. This can't be undone.`)) return;
      try { await api.deleteFilm(f.id); } catch (err) { return toast(`Couldn't delete it: ${err.message}`); }
      store.films = store.films.filter((x) => x.id !== f.id);
      if (!store.films.length) store.films.push(blankFilm());
      if (store.current === f.id) { store.current = store.films[0].id; remember(); }
      renderLibrary();
    });
    ul.append(li);
  });
}
$("#films-btn").addEventListener("click", () => showLibrary(true));
$(".mark").addEventListener("click", (e) => { e.preventDefault(); showLibrary(true); });
$("#film-new").addEventListener("click", () => {
  const f = blankFilm();
  store.films.unshift(f); store.current = f.id; remember(); save();
  showLibrary(false);
  $("#title-input").select();
});

/* ---------- Title: edit it right in the bar ---------- */
$("#title-input").addEventListener("change", (e) => {
  const name = e.target.value.trim();
  if (!name) { e.target.value = film().title; return; }
  film().title = name; save();
});
$("#title-input").addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === "Escape") e.target.blur(); });

/* ---------- Script ---------- */
$("#idea-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = new FormData(e.target);
  const idea = String(form.get("idea")).trim();
  if (!idea) return;
  const cur = film();
  if (cur.scenes.length && !confirm("Rewrite the script? The scenes, voices and clips of this film are replaced.")) return;
  stopPlayback();
  const done = busy($("#write-btn"), "Writing the script");
  $("#empty").hidden = true; $("#final").hidden = true; $("#make-all").hidden = true;
  // Placeholder cards in the shape of what's coming
  const n = Math.max(2, Math.ceil(Number(form.get("length")) / 5));
  const list = $("#shots");
  list.setAttribute("aria-busy", "true");
  list.innerHTML = Array.from({ length: n }, () => `<li class="shot shot--ghost"><span class="frame shimmer"></span><span class="ghostline shimmer"></span><span class="ghostline ghostline--short shimmer"></span></li>`).join("");
  $("#board-meta").textContent = "Writing the scenes, shots and lines";
  try {
    const s = await api.writeScript({ idea, seconds: Number(form.get("length")), look: form.get("look") });
    const named = cur.title !== "Untitled film" && cur.title !== "New film" ? cur.title : null; // a film you named keeps your name
    Object.assign(cur, { idea, look: form.get("look"), quality: form.get("quality"), movie: null, ...s, scenes: s.scenes.map((x) => ({ ...x, voice: "none", clip: "none" })) });
    if (named) cur.title = named;
    save();
  } catch (err) {
    $("#write-hint").hidden = false; $("#write-hint").dataset.tone = "error";
    $("#write-hint").textContent = `The script didn't come back: ${err.message}`;
  }
  done();
  list.setAttribute("aria-busy", "false");
  render(); renderGpu();
});
$$('input[name="quality"]').forEach((r) => r.addEventListener("change", () => { film().quality = r.value; save(); }));

/* ---------- Cast: pick a character, narrow down, play, save ---------- */
let castChar = null; // name of the character being cast
function renderCast() {
  const f = film();
  $("#cast").hidden = !f.cast.length;
  if (!f.cast.length) return;
  f.cast.forEach((c, i) => { if (!voiceById(c.voice)) c.voice = defaultVoices[i % defaultVoices.length] || voiceList[0]?.id; });
  if (!f.cast.some((c) => c.name === castChar)) castChar = f.cast[0].name;
  const sel = $("#cast-char");
  sel.innerHTML = "";
  f.cast.forEach((c) => sel.append(new Option(`${c.name}, ${voiceById(c.voice)?.name || "no voice"}`, c.name, false, c.name === castChar)));
  loadCastFilters();
}
// Set the filters to the character's current voice, then fill the voice list.
function loadCastFilters() {
  const c = film().cast.find((x) => x.name === castChar);
  const v = voiceById(c?.voice);
  if (v) {
    setRadio("c-accent", v.accent || "");
    setRadio("c-gender", v.gender);
    setRadio("c-age", v.age);
  }
  fillVoices(c?.voice);
}
const setRadio = (name, value) => $$(`input[name="${name}"]`).forEach((r) => (r.checked = r.value === value));
const radio = (name) => $(`input[name="${name}"]:checked`)?.value ?? "";
function fillVoices(keep) {
  const accent = radio("c-accent"), gender = radio("c-gender"), age = radio("c-age");
  const shown = voiceList.filter((v) => (!accent || !v.accent || v.accent === accent) && (!gender || v.gender === gender) && (!age || v.age === age));
  const sel = $("#cast-voice");
  sel.innerHTML = "";
  shown.forEach((v) => sel.append(new Option(`${v.name}${v.engine !== "Kokoro" ? ` (${v.engine.toLowerCase()})` : ""}`, v.id, false, v.id === keep)));
  const empty = $("#cast-empty");
  empty.hidden = shown.length > 0;
  empty.textContent = age === "child"
    ? "No child voices yet: open voice models don’t include children. Clone one from a recording, with a parent’s permission."
    : "No voice matches. Change the accent, voice or age, or clone one from a recording.";
  sel.disabled = !shown.length;
  $("#cast-play").disabled = !shown.length;
  $("#cast-save").disabled = !shown.length;
  const c = film().cast.find((x) => x.name === castChar);
  $("#cast-current").textContent = c ? `${c.name} speaks as ${voiceById(c.voice)?.name || "nobody yet"}.` : "";
}
$("#cast-char").addEventListener("change", (e) => { castChar = e.target.value; loadCastFilters(); });
$("#cast-form").addEventListener("change", (e) => { if (e.target.name?.startsWith("c-")) fillVoices($("#cast-voice").value); });
$("#cast-play").addEventListener("click", (e) => hearVoice(e.currentTarget, $("#cast-voice").value));
$("#cast-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const c = film().cast.find((x) => x.name === castChar), id = $("#cast-voice").value;
  if (!c || !id) return;
  if (c.voice !== id) { c.voice = id; markVoicesStale(c.name); save(); }
  renderCast();
  toast(`${c.name} now speaks as ${voiceById(id).name}.`);
});

let voicePlayer = null;
async function hearVoice(btn, voice) {
  if (!voice || btn.getAttribute("aria-busy") === "true") return;
  const done = busy(btn, "Loading");
  try {
    const url = await api.voiceSample(voice);
    voicePlayer?.pause();
    if (url) { voicePlayer = new Audio(url); voicePlayer.play().catch(() => {}); }
    else say([{ text: "This is the browser's demo voice, not the real one." }]);
  } catch (err) { toast(`That voice didn't load: ${err.message}`); }
  done();
}
function say(lines) { // demo only, when there's no server
  if (!("speechSynthesis" in window)) return;
  speechSynthesis.cancel();
  lines.forEach((l) => speechSynthesis.speak(new SpeechSynthesisUtterance(l.text)));
}
// A character's new voice makes that character's scene voices out of date.
function markVoicesStale(name) {
  film().scenes.forEach((s) => {
    if (s.voice === "done" && s.lines.some((l) => l.who === name)) { s.voice = "none"; delete s.voiceUrl; film().movie = null; }
  });
  renderBoard();
}

$("#clone-open").addEventListener("click", () => {
  const age = radio("c-age"), gender = radio("c-gender");
  if (age) $('#clone-form [name="age"]').value = age;
  if (gender) $('#clone-form [name="gender"]').value = gender;
  $("#clone-dialog").showModal();
});
$("#clone-close").addEventListener("click", () => $("#clone-dialog").close());
$("#clone-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const hint = $("#clone-hint"), done = busy($("#clone-btn"), "Adding the voice");
  hint.dataset.tone = "";
  try {
    const id = await api.cloneVoice(new FormData(e.target));
    voiceList = (await api.listVoices()).voices;
    const c = film().cast.find((x) => x.name === castChar);
    if (c) { c.voice = id; markVoicesStale(c.name); save(); }
    e.target.reset();
    $("#clone-dialog").close();
    renderCast();
    toast(`Added ${voiceById(id).name}${c ? ` and gave it to ${c.name}` : ""}. Press Play to hear it.`);
  } catch (err) { hint.dataset.tone = "error"; hint.textContent = err.message; }
  done();
});

/* ---------- Frames: black until there's a picture ---------- */
function paintFrame(frame, s, { controls = false } = {}) {
  let vid = $("video", frame);
  frame.dataset.state = s.clip || "none";
  frame.classList.toggle("shimmer", s.clip === "busy");
  const label = $(".frame__label", frame);
  if (s.clip === "done" && s.clipUrl) {
    if (!vid) { vid = Object.assign(document.createElement("video"), { playsInline: true, preload: "metadata" }); frame.prepend(vid); }
    vid.muted = !controls; vid.controls = controls;
    if (!vid.src.endsWith(s.clipUrl)) vid.src = controls ? s.clipUrl : `${s.clipUrl}#t=0.5`;
    if (label) label.textContent = "";
    return vid;
  }
  vid?.remove();
  if (label) label.textContent = { busy: "Rendering", error: "Render failed", none: s.clip === undefined ? "" : "No clip yet" }[s.clip || "none"] ?? "";
  if (s.clip === "done" && !s.clipUrl && label) label.textContent = s.title; // demo mode has no file
}
function setBar(frame, p) { const bar = $(".frame__bar > span", frame); if (bar) bar.style.transform = `scaleX(${p})`; }

/* ---------- Playback ---------- */
let playback = null;
function stopPlayback() { playback?.stop(); playback = null; }
function voiceOf(s) {
  voicePlayer?.pause();
  if (s.voiceUrl) { voicePlayer = new Audio(s.voiceUrl); voicePlayer.play().catch(() => {}); }
  else if (api.demo) say(s.lines);
}
// Plays scenes in a frame: each clip with its voice, one after another.
function play(frame, scenes, btn) {
  stopPlayback();
  let i = -1, timer;
  const next = () => {
    i++;
    if (i >= scenes.length) return end();
    const vid = paintFrame(frame, scenes[i]);
    if (vid) { vid.currentTime = 0; vid.play().catch(() => {}); }
    voiceOf(scenes[i]);
    timer = setTimeout(next, scenes[i].dur * 1000);
  };
  const end = () => {
    clearTimeout(timer);
    if ("speechSynthesis" in window) speechSynthesis.cancel();
    voicePlayer?.pause(); $("video", frame)?.pause();
    if (btn) btn.textContent = "Play scene";
    if (playback?.frame === frame) playback = null;
  };
  if (btn) btn.textContent = "Stop";
  playback = { frame, stop: end };
  next();
}

/* ---------- The storyboard ---------- */
function render() {
  const f = film();
  $("#title-input").value = f.title;
  $("#idea").value = f.idea;
  setRadio("quality", f.quality || "draft");
  $("#write-btn").textContent = f.scenes.length ? "Rewrite the script" : "Write the script";
  $("#empty").hidden = !!f.scenes.length;
  renderCast(); renderBoard(); renderSteps(); renderReel(); renderFinal();
}

function renderBoard() {
  const f = film();
  if (!f || $("#shots").getAttribute("aria-busy") === "true") return;
  $("#board-meta").textContent = f.scenes.length ? `${f.scenes.length} scenes, ${fmt(total(f.scenes))}, ${f.quality === "final" ? "final quality" : "draft quality"}` : "";
  const ul = $("#shots");
  ul.innerHTML = "";
  f.scenes.forEach((s, i) => ul.append(shotCard(s, i)));
  const todo = f.scenes.filter((s) => s.voice !== "done" || s.clip !== "done").length;
  const all = $("#make-all");
  all.hidden = !f.scenes.length || (!todo && !batchRunning);
  all.disabled = !running() || batchRunning;
  all.textContent = batchRunning ? "Making every scene" : `Make every scene (${todo} left)`;
  if (batchRunning) all.setAttribute("aria-busy", "true"); else all.removeAttribute("aria-busy");
  if ($("#shot-dialog").open) paintSheet();
}

const CHIP = {
  voice: { none: "Voice", busy: "Voice", done: "Voice", error: "Voice failed" },
  clip: { none: "Clip", busy: "Clip", done: "Clip", error: "Clip failed" },
};
function shotCard(s, i) {
  const li = $("#shot-tpl").content.firstElementChild.cloneNode(true);
  li.dataset.id = s.id;
  $(".shot__title", li).textContent = s.title;
  $(".shot__time", li).textContent = `${fmt(s.start)}, ${s.dur} s`;
  $(".shot__line", li).textContent = s.lines.length ? `${s.lines[0].who}: “${s.lines[0].text}”` : "No lines";
  paintFrame($("[data-frame]", li), s);
  for (const k of ["voice", "clip"]) {
    const chip = $(`[data-chip="${k}"]`, li);
    chip.textContent = CHIP[k][s[k]];
    chip.dataset.state = s[k];
  }
  $(".shot__open", li).setAttribute("aria-label", `Open ${s.title}`);
  $(".shot__open", li).addEventListener("click", () => openSheet(s.id));
  // One next step per card: voices, then the clip, then watch it.
  const next = $(".shot__next", li);
  const step = s.voice !== "done" && s.lines.length ? "voice" : s.clip !== "done" ? "clip" : null;
  if (s.voice === "busy" || s.clip === "busy") {
    next.textContent = s.clip === "busy" ? "Rendering" : "Making voices"; next.disabled = true; next.setAttribute("aria-busy", "true");
  } else if (step) {
    next.textContent = step === "voice" ? (s.voice === "error" ? "Retry voices" : "Make voices") : (s.clip === "error" ? "Retry clip" : "Make clip");
    next.disabled = !running();
    next.addEventListener("click", () => runTask(s, step));
  } else {
    next.textContent = "Watch";
    next.addEventListener("click", () => openSheet(s.id, true));
  }
  return li;
}

/* ---------- The scene sheet ---------- */
let sheetId = null;
const sheetScene = () => film().scenes.find((s) => s.id === sheetId);
function openSheet(id, autoplay = false) {
  sheetId = id;
  paintSheet(true);
  $("#shot-dialog").showModal();
  if (autoplay) play($("#sd-frame"), [sheetScene()], $("#sd-play"));
}
function paintSheet(full = false) {
  const s = sheetScene();
  if (!s) return $("#shot-dialog").close();
  $("#sd-title").textContent = s.title;
  $("#sd-time").textContent = `${fmt(s.start)} to ${fmt(s.start + s.dur)}`;
  if (full) {
    $("#sd-shot").value = s.shot;
    const ul = $("#sd-lines");
    ul.innerHTML = "";
    s.lines.forEach((l) => {
      const li = document.createElement("li");
      li.className = "line";
      li.innerHTML = `<span class="line__who"></span><span></span>`;
      li.children[0].textContent = l.who; li.children[1].textContent = l.text;
      ul.append(li);
    });
  }
  if (playback?.frame !== $("#sd-frame")) paintFrame($("#sd-frame"), s);
  $("#sd-play").disabled = s.clip !== "done";
  for (const k of ["voice", "clip"]) {
    const row = $(k === "voice" ? "#sd-voice" : "#sd-clip");
    const state = $(".task__state", row), btn = $(`[data-act="${k}"]`, row);
    row.dataset.state = s[k];
    state.textContent = { none: "Not made yet", busy: k === "voice" ? "Making" : "Rendering", done: "Ready", error: `Failed: ${s.err || "try again"}` }[s[k]];
    state.dataset.tone = s[k];
    btn.textContent = s[k] === "busy" ? (k === "voice" ? "Making voices" : "Rendering") : s[k] === "done" ? `Remake ${k === "voice" ? "voices" : "clip"}` : s[k] === "error" ? "Try again" : `Make ${k === "voice" ? "voices" : "clip"}`;
    btn.disabled = !running() || s[k] === "busy";
    if (s[k] === "busy") btn.setAttribute("aria-busy", "true"); else btn.removeAttribute("aria-busy");
  }
  $("#sd-voice [data-play-voice]").hidden = s.voice !== "done";
}
$("#sd-close").addEventListener("click", () => $("#shot-dialog").close());
$("#shot-dialog").addEventListener("close", () => { if (playback?.frame === $("#sd-frame")) stopPlayback(); });
$("#sd-play").addEventListener("click", () => (playback?.frame === $("#sd-frame") ? stopPlayback() : play($("#sd-frame"), [sheetScene()], $("#sd-play"))));
$("#sd-voice [data-play-voice]").addEventListener("click", () => voiceOf(sheetScene()));
$('#sd-voice [data-act="voice"]').addEventListener("click", () => runTask(sheetScene(), "voice"));
$('#sd-clip [data-act="clip"]').addEventListener("click", () => runTask(sheetScene(), "clip"));
$("#sd-shot").addEventListener("change", (e) => {
  const s = sheetScene();
  s.shot = e.target.value;
  if (s.clip === "done") { s.clip = "none"; delete s.clipUrl; film().movie = null; }
  save(); renderBoard(); renderReel();
});

/* ---------- Making voices and clips ---------- */
async function runTask(s, kind) {
  const f = film();
  if (!s || s[kind] === "busy") return;
  s[kind] = "busy"; delete s.err;
  renderBoard(); renderReel();
  try {
    if (kind === "voice") s.voiceUrl = (await api.makeVoices(s, f.cast)).url;
    else {
      const onProgress = (p) => {
        setReel(s.id, p);
        const card = $(`.shot[data-id="${s.id}"] [data-frame]`);
        if (card) setBar(card, p);
        if (sheetId === s.id) setBar($("#sd-frame"), p);
      };
      s.clipUrl = (await api.makeClip(s, onProgress, f.look, f.quality || "draft")).url;
    }
    f.movie = null; // anything new makes the built movie out of date
    s[kind] = "done";
  } catch (err) {
    s[kind] = "error"; s.err = err.message;
  }
  save(); renderBoard(); renderSteps(); renderReel(); renderFinal();
}

let batchRunning = false;
$("#make-all").addEventListener("click", async () => {
  const f = film();
  batchRunning = true; renderBoard();
  for (const kind of ["voice", "clip"]) {
    for (const s of f.scenes) {
      if (film() !== f || !running()) break;
      if (s[kind] === "done" || s[kind] === "busy" || (kind === "voice" && !s.lines.length)) continue;
      await runTask(s, kind);
    }
  }
  batchRunning = false; renderBoard();
  const left = f.scenes.filter((s) => s.voice === "error" || s.clip !== "done").length;
  toast(left ? `${left} scenes still need work. Check the ones marked failed.` : "Every scene is made. Build the movie when you’re ready.");
});

/* ---------- Steps, reel and the movie ---------- */
function renderSteps() {
  const f = film();
  if (!f) return;
  const done = { gpu: running(), script: f.scenes.length > 0, clips: f.scenes.length > 0 && f.scenes.every((s) => s.clip === "done"), movie: !!f.movie };
  let current = false;
  $$("#steps li").forEach((li) => {
    const state = done[li.dataset.step] ? "done" : current ? "todo" : ((current = true), "current");
    li.dataset.state = state;
    if (state === "current") li.setAttribute("aria-current", "step"); else li.removeAttribute("aria-current");
  });
}
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
    d.append(Object.assign(document.createElement("span"), { textContent: s.title }));
    track.append(d);
  });
  const done = f.scenes.filter((s) => s.clip === "done");
  const all = f.scenes.length > 0 && done.length === f.scenes.length;
  $("#reel-meta").textContent = f.scenes.length ? `${fmt(total(done))} of ${fmt(total(f.scenes))} rendered, ${done.length} of ${f.scenes.length} clips` : "Nothing on the timeline";
  const btn = $("#export-btn");
  if (btn.getAttribute("aria-busy") === "true") return;
  btn.textContent = f.movie ? "Watch the movie" : "Build the movie";
  btn.disabled = f.movie ? false : !all || !running();
}
function setReel(id, p) { const el = $(`.reel__span[data-id="${id}"]`); if (el) el.style.setProperty("--fill", p); }

function renderFinal() {
  const f = film();
  $("#final").hidden = !f.movie;
  if (!f.movie) return;
  $("#final-meta").textContent = `${fmt(total(f.scenes))}, ${f.scenes.length} scenes, built ${new Date(f.movie.builtAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}`;
  const frame = $("#final-frame");
  if (!$(".frame__label", frame)) frame.append(Object.assign(document.createElement("span"), { className: "frame__label" }));
  paintFrame(frame, { title: f.title, clip: "done", clipUrl: f.movie.url }, { controls: true });
  $("#download-btn").disabled = !f.movie.url;
  $("#download-hint").textContent = f.movie.url ? "" : "In demo mode there's no file to download. With the server connected, this saves the MP4.";
}
$("#export-btn").addEventListener("click", async (e) => {
  const f = film(), btn = e.currentTarget;
  if (!f.movie) {
    const done = busy(btn, "Building the movie");
    try { f.movie = { ...(await api.buildMovie(f)), builtAt: Date.now() }; save(); }
    catch (err) { toast(`The movie didn't build: ${err.message}`); }
    done();
    renderSteps(); renderReel(); renderFinal();
  }
  if (f.movie) $("#final").scrollIntoView({ behavior: reduced() ? "auto" : "smooth" });
});
$("#download-btn").addEventListener("click", () => {
  const f = film(), u = f.movie?.url;
  if (u) Object.assign(document.createElement("a"), { href: u, download: `${f.title}.mp4` }).click();
});

/* ---------- Boot ---------- */
$("#demo-note").hidden = !api.demo;
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
  // A job running when the page closed didn't finish here; show it as not made.
  films.forEach((f) => f.scenes.forEach((s) => ["voice", "clip"].forEach((k) => { if (s[k] === "busy") s[k] = "none"; })));
  store.films = films.length ? films : [blankFilm()];
  let last = null;
  try { last = localStorage.getItem(CURRENT); } catch {}
  store.current = store.films.some((f) => f.id === last) ? last : store.films[0].id;
  setSaveState(films.length ? "Saved" : "");
  // Several films: start in the library. One or none: straight into the studio.
  showLibrary(store.films.length > 1 && !last);
  renderGpu();
});
