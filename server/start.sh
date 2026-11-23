#!/usr/bin/env bash
# Starts MovieGenAI's services at every pod boot. The pod's start command runs this beside the
# template's own /start.sh:
#   (bash /workspace/movie-gen-ai/server/start.sh > /workspace/logs/start.log 2>&1) & exec /start.sh
# Everything listens inside the pod only; the MovieGenAI server (port 8000) is the one door in.
set -uo pipefail
W=/workspace
LOG=$W/logs
mkdir -p "$LOG" "$W/outputs"
echo "start.sh at $(date -u)"

# Tools the container disk loses on every stop
command -v ffmpeg >/dev/null && command -v espeak-ng >/dev/null || { apt-get update -qq && apt-get install -y -qq ffmpeg espeak-ng >/dev/null; }

# Latest code
cd "$W/movie-gen-ai" && git pull -q || echo "git pull failed, using the code on the volume"

# Ollama (scripts)
export OLLAMA_MODELS=$W/ollama/models OLLAMA_HOST=127.0.0.1:11434 OLLAMA_KEEP_ALIVE=0
pgrep -f "ollama serve" >/dev/null || nohup "$W/ollama/bin/ollama" serve > "$LOG/ollama.log" 2>&1 &

# ComfyUI (video). The template starts it with the arguments in runpod-slim/comfyui_args.txt,
# which point it at our models and output folder. Wait for it instead of starting a second one.
ARGS=$W/runpod-slim/comfyui_args.txt
cat > "$W/models/extra_model_paths.yaml" <<EOF
moviegen:
  base_path: $W/models
  diffusion_models: diffusion_models
  text_encoders: text_encoders
  vae: vae
  audio_encoders: audio_encoders
EOF
grep -q "extra-model-paths-config" "$ARGS" 2>/dev/null || printf '%s\n' "--extra-model-paths-config $W/models/extra_model_paths.yaml" "--output-directory $W/outputs" >> "$ARGS"
for i in $(seq 1 60); do curl -fs http://127.0.0.1:8188/ >/dev/null && break; sleep 5; done
if ! curl -fs http://127.0.0.1:8188/ >/dev/null; then
  echo "ComfyUI didn't come up from the template; starting it"
  C=$W/runpod-slim/ComfyUI
  (cd "$C" && nohup "$C/.venv-cu128/bin/python" main.py --listen 127.0.0.1 --port 8188 $(grep -v '^#' "$ARGS" | tr '\n' ' ') > "$LOG/comfyui.log" 2>&1 &)
fi

# MovieGenAI server (it stops the pod after 30 idle minutes)
pgrep -f "movie-gen-ai/server/app.py" >/dev/null || HF_HOME=$W/hf COMFY_OUTPUT=$W/outputs nohup "$W/venvs/tts/bin/python" "$W/movie-gen-ai/server/app.py" > "$LOG/server.log" 2>&1 &

echo "ready at $(date -u): ollama :11434, comfyui :8188, moviegen :8000"
