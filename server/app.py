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

# Voice presets: Chatterbox has one built-in voice; these tune its delivery.
# Drop a 10-second sample at voices/<slug>.wav to clone a real voice for that preset.
PRESETS = {
    "Warm, low": dict(exaggeration=0.4, cfg_weight=0.5),
    "Bright, quick": dict(exaggeration=0.7, cfg_weight=0.3),
    "Older, gravel": dict(exaggeration=0.3, cfg_weight=0.6),
    "Soft, close": dict(exaggeration=0.25, cfg_weight=0.5),
}
slug = lambda s: "".join(c if c.isalnum() else "-" for c in s.lower()).strip("-")


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

JOBS = {}
WORK = queue.Queue()

def submit(kind, fn):
    job = {"id": uuid.uuid4().hex[:12], "kind": kind, "state": "queued", "progress": 0.0, "result": None, "error": None, "done": threading.Event()}
    JOBS[job["id"]] = job
    WORK.put((job, fn))
    return job

def worker():
    while True:
        job, fn = WORK.get()
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
        out = {"title": idea[:40], "cast": [{"name": "Ada"}, {"name": "Marcus"}],
               "scenes": [{"title": f"Scene {i + 1}", "shot": idea, "lines": [{"who": "Ada", "text": "Test line."}]} for i in range(n)]}
    else:
        prompt = (f"Write a short film of exactly {n} scenes, each about {dur} seconds on screen. Idea: {idea}\n"
                  f"Visual look: {look}.\nFor each scene give a short title, a one-paragraph shot description a video model "
                  f"can render (subject, action, setting, camera, light; no dialogue in it), and at most one or two short spoken "
                  f"lines that fit in {dur} seconds. Two to four characters. Title the film in five words or fewer.")
        r = post_json(f"{OLLAMA}/api/chat", {"model": LLM, "stream": False, "think": False, "format": SCRIPT_SCHEMA,
                                             "options": {"temperature": 0.8}, "keep_alive": 0,
                                             "messages": [{"role": "user", "content": prompt}]})
        out = json.loads(r["message"]["content"])
    names = list(PRESETS)
    cast = [{"name": c["name"], "voice": names[i % len(names)]} for i, c in enumerate(out["cast"][:4])]
    scenes, t = [], 0
    for s in out["scenes"][:n]:
        scenes.append({"id": uuid.uuid4().hex, "title": s["title"], "shot": s["shot"], "lines": s["lines"][:2], "start": t, "dur": dur})
        t += dur
    return {"title": out["title"], "cast": cast, "scenes": scenes}


# ---------- voices (Chatterbox) ----------

_tts = None
def tts():
    global _tts
    if _tts is None:
        from chatterbox.tts import ChatterboxTTS
        _tts = ChatterboxTTS.from_pretrained(device="cuda")
    return _tts

def make_voice(lines, cast):
    voice_of = {c["name"]: c.get("voice") for c in cast}
    out = FILES / f"{uuid.uuid4().hex}.wav"
    if FAKE:
        subprocess.run(["ffmpeg", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=330:duration=2", str(out)], check=True)
        return out
    import torch, torchaudio
    model = tts()
    parts = []
    for l in lines:
        preset = voice_of.get(l["who"]) or "Warm, low"
        ref = VOICES / f"{slug(preset)}.wav"
        wav = model.generate(l["text"], audio_prompt_path=str(ref) if ref.exists() else None, **PRESETS.get(preset, {}))
        parts += [wav, torch.zeros(1, int(model.sr * 0.3))]
    torchaudio.save(str(out), torch.cat(parts, dim=1), model.sr)
    return out


# ---------- clips (ComfyUI, Wan 2.2 TI2V 5B) ----------

NEGATIVE = "blurry, low quality, distorted faces, extra limbs, text, watermark, subtitles, static frame"

def wan_workflow(prompt, frames, seed):
    return {
        "1": {"class_type": "UNETLoader", "inputs": {"unet_name": "wan2.2_ti2v_5B_fp16.safetensors", "weight_dtype": "default"}},
        "2": {"class_type": "CLIPLoader", "inputs": {"clip_name": "umt5_xxl_fp8_e4m3fn_scaled.safetensors", "type": "wan", "device": "default"}},
        "3": {"class_type": "VAELoader", "inputs": {"vae_name": "wan2.2_vae.safetensors"}},
        "4": {"class_type": "ModelSamplingSD3", "inputs": {"model": ["1", 0], "shift": 8}},
        "5": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["2", 0], "text": prompt}},
        "6": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["2", 0], "text": NEGATIVE}},
        "7": {"class_type": "Wan22ImageToVideoLatent", "inputs": {"vae": ["3", 0], "width": 1280, "height": 704, "length": frames, "batch_size": 1}},
        "8": {"class_type": "KSampler", "inputs": {"model": ["4", 0], "positive": ["5", 0], "negative": ["6", 0], "latent_image": ["7", 0],
                                                    "seed": seed, "steps": 20, "cfg": 5, "sampler_name": "uni_pc", "scheduler": "simple", "denoise": 1}},
        "9": {"class_type": "VAEDecode", "inputs": {"samples": ["8", 0], "vae": ["3", 0]}},
        "10": {"class_type": "CreateVideo", "inputs": {"images": ["9", 0], "fps": 24}},
        "11": {"class_type": "SaveVideo", "inputs": {"video": ["10", 0], "filename_prefix": "moviegen/clip", "format": "mp4", "codec": "h264"}},
    }

CLIP_SECONDS_EXPECTED = 240  # ponytail: progress is time-based; read ComfyUI's websocket if a real bar matters

def make_clip(job, shot, look, seconds):
    frames = min(121, int(seconds * 24) + 1)
    out = FILES / f"{uuid.uuid4().hex}.mp4"
    if FAKE:
        subprocess.run(["ffmpeg", "-loglevel", "error", "-f", "lavfi", "-i", f"testsrc=size=640x352:rate=24:duration={seconds}",
                        "-pix_fmt", "yuv420p", str(out)], check=True)
        return out
    pid = post_json(f"{COMFY}/prompt", {"prompt": wan_workflow(f"{look}. {shot}", frames, secrets.randbelow(2**32))})["prompt_id"]
    t0 = time.time()
    while True:
        time.sleep(3)
        job["progress"] = min(0.95, (time.time() - t0) / CLIP_SECONDS_EXPECTED)
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
        if WORK.empty() and not any(j["state"] == "busy" for j in JOBS.values()) and time.time() - last_activity > IDLE_STOP_MIN * 60:
            print(f"idle for {IDLE_STOP_MIN} min, stopping the pod", flush=True)
            if stop_pod():
                return


# ---------- HTTP ----------

app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
url_of = lambda p: f"/files/{p.name}"

@app.middleware("http")
async def json_only_writes(request: Request, call_next):
    # A cross-site form can't send JSON, so this plus SameSite cookies blocks CSRF.
    if request.method == "POST" and request.url.path.startswith("/api/") and "application/json" not in request.headers.get("content-type", ""):
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

@app.post("/api/clip")
def clip(body: dict, request: Request):
    user(request)
    shot, look = str(body.get("shot", ""))[:1500], str(body.get("look", ""))[:100]
    seconds = min(max(float(body.get("seconds", 5)), 1), 5)
    job = submit("clip", lambda j: make_clip(j, shot, look, seconds))
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
    threading.Thread(target=worker, daemon=True).start()
    threading.Thread(target=idle_watch, daemon=True).start()
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", "8000")), proxy_headers=True, forwarded_allow_ips="*")
