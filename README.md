# MovieGenAI

A private film studio that runs on your own GPU. Describe a film in a sentence, and MovieGenAI writes the script, voices every character and turns each scene into a video clip, then stitches the clips into one movie.

It uses open models instead of paid credit-based sites, so the only cost is the GPU time you actually use.

## How it works

| Step | Model | Runs on |
| --- | --- | --- |
| Script and dialogue | Qwen3 via Ollama | GPU server |
| Voices | Chatterbox (MIT) or Dia (Apache 2.0) | GPU server |
| Video clips | Wan 2.2 via ComfyUI (Apache 2.0) | GPU server |
| Final movie | ffmpeg | GPU server |

The GPU server is an on-demand Runpod pod with an RTX 4090 or 5090. The models live on a network volume, so they download once. The pod is switched on when it's needed and stopped afterwards.

## Status

The front end is done and runs in **demo mode**: every call in `api.js` is a placeholder, so you can click through the whole flow without a GPU. The GPU server is next.

## Run it locally

No build step. Serve the folder with any static server, for example:

```bash
npx serve .
```

Then open `login.html`. In demo mode any email and password sign in.

## Files

| File | What it is |
| --- | --- |
| `login.html`, `login.css` | Landing page and sign-in |
| `index.html`, `app.css`, `app.js` | The studio: films, script, cast, scenes, timeline, movie player |
| `api.js` | The only link between the screen and the GPU server; lists the server endpoints |
| `tokens.css`, `base.css` | Colours, type and shared base styles |
| `assets/` | Landing page photos and footage |

## Security

The sign-in page only routes people. The real protection is the server: it checks the password and rejects every script, voice and clip request without a valid session. Never commit API keys; set them as Runpod secrets.

## Credits

Photographs and footage on the landing page are from [Pexels](https://www.pexels.com) under the Pexels License: video by cottonbro studio and dabatepatvideos; photographs by Min An, Nishant Ghosh, Andrea Prochilo, Johannes Plenio, Aleson Padilha and Alexey Demidov.
