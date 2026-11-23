"""MovieGenAI server: the one door into the GPU pod.

Serves the front end and a small JSON API behind a password. Everything else on the pod
(Ollama, ComfyUI) listens on localhost only.

    python app.py adduser you@example.com     # set a password (asks for it)
    python app.py                             # serve on :8000

GPU work runs one job at a time (one 24 GB card), so a script, a voice and a clip never
fight over memory.
"""
import getpass, hashlib, hmac, json, math, os, queue, secrets, shutil, subprocess, sys, threading, time, uuid
import urllib.request
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.responses import FileResponse, RedirectResponse

ROOT = Path(__file__).resolve().parent.parent          # the repo: front-end files live here
DATA = Path(os.environ.get("MOVIEGEN_DATA", "/workspace/moviegen"))
FILES = DATA / "files"
USERS = DATA / "users.json"
VOICES = DATA / "voices"                                # optional reference clips: <preset slug>.wav
OLLAMA = "http://127.0.0.1:11434"
COMFY = "http://127.0.0.1:8188"
COMFY_OUT = Path(os.environ.get("COMFY_OUTPUT", "/workspace/outputs"))
LLM = os.environ.get("MOVIEGEN_LLM", "qwen3:14b")
RATE = float(os.environ.get("MOVIEGEN_RATE", "0.89"))   # $/hr shown in the app
IDLE_STOP_MIN = int(os.environ.get("MOVIEGEN_IDLE_STOP_MIN", "30"))
FAKE = os.environ.get("MOVIEGEN_FAKE") == "1"           # local testing without a GPU
STARTED = time.time()
for d in (FILES, VOICES):
    d.mkdir(parents=True, exist_ok=True)

# Voices. Kokoro gives distinct ready-made voices; Chatterbox is the most expressive and
# clones any 10-second recording dropped into voices/ (the file name becomes the voice name).
# Kokoro's English voices: id -> (name, gender, age). Ages are by ear (young, adult, older);
# no open model ships a child's voice, so children come from cloned recordings.
KOKORO = {
    "af_heart": ("Heart", "woman", "adult"), "af_alloy": ("Alloy", "woman", "adult"), "af_aoede": ("Aoede", "woman", "adult"),
    "af_bella": ("Bella", "woman", "young"), "af_jessica": ("Jessica", "woman", "young"), "af_kore": ("Kore", "woman", "adult"),
    "af_nicole": ("Nicole", "woman", "young"), "af_nova": ("Nova", "woman", "adult"), "af_river": ("River", "woman", "adult"),
    "af_sarah": ("Sarah", "woman", "adult"), "af_sky": ("Sky", "woman", "young"),
    "am_adam": ("Adam", "man", "adult"), "am_echo": ("Echo", "man", "adult"), "am_eric": ("Eric", "man", "adult"),
    "am_fenrir": ("Fenrir", "man", "adult"), "am_liam": ("Liam", "man", "young"), "am_michael": ("Michael", "man", "adult"),
    "am_onyx": ("Onyx", "man", "older"), "am_puck": ("Puck", "man", "young"), "am_santa": ("Santa", "man", "older"),
    "bf_alice": ("Alice", "woman", "adult"), "bf_emma": ("Emma", "woman", "adult"), "bf_isabella": ("Isabella", "woman", "young"),
    "bf_lily": ("Lily", "woman", "young"), "bm_daniel": ("Daniel", "man", "older"), "bm_fable": ("Fable", "man", "young"),
    "bm_george": ("George", "man", "older"), "bm_lewis": ("Lewis", "man", "adult"),
}
DEFAULT_CAST = ["kokoro:af_heart", "kokoro:am_michael", "kokoro:bf_emma", "kokoro:bm_george"]
SAMPLE_TEXT = "I found your letter on the rocks this morning. It was written in my own hand."
GENDERS, AGES = ("woman", "man"), ("child", "young", "adult", "older")
slug = lambda s: "".join(c if c.isalnum() else "-" for c in s.lower()).strip("-")[:40]

def voices():
    out = [{"id": f"kokoro:{k}", "name": n, "gender": g, "age": a, "accent": "American" if k[0] == "a" else "British", "engine": "Kokoro"}
           for k, (n, g, a) in KOKORO.items()]
    out.append({"id": "cb:default", "name": "Chatterbox", "gender": "woman", "age": "adult", "accent": "American", "engine": "Chatterbox"})
    for p in sorted(VOICES.glob("*.wav")):
        meta = json.loads(p.with_suffix(".json").read_text()) if p.with_suffix(".json").exists() else {}
        out.append({"id": f"cb:{p.stem}", "name": meta.get("name", p.stem), "gender": meta.get("gender", ""), "age": meta.get("age", ""),
                    "accent": "", "engine": "Cloned"})
    return out

def add_clone(name, gender, age, upload):
    """Save an uploaded recording as a cloned voice: 24 kHz mono, the first 20 seconds."""
    sl = slug(name)
    if not sl or sl == "default":
        raise ValueError("Give the voice a name.")
    raw = VOICES / f"{sl}.upload"
    raw.write_bytes(upload)
    try:
        subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", str(raw), "-t", "20", "-ac", "1", "-ar", "24000", str(VOICES / f"{sl}.wav")], check=True)
    except subprocess.CalledProcessError:
        raise ValueError("That file isn't audio we can read. Try an MP3, WAV or M4A.")
    finally:
        raw.unlink(missing_ok=True)
    (VOICES / f"{sl}.json").write_text(json.dumps({"name": name.strip()[:40], "gender": gender, "age": age}))
    (FILES / f"sample-cb-{sl}.wav").unlink(missing_ok=True)  # a re-upload replaces the cached sample
    return f"cb:{sl}"


# ---------- users and sessions ----------

def hash_pw(pw, salt=None):
    salt = salt or secrets.token_hex(16)
    return salt, hashlib.pbkdf2_hmac("sha256", pw.encode(), bytes.fromhex(salt), 300_000).hex()

def load_users():
    try:
        return json.loads(USERS.read_text())
    except FileNotFoundError:
        return {}

def check_pw(email, pw):
    u = load_users().get(email.lower())
    if not u:
        hash_pw(pw)  # same work either way, so timing doesn't reveal which emails exist
        return False
    return hmac.compare_digest(hash_pw(pw, u["salt"])[1], u["hash"])

SESSIONS = {}          # token -> email; in memory, so a restart signs everyone out
FAILS = {}             # ip -> (count, first_fail_time)
last_activity = time.time()

def user(request: Request):
    email = SESSIONS.get(request.cookies.get("mg_session", ""))
    if not email:
        raise HTTPException(401, "Sign in first.")
    global last_activity
    last_activity = time.time()
    return email


# ---------- the GPU queue ----------

# Two lanes: voices are small enough to run beside a video render, so a voice sample never
# waits behind a 2-minute clip. Scripts, clips and movie builds share the heavy lane.
JOBS = {}
LANES = {"heavy": queue.Queue(), "voice": queue.Queue()}

def submit(kind, fn):
    job = {"id": uuid.uuid4().hex[:12], "kind": kind, "state": "queued", "progress": 0.0, "result": None, "error": None, "done": threading.Event()}
    JOBS[job["id"]] = job
    LANES["voice" if kind == "voice" else "heavy"].put((job, fn))
    return job

def worker(lane):
    while True:
        job, fn = LANES[lane].get()
        job["state"] = "busy"
        try:
            job["result"] = fn(job)
            job["state"], job["progress"] = "done", 1.0
        except Exception as e:  # the message goes back to the screen, so keep it human
            job["state"], job["error"] = "error", str(e) or e.__class__.__name__
        job["done"].set()

def run_now(kind, fn, timeout=900):
    job = submit(kind, fn)
    if not job["done"].wait(timeout):
        raise HTTPException(504, "The GPU is still busy with an earlier job. Try again in a minute.")
    if job["state"] == "error":
        raise HTTPException(500, job["error"])
    return job["result"]

def post_json(url, body, timeout=600):
    req = urllib.request.Request(url, json.dumps(body).encode(), {"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())

def get_json(url, timeout=30):
    with urllib.request.urlopen(url, timeout=timeout) as r:
        return json.loads(r.read())


# ---------- script (Ollama, Qwen3) ----------

SCRIPT_SCHEMA = {
    "type": "object", "required": ["title", "cast", "scenes"],
    "properties": {
        "title": {"type": "string"},
        "cast": {"type": "array", "items": {"type": "object", "required": ["name"], "properties": {"name": {"type": "string"}}}},
        "scenes": {"type": "array", "items": {"type": "object", "required": ["title", "shot", "lines"], "properties": {
            "title": {"type": "string"}, "shot": {"type": "string"},
            "lines": {"type": "array", "items": {"type": "object", "required": ["who", "text"], "properties": {"who": {"type": "string"}, "text": {"type": "string"}}}},
        }}},
    },
}

def write_script(idea, seconds, look):
    n = max(2, math.ceil(seconds / 5))            # Wan renders up to 5 s a clip, so a scene is at most 5 s
    dur = max(2, round(seconds / n))
    if FAKE:
        time.sleep(float(os.environ.get("MOVIEGEN_FAKE_DELAY", "0")))
        out = {"title": idea[:40], "cast": [{"name": "Ada"}, {"name": "Marcus"}],
               "scenes": [{"title": f"Scene {i + 1}", "shot": idea, "lines": [{"who": "Ada", "text": "Test line."}]} for i in range(n)]}
    else:
        prompt = (f"Write a short film of exactly {n} scenes, each about {dur} seconds on screen. Idea: {idea}\n"
                  f"Visual look: {look}.\nFor each scene give a short title, a one-paragraph shot description a video model "
                  f"can render (subject, action, setting, camera, light; no dialogue in it), and at most one or two short spoken "
                  f"lines that fit in {dur} seconds. When a scene has a line, its shot must show that character on camera, "
                  f"facing us and speaking it; a scene with nobody speaking has no lines. Two to four characters, and describe "
                  f"each character's look the same way in every shot (age, hair, clothes). Title the film in five words or fewer.")
        r = post_json(f"{OLLAMA}/api/chat", {"model": LLM, "stream": False, "think": False, "format": SCRIPT_SCHEMA,
                                             "options": {"temperature": 0.8}, "keep_alive": 0,
                                             "messages": [{"role": "user", "content": prompt}]})
        out = json.loads(r["message"]["content"])
    cast = [{"name": c["name"], "voice": DEFAULT_CAST[i % len(DEFAULT_CAST)]} for i, c in enumerate(out["cast"][:4])]
    scenes, t = [], 0
    for s in out["scenes"][:n]:
        scenes.append({"id": uuid.uuid4().hex, "title": s["title"], "shot": s["shot"], "lines": s["lines"][:2], "start": t, "dur": dur})
        t += dur
    return {"title": out["title"], "cast": cast, "scenes": scenes}


# ---------- voices (Kokoro and Chatterbox, both 24 kHz) ----------

SR = 24000
_models = {}
def model(name):
    if name not in _models:
        if name == "chatterbox":
            from chatterbox.tts import ChatterboxTTS
            _models[name] = ChatterboxTTS.from_pretrained(device="cuda")
        else:  # kokoro-a (American) or kokoro-b (British)
            from kokoro import KPipeline
            _models[name] = KPipeline(lang_code=name[-1], repo_id="hexgrad/Kokoro-82M")
    return _models[name]

def speak(text, voice):
    """One line in one voice, as a 1-D float tensor at 24 kHz."""
    import torch
    if voice not in {v["id"] for v in voices()}:
        voice = DEFAULT_CAST[0]  # unknown, or a film saved before voices had ids
    engine, name = voice.split(":", 1)
    if engine == "kokoro":
        pipe = model(f"kokoro-{name[0]}")
        return torch.cat([torch.as_tensor(a).flatten().float() for _, _, a in pipe(text, voice=name)])
    ref = VOICES / f"{name}.wav"
    wav = model("chatterbox").generate(text, audio_prompt_path=str(ref) if ref.exists() else None, exaggeration=0.5, cfg_weight=0.5)
    return wav.flatten().float()

def save_wav(parts, out):
    import torch, torchaudio
    wav = torch.cat(parts)
    peak = wav.abs().max()
    if peak > 0:
        wav = wav * (0.9 / peak)  # every voice at the same level, whichever model made it
    torchaudio.save(str(out), wav.unsqueeze(0), SR)
    return out

def fake_wav(out, seconds=2):
    subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-f", "lavfi", "-i", f"sine=frequency=330:duration={seconds}", str(out)], check=True)
    return out

def make_voice(lines, cast):
    voice_of = {c["name"]: c.get("voice") for c in cast}
    out = FILES / f"{uuid.uuid4().hex}.wav"
    if FAKE:
        return fake_wav(out)
    import torch
    parts = []
    for l in lines:
        parts += [speak(l["text"], voice_of.get(l["who"])), torch.zeros(int(SR * 0.3))]
    return save_wav(parts, out)

def voice_sample(voice):
    out = FILES / f"sample-{slug(voice)}.wav"   # cached: a voice always sounds the same
    if out.exists():
        return out
    return fake_wav(out) if FAKE else save_wav([speak(SAMPLE_TEXT, voice)], out)


# ---------- clips (ComfyUI, Wan 2.2 TI2V 5B) ----------

NEGATIVE = "blurry, low quality, distorted faces, extra limbs, text, watermark, subtitles, static frame"

SIZES = {"draft": (832, 480), "final": (1280, 704)}  # draft renders about 3x faster

def wan_workflow(prompt, frames, seed, quality="draft"):
    width, height = SIZES.get(quality, SIZES["draft"])
    return {
        "1": {"class_type": "UNETLoader", "inputs": {"unet_name": "wan2.2_ti2v_5B_fp16.safetensors", "weight_dtype": "default"}},
        "2": {"class_type": "CLIPLoader", "inputs": {"clip_name": "umt5_xxl_fp8_e4m3fn_scaled.safetensors", "type": "wan", "device": "default"}},
        "3": {"class_type": "VAELoader", "inputs": {"vae_name": "wan2.2_vae.safetensors"}},
        "4": {"class_type": "ModelSamplingSD3", "inputs": {"model": ["1", 0], "shift": 8}},
        "5": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["2", 0], "text": prompt}},
        "6": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["2", 0], "text": NEGATIVE}},
        "7": {"class_type": "Wan22ImageToVideoLatent", "inputs": {"vae": ["3", 0], "width": width, "height": height, "length": frames, "batch_size": 1}},
        "8": {"class_type": "KSampler", "inputs": {"model": ["4", 0], "positive": ["5", 0], "negative": ["6", 0], "latent_image": ["7", 0],
                                                    "seed": seed, "steps": 20, "cfg": 5, "sampler_name": "uni_pc", "scheduler": "simple", "denoise": 1}},
        "9": {"class_type": "VAEDecode", "inputs": {"samples": ["8", 0], "vae": ["3", 0]}},
        "10": {"class_type": "CreateVideo", "inputs": {"images": ["9", 0], "fps": 24}},
        "11": {"class_type": "SaveVideo", "inputs": {"video": ["10", 0], "filename_prefix": "moviegen/clip", "format": "mp4", "codec": "auto"}},
    }

CLIP_SECONDS_EXPECTED = {"draft": 80, "final": 240}  # ponytail: time-based progress; ComfyUI's websocket would be exact

def make_clip(job, shot, look, seconds, quality="draft"):
    frames = min(121, int(seconds * 24) + 1)
    out = FILES / f"{uuid.uuid4().hex}.mp4"
    if FAKE:
        subprocess.run(["ffmpeg", "-loglevel", "error", "-f", "lavfi", "-i", f"testsrc=size=640x352:rate=24:duration={seconds}",
                        "-pix_fmt", "yuv420p", str(out)], check=True)
        return out
    pid = post_json(f"{COMFY}/prompt", {"prompt": wan_workflow(f"{look}. {shot}", frames, secrets.randbelow(2**32), quality)})["prompt_id"]
    t0 = time.time()
    while True:
        time.sleep(3)
        job["progress"] = min(0.95, (time.time() - t0) / CLIP_SECONDS_EXPECTED.get(quality, 80))
        h = get_json(f"{COMFY}/history/{pid}").get(pid)
        if not h:
            continue
        if h.get("status", {}).get("status_str") == "error":
            raise RuntimeError("The video model failed on this shot. Try again, or simplify the shot.")
        for node in h.get("outputs", {}).values():
            for items in node.values():
                for f in items if isinstance(items, list) else []:
                    if isinstance(f, dict) and str(f.get("filename", "")).endswith(".mp4"):
                        shutil.move(str(COMFY_OUT / f.get("subfolder", "") / f["filename"]), out)
                        return out


# ---------- the movie (ffmpeg) ----------

def file_of(url):
    if not url:
        return None
    p = (FILES / Path(url).name).resolve()
    if p.parent != FILES.resolve() or not p.exists():
        raise ValueError("A clip or voice file is missing. Remake that scene.")
    return p

def build_movie(scenes):
    parts = []
    for s in scenes:
        clip, voice = file_of(s.get("clipUrl")), file_of(s.get("voiceUrl"))
        if not clip:
            raise ValueError("Every scene needs a clip before the movie can be built.")
        part = FILES / f"part-{uuid.uuid4().hex}.mp4"
        audio = ["-i", str(voice)] if voice else ["-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo"]
        subprocess.run(["ffmpeg", "-loglevel", "error", "-i", str(clip), *audio, "-map", "0:v", "-map", "1:a", "-af", "apad",
                        "-vf", "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1",
                        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-r", "24", "-c:a", "aac", "-ar", "44100", "-ac", "2", "-shortest", str(part)], check=True)
        parts.append(part)
    listing = FILES / f"list-{uuid.uuid4().hex}.txt"
    listing.write_text("".join(f"file '{p}'\n" for p in parts))
    out = FILES / f"movie-{uuid.uuid4().hex}.mp4"
    subprocess.run(["ffmpeg", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", str(listing), "-c", "copy", "-movflags", "+faststart", str(out)], check=True)
    for p in [*parts, listing]:
        p.unlink(missing_ok=True)
    return out


# ---------- stopping the pod ----------

def stop_pod():
    pod = os.environ.get("RUNPOD_POD_ID")
    if not pod:
        return False
    subprocess.Popen(["sh", "-c", f"sleep 2; runpodctl pod stop {pod} || runpodctl stop pod {pod}"])
    return True

def idle_watch():
    while True:
        time.sleep(60)
        if all(q.empty() for q in LANES.values()) and not any(j["state"] == "busy" for j in JOBS.values()) and time.time() - last_activity > IDLE_STOP_MIN * 60:
            print(f"idle for {IDLE_STOP_MIN} min, stopping the pod", flush=True)
            if stop_pod():
                return


# ---------- HTTP ----------

app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
url_of = lambda p: f"/files/{p.name}"

@app.middleware("http")
async def json_only_writes(request: Request, call_next):
    # A cross-site form can't send JSON, so this plus SameSite cookies blocks CSRF.
    # The one upload route takes a file, and its session cookie is SameSite=Strict.
    if (request.method in ("POST", "PUT") and request.url.path.startswith("/api/") and request.url.path != "/api/voices/clone"
            and "application/json" not in request.headers.get("content-type", "")):
        return Response('{"detail":"Send JSON."}', 415, media_type="application/json")
    return await call_next(request)

@app.post("/api/login")
async def login(body: dict, request: Request, response: Response):
    # Per address, plus an overall cap: behind the proxy an attacker can fake their address.
    ip = request.client.host if request.client else "?"
    now = time.time()
    for key, cap in ((ip, 5), ("*", 30)):
        n, t = FAILS.get(key, (0, now))
        if n >= cap and now - t < 600:
            raise HTTPException(429, "Too many tries. Wait ten minutes.")
    email, pw = str(body.get("email", "")).strip().lower(), str(body.get("password", ""))
    if not check_pw(email, pw):
        for key in (ip, "*"):
            n, t = FAILS.get(key, (0, now))
            FAILS[key] = (n + 1, t) if n and now - t < 600 else (1, now)
        raise HTTPException(401, "That email and password don't match.")
    FAILS.pop(ip, None)
    token = secrets.token_urlsafe(32)
    SESSIONS[token] = email
    # Runpod's proxy is HTTPS (forwarded headers say so); plain HTTP only happens in local tests.
    response.set_cookie("mg_session", token, httponly=True, secure=request.url.scheme == "https", samesite="strict", max_age=14 * 86400)
    global last_activity
    last_activity = time.time()
    return {"email": email}

@app.post("/api/logout")
async def logout(request: Request, response: Response):
    SESSIONS.pop(request.cookies.get("mg_session", ""), None)
    response.delete_cookie("mg_session")
    return {}

@app.get("/api/me")
def me(request: Request):
    return {"email": user(request)}

@app.get("/api/gpu")
def gpu(request: Request):
    user(request)
    return {"state": "running", "ratePerHour": RATE, "startedAt": int(STARTED * 1000), "idleStopMinutes": IDLE_STOP_MIN}

@app.post("/api/gpu/stop")
def gpu_stop(request: Request):
    user(request)
    if not stop_pod():
        raise HTTPException(500, "Couldn't find this pod's id. Stop it from runpod.io.")
    return {"state": "stopping"}

@app.post("/api/script")
def script(body: dict, request: Request):
    user(request)
    idea = str(body.get("idea", "")).strip()[:2000]
    if not idea:
        raise HTTPException(400, "Describe the film first.")
    seconds = min(max(int(body.get("seconds", 30)), 10), 180)
    return run_now("script", lambda j: write_script(idea, seconds, str(body.get("look", ""))[:100]))

@app.post("/api/voice")
def voice(body: dict, request: Request):
    user(request)
    lines = [{"who": str(l.get("who", ""))[:60], "text": str(l.get("text", ""))[:400]} for l in body.get("lines", [])][:6]
    if not lines:
        raise HTTPException(400, "This scene has no lines to voice.")
    return {"url": url_of(run_now("voice", lambda j: make_voice(lines, body.get("cast", []))))}

@app.get("/api/voices")
def list_voices(request: Request):
    user(request)
    return {"voices": voices(), "default": DEFAULT_CAST}

@app.post("/api/voice/sample")
def sample(body: dict, request: Request):
    user(request)
    voice = str(body.get("voice", ""))
    if voice not in {v["id"] for v in voices()}:
        raise HTTPException(400, "Pick a voice from the list.")
    return {"url": url_of(run_now("voice", lambda j: voice_sample(voice)))}

@app.post("/api/voices/clone")
async def clone(request: Request):
    user(request)
    form = await request.form()
    f, name = form.get("file"), str(form.get("name", "")).strip()
    gender, age = str(form.get("gender", "")), str(form.get("age", ""))
    if form.get("consent") != "yes":
        raise HTTPException(400, "Confirm you have the speaker's permission (a parent's, for a child).")
    if gender not in GENDERS or age not in AGES:
        raise HTTPException(400, "Pick who the voice is: woman or man, and an age.")
    if not f or not hasattr(f, "read"):
        raise HTTPException(400, "Choose a recording.")
    data = await f.read()
    if len(data) > 15 * 1024 * 1024:
        raise HTTPException(413, "Keep the recording under 15 MB; 10 to 20 seconds is plenty.")
    try:
        return {"id": add_clone(name, gender, age, data)}
    except ValueError as e:
        raise HTTPException(400, str(e))


# ---------- films: one JSON file each, shared by everyone who signs in ----------

FILMS = DATA / "films"
FILMS.mkdir(parents=True, exist_ok=True)
film_path = lambda fid: FILMS / f"{fid}.json" if fid.replace("-", "").isalnum() and len(fid) <= 64 else None

@app.get("/api/films")
def films_list(request: Request):
    user(request)
    films = [json.loads(p.read_text()) for p in FILMS.glob("*.json")]
    return {"films": sorted(films, key=lambda f: f.get("updatedAt", 0), reverse=True)}

@app.put("/api/films/{fid}")
def films_save(fid: str, body: dict, request: Request):
    who = user(request)
    p = film_path(fid)
    if not p or body.get("id") != fid:
        raise HTTPException(400, "That film id isn't valid.")
    raw = json.dumps({**body, "updatedAt": int(time.time() * 1000), "updatedBy": who})
    if len(raw) > 2_000_000:
        raise HTTPException(413, "This film is too large to save.")
    tmp = p.with_suffix(".tmp")
    tmp.write_text(raw)
    tmp.replace(p)  # never leave a half-written film behind
    return {"updatedAt": json.loads(raw)["updatedAt"]}

@app.delete("/api/films/{fid}")
def films_delete(fid: str, request: Request):
    user(request)
    p = film_path(fid)
    if p:
        p.unlink(missing_ok=True)
    return {}

@app.post("/api/clip")
def clip(body: dict, request: Request):
    user(request)
    shot, look = str(body.get("shot", ""))[:1500], str(body.get("look", ""))[:100]
    seconds = min(max(float(body.get("seconds", 5)), 1), 5)
    quality = "final" if body.get("quality") == "final" else "draft"
    job = submit("clip", lambda j: make_clip(j, shot, look, seconds, quality))
    return {"id": job["id"]}

@app.get("/api/clip/{job_id}")
def clip_status(job_id: str, request: Request):
    user(request)
    j = JOBS.get(job_id)
    if not j:
        raise HTTPException(404, "That render isn't known here. The server may have restarted; make the clip again.")
    return {"state": j["state"], "progress": j["progress"], "error": j["error"], "url": url_of(j["result"]) if j["result"] else None}

@app.post("/api/movie")
def movie(body: dict, request: Request):
    user(request)
    return {"url": url_of(run_now("movie", lambda j: build_movie(body.get("scenes", [])[:60])))}

@app.get("/files/{name}")
def files(name: str, request: Request):
    user(request)
    p = (FILES / name).resolve()
    if p.parent != FILES.resolve() or not p.is_file():
        raise HTTPException(404, "Not found.")
    return FileResponse(p)

PUBLIC = {".html", ".css", ".js", ".jpg", ".png", ".svg", ".mp4"}

@app.get("/")
def home():
    return RedirectResponse("/login.html")

@app.get("/{path:path}")
def static(path: str):
    p = (ROOT / path).resolve()
    inside = p.is_relative_to(ROOT) and not p.is_relative_to(ROOT / "server") and ".git" not in p.parts
    if not inside or p.suffix not in PUBLIC or not p.is_file():
        raise HTTPException(404, "Not found.")
    return FileResponse(p)


def adduser(email):
    pw = getpass.getpass(f"Password for {email}: ")
    if len(pw) < 10:
        sys.exit("Use at least 10 characters.")
    users = load_users()
    salt, h = hash_pw(pw)
    users[email.lower()] = {"salt": salt, "hash": h}
    USERS.write_text(json.dumps(users, indent=2))
    USERS.chmod(0o600)
    print(f"Saved {email}.")


if __name__ == "__main__":
    if sys.argv[1:2] == ["adduser"] and len(sys.argv) == 3:
        adduser(sys.argv[2])
        sys.exit()
    for lane in LANES:
        threading.Thread(target=worker, args=(lane,), daemon=True).start()
    threading.Thread(target=idle_watch, daemon=True).start()
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", "8000")), proxy_headers=True, forwarded_allow_ips="*")
