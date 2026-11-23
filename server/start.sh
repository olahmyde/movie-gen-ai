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

# ComfyUI (video): point it at the models on the volume
COMFY=$(dirname "$(find / -maxdepth 5 -name main.py -path '*ComfyUI/main.py' 2>/dev/null | head -1)")
cat > "$COMFY/extra_model_paths.yaml" <<EOF
moviegen:
  base_path: $W/models
  diffusion_models: diffusion_models
  text_encoders: text_encoders
  vae: vae
  audio_encoders: audio_encoders
EOF
pgrep -f "ComfyUI/main.py" >/dev/null || (cd "$COMFY" && nohup python main.py --listen 127.0.0.1 --port 8188 --output-directory "$W/outputs" > "$LOG/comfyui.log" 2>&1 &)

echo "ollama :11434, comfyui :8188 ($COMFY). Logs in $LOG"
