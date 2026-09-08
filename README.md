# OBS Live Translated Subtitles (FR → EN)

Speak French into a mic; English subtitles appear in OBS, revising themselves
as you speak and locking when each phrase ends.
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
   You should see live transcript text while speaking.
2. In OBS: **Sources → + → Browser**, URL `http://localhost:3000/overlay`,
   size 1920×1080. Background is transparent.
3. Speak French. English appears within roughly half a second and revises
   itself as you keep talking, locking when each phrase ends.

## Notes

- Keys never leave the server; pages talk to `localhost:3000` only.
- Scribe is pinned to French (`SCRIBE_LANGUAGE`, default `fr`). Auto-detection
  was tried on real audio and hurt accuracy — 0.4 s segments give it too little
  audio to identify a language from, and a wrong guess corrupts the French
  before the translator sees it. Everything the mic hears is treated as French
  and translated; speak English and you will get English run through a
  French→English translator.
- Captions appear ~500 ms after speech: partial transcripts are translated
  with a streamed call and revise themselves in place, then lock when
  ElevenLabs' VAD commits the segment. Already-visible words can change until
  the segment locks — that is expected. The line never shrinks, so a revision
  reads as words changing rather than the subtitle retyping itself.
- `VAD_SILENCE_SECS` (default `0.4`) controls phrase length. Raise it for
  longer, calmer phrases; lower it for shorter, twitchier ones.
- Translation backend defaults, chosen for accuracy over raw speed:
  `OPENAI_API_KEY` → `gpt-4.1-mini`, `ANTHROPIC_API_KEY` → `claude-haiku-4-5`.
  `gpt-4.1-nano` is faster but noticeably less accurate on French idiom.
  Override with `TRANSLATOR`, `OPENAI_MODEL`, `ANTHROPIC_MODEL`.
- The server logs `ttft NNNms` per provisional translation and `translate
  NNNms` per locked segment, so you can A/B models by swapping
  `OPENAI_MODEL`/`ANTHROPIC_MODEL` and watching the numbers.
- `npm test` runs the unit tests (caption ordering, provider selection).
