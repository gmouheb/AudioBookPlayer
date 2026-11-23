# Narrate backend

FastAPI + Kokoro TTS server. See ../PLAN.md.

- Run locally: `uv run narrate` (data in ./data, or set NARRATE_DATA)
- Run in a container: `podman compose up` from the repo root
- Inspect extraction: `uv run python scripts/extract_cli.py BOOK`
- Time TTS: `uv run python scripts/tts_bench.py BOOK`
