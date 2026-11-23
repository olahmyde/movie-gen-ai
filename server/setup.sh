#!/usr/bin/env bash
# One-time install of everything MovieGenAI needs, onto the network volume at /workspace.
# Safe to re-run: anything already on the volume is skipped, and half-finished downloads resume.
# Run inside the pod:  bash /workspace/movie-gen-ai/server/setup.sh
set -euo pipefail

W=/workspace
M=$W/models
LOG=$W/logs
mkdir -p "$M"/{diffusion_models,text_encoders,vae,audio_encoders,loras} "$W"/ollama/models "$W"/hf "$LOG"

step() { echo; echo "== $* =="; }

# 1. System tools the image may lack (container disk; cheap to redo after a stop)
step "system tools"
command -v zstd >/dev/null && command -v ffmpeg >/dev/null || { apt-get update -qq && apt-get install -y -qq zstd ffmpeg >/dev/null; }

# 2. Wan 2.2 video models (Comfy-Org repackaged, public; about 35 GB)
step "Wan 2.2 models"
WAN=https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/main/split_files
dl() { # dl <path under split_files> <models subfolder>
  local out="$M/$2/$(basename "$1")"
  if [ -s "$out" ]; then echo "have $(basename "$1")"; return; fi
  curl -fsSL --retry 5 -C - -o "$out.part" "$WAN/$1" && mv "$out.part" "$out" && echo "got $(basename "$1")"
}
dl diffusion_models/wan2.2_ti2v_5B_fp16.safetensors        diffusion_models &  # scenes: text or image to video, 720p
dl diffusion_models/wan2.2_s2v_14B_fp8_scaled.safetensors  diffusion_models &  # talking scenes: voice + image to video
dl text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors    text_encoders &
dl vae/wan2.2_vae.safetensors                              vae &
dl vae/wan_2.1_vae.safetensors                             vae &
dl audio_encoders/wav2vec2_large_english_fp16.safetensors  audio_encoders &
dl loras/wan2.2_t2v_lightx2v_4steps_lora_v1.1_high_noise.safetensors loras &  # 4-step lip-sync
wait

# 2b. Z-Image Turbo for character faces (about 21 GB)
step "Z-Image Turbo"
ZI=https://huggingface.co/Comfy-Org/z_image_turbo/resolve/main/split_files
zdl() { local out="$M/$2/$(basename "$1")"; [ -s "$out" ] && { echo "have $(basename "$1")"; return; }; curl -fsSL --retry 5 -C - -o "$out.part" "$ZI/$1" && mv "$out.part" "$out"; }
zdl diffusion_models/z_image_turbo_bf16.safetensors diffusion_models &
zdl text_encoders/qwen_3_4b.safetensors text_encoders &
zdl vae/ae.safetensors vae &
wait

# 3. Ollama + Qwen3 for scripts (binary and models both live on the volume)
step "Ollama + Qwen3"
if [ ! -x "$W/ollama/bin/ollama" ]; then
  curl -fsSL https://ollama.com/download/ollama-linux-amd64.tar.zst | zstd -d | tar -x -C "$W/ollama"
fi
export OLLAMA_MODELS=$W/ollama/models
pgrep -f "ollama serve" >/dev/null || { nohup "$W/ollama/bin/ollama" serve > "$LOG/ollama.log" 2>&1 & sleep 5; }
"$W/ollama/bin/ollama" pull qwen3:14b

# 4. Chatterbox voices, in its own Python env (it pins torch 2.6)
step "Chatterbox"
if [ ! -x "$W/venvs/tts/bin/python" ]; then
  python3 -m venv "$W/venvs/tts"
  "$W/venvs/tts/bin/pip" install -q --upgrade pip
  # setuptools<81: Chatterbox's watermark library still imports pkg_resources
  "$W/venvs/tts/bin/pip" install -q chatterbox-tts fastapi uvicorn python-multipart "setuptools<81"
fi
HF_HOME=$W/hf "$W/venvs/tts/bin/python" -c "from chatterbox.tts import ChatterboxTTS; ChatterboxTTS.from_pretrained(device='cuda'); print('chatterbox weights ready')"

# 5. The MovieGenAI code (the server serves the front end from here)
step "MovieGenAI code"
[ -d "$W/movie-gen-ai/.git" ] || git clone -q https://github.com/olahmyde/movie-gen-ai.git "$W/movie-gen-ai"

step "done"
du -sh "$M" "$W/ollama" "$W/venvs" "$W/hf" 2>/dev/null
