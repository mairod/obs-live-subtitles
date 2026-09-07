# OBS Live Translated Subtitles (FR → EN)

Speak French into a mic; English subtitles appear in OBS.
Pipeline: Chrome mic capture → ElevenLabs Scribe v2 Realtime (STT) →
LLM translation (OpenAI or Anthropic) → transparent overlay for OBS.

## Setup

1. Node ≥ 22, then `npm install`.
2. `cp .env.example .env` and fill in:
   - `ELEVENLABS_API_KEY` (required)
   - `OPENAI_API_KEY` **or** `ANTHROPIC_API_KEY` (translation)
3. `npm start`

## Use

1. Open `http://localhost:3000/capture` in Chrome → pick mic → **Start**.
   You should see live French text while speaking.
2. In OBS: **Sources → + → Browser**, URL `http://localhost:3000/overlay`,
   size 1920×1080. Background is transparent.
3. Speak French. English subtitles appear ~1–2 s after each sentence.

## Notes

- Keys never leave the server; pages talk to `localhost:3000` only.
- Translation backend defaults to the lowest-latency model on each side:
  `OPENAI_API_KEY` → `gpt-4.1-nano`, `ANTHROPIC_API_KEY` → `claude-haiku-4-5`.
  Override with `TRANSLATOR`, `OPENAI_MODEL`, `ANTHROPIC_MODEL`.
- The server logs `translate NNNms` per segment, so you can A/B models by
  swapping `OPENAI_MODEL`/`ANTHROPIC_MODEL` and watching the numbers.
- `npm test` runs the unit tests (caption ordering, provider selection).
