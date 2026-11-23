"""End-to-end check of server/app.py with fake models (no GPU, needs ffmpeg).

    MOVIEGEN_FAKE=1 python server/selftest.py
"""
import http.cookiejar, json, os, subprocess, sys, tempfile, time, urllib.error, urllib.request
from pathlib import Path

data = tempfile.mkdtemp()
env = {**os.environ, "MOVIEGEN_FAKE": "1", "MOVIEGEN_DATA": data, "PORT": "8765"}
here = Path(__file__).parent
sys.path.insert(0, str(here))
os.environ.update(env)
import app  # noqa: E402  (reads MOVIEGEN_DATA at import)

salt, h = app.hash_pw("correct horse battery")
app.USERS.write_text(json.dumps({"test@example.test": {"salt": salt, "hash": h}}))

srv = subprocess.Popen([sys.executable, str(here / "app.py")], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
base = "http://localhost:8765"
jar = http.cookiejar.CookieJar()
op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))

def req(path, body=None, ctype="application/json", opener=op, method=None):
    data = None if body is None else (json.dumps(body).encode() if ctype == "application/json" else body)
    r = urllib.request.Request(base + path, data, {"Content-Type": ctype} if data is not None else {}, method=method)
    try:
        with opener.open(r, timeout=60) as resp:
            raw = resp.read()
            return resp.status, (json.loads(raw) if resp.headers.get_content_type() == "application/json" else raw)
    except urllib.error.HTTPError as e:
        return e.code, e.read()

try:
    for _ in range(50):
        try:
            urllib.request.urlopen(base + "/login.html", timeout=1); break
        except Exception:
            time.sleep(0.2)

    assert req("/login.html")[0] == 200
    assert req("/server/app.py")[0] == 404, "server code must not be served"
    assert req("/api/me")[0] == 401, "API needs a session"
    assert req("/api/login", b"email=x", "application/x-www-form-urlencoded")[0] == 415, "form posts are refused (CSRF)"
    assert req("/api/login", {"email": "test@example.test", "password": "wrong"})[0] == 401

    s, r = req("/api/login", {"email": "TEST@example.test", "password": "correct horse battery"})
    assert s == 200 and r["email"] == "test@example.test", r
    assert req("/api/me")[1]["email"] == "test@example.test"
    assert req("/api/gpu")[1]["state"] == "running"

    s, vs = req("/api/voices")
    ids = [v["id"] for v in vs["voices"]]
    assert "kokoro:af_heart" in ids and "cb:default" in ids, ids
    assert req("/api/voice/sample", {"voice": "cb:../../users"})[0] == 400, "unknown voices are refused"
    s, smp = req("/api/voice/sample", {"voice": "kokoro:bm_george"})
    assert s == 200 and smp["url"].endswith(".wav"), smp

    # films are saved on the server and shared
    fid = "0b9c1a2e-1111-4a4a-9f9f-123456789abc"
    s, sv = req(f"/api/films/{fid}", {"id": fid, "title": "Test film", "scenes": []}, method="PUT")
    assert s == 200 and sv["updatedAt"], sv
    assert any(f["id"] == fid and f["title"] == "Test film" for f in req("/api/films")[1]["films"])
    assert req("/api/films/..%2Fusers", {"id": "../users"}, method="PUT")[0] != 200, "no writing outside films/"
    req(f"/api/films/{fid}", method="DELETE")
    assert not req("/api/films")[1]["films"]

    # a cloned voice joins the list with its tags; consent is required
    wav = subprocess.run(["ffmpeg", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=220:duration=3", "-f", "wav", "-"], capture_output=True, check=True).stdout
    def multipart(fields, file):
        b = "----mgtest"
        parts = [f'--{b}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode() for k, v in fields.items()]
        parts.append(f'--{b}\r\nContent-Disposition: form-data; name="file"; filename="v.wav"\r\nContent-Type: audio/wav\r\n\r\n'.encode() + file + b"\r\n")
        return b"".join(parts) + f"--{b}--\r\n".encode(), f"multipart/form-data; boundary={b}"
    body, ct = multipart({"name": "Grandad", "gender": "man", "age": "older"}, wav)
    assert req("/api/voices/clone", body, ct)[0] == 400, "consent is required"
    body, ct = multipart({"name": "Grandad", "gender": "man", "age": "older", "consent": "yes"}, wav)
    s, cl = req("/api/voices/clone", body, ct)
    assert s == 200 and cl["id"] == "cb:grandad", cl
    g = next(v for v in req("/api/voices")[1]["voices"] if v["id"] == "cb:grandad")
    assert g["gender"] == "man" and g["age"] == "older", g

    s, film = req("/api/script", {"idea": "A keeper finds a letter.", "seconds": 12, "look": "Night"})
    assert s == 200 and len(film["scenes"]) == 3 and film["scenes"][1]["start"] == film["scenes"][0]["dur"], film

    for sc in film["scenes"]:
        s, v = req("/api/voice", {"lines": sc["lines"], "cast": film["cast"]})
        assert s == 200 and v["url"].endswith(".wav"), v
        sc["voiceUrl"] = v["url"]
        s, j = req("/api/clip", {"shot": sc["shot"], "look": "Night", "seconds": sc["dur"]})
        while True:
            s, st = req(f"/api/clip/{j['id']}")
            if st["state"] in ("done", "error"): break
            time.sleep(0.3)
        assert st["state"] == "done", st
        sc["clipUrl"] = st["url"]

    s, m = req("/api/movie", {"scenes": [{"clipUrl": x["clipUrl"], "voiceUrl": x["voiceUrl"]} for x in film["scenes"]]})
    assert s == 200, m
    s, mp4 = req(m["url"])
    assert s == 200 and mp4[4:8] == b"ftyp", "movie is an mp4"
    assert req("/files/..%2Fusers.json")[0] == 404, "no path traversal"
    assert req("/api/movie", {"scenes": [{"clipUrl": "/files/../users.json"}]})[0] == 500
    assert req(m["url"], opener=urllib.request.build_opener())[0] == 401, "files need a session"

    req("/api/logout", {})
    assert req("/api/me")[0] == 401
    print("selftest ok")
finally:
    srv.terminate()
