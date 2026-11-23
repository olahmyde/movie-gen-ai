#!/usr/bin/env bash
# Start the model services after every pod boot. Everything listens on localhost only;
# the MovieGenAI server (port 8000) is the one door in, behind its password.
set -euo pipefail
W=/workspace
LOG=$W/logs
mkdir -p "$LOG"

command -v ffmpeg >/dev/null || { apt-get update -qq && apt-get install -y -qq ffmpeg >/dev/null; }

# Ollama (scripts)
export OLLAMA_MODELS=$W/ollama/models OLLAMA_HOST=127.0.0.1:11434 OLLAMA_KEEP_ALIVE=0
pgrep -f "ollama serve" >/dev/null || nohup "$W/ollama/bin/ollama" serve > "$LOG/ollama.log" 2>&1 &

# ComfyUI (video). The Runpod template starts it at every boot with the extra arguments in
# runpod-slim/comfyui_args.txt, so our model folder and output folder go there. Its port
# 8188 is not exposed outside the pod.
COMFY=$W/runpod-slim/ComfyUI
ARGS=$W/runpod-slim/comfyui_args.txt
cat > "$W/models/extra_model_paths.yaml" <<EOF
moviegen:
  base_path: $W/models
  diffusion_models: diffusion_models
  text_encoders: text_encoders
  vae: vae
  audio_encoders: audio_encoders
EOF
mkdir -p "$W/outputs"
if ! grep -q "extra-model-paths-config" "$ARGS" 2>/dev/null; then
  printf '%s\n' "--extra-model-paths-config $W/models/extra_model_paths.yaml" "--output-directory $W/outputs" >> "$ARGS"
  # First time only: restart the template's ComfyUI so it picks the arguments up.
  pkill -f "main.py --listen" || true; sleep 3
fi
pgrep -f "main.py --listen" >/dev/null || (cd "$COMFY" && nohup python main.py --listen 127.0.0.1 --port 8188 $(grep -v '^#' "$ARGS" | tr '\n' ' ') > "$LOG/comfyui.log" 2>&1 &)

# MovieGenAI server (the only public port; it auto-stops the pod after 30 idle minutes)
cd "$W/movie-gen-ai" && git pull -q || true
pgrep -f "server/app.py" >/dev/null || HF_HOME=$W/hf COMFY_OUTPUT=$W/outputs nohup "$W/venvs/tts/bin/python" "$W/movie-gen-ai/server/app.py" > "$LOG/server.log" 2>&1 &

echo "ollama :11434, comfyui :8188 ($COMFY), moviegen :8000. Logs in $LOG"
