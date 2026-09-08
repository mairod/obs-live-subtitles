import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';

// The speaker code-switches, and a per-segment language flag can't label a
// half-French sentence — so the model decides per segment instead.
const SYSTEM =
  'You produce English subtitles for a live conference stream. The speaker is ' +
  'mostly French but switches to English mid-talk. Translate French into ' +
  'natural, accurate English. Preserve every detail — never summarise, ' +
  'compress, or omit. The text is often an unfinished sentence: translate ' +
  'only what is there and never guess how it ends. If the text is already ' +
  'English, output it unchanged. For mixed sentences, translate only the ' +
  'French parts. Output ONLY the subtitle line — no quotes, no commentary, ' +
  'no notes about the language. Earlier subtitles may be provided as context; ' +
  'do not re-translate them.';

export function pickProvider(env) {
  if (env.TRANSLATOR) {
    if (!['openai', 'anthropic'].includes(env.TRANSLATOR)) {
      throw new Error(`Invalid TRANSLATOR "${env.TRANSLATOR}": use "openai" or "anthropic"`);
    }
    return env.TRANSLATOR;
  }
  if (env.OPENAI_API_KEY) return 'openai';
  if (env.ANTHROPIC_API_KEY) return 'anthropic';
  throw new Error('Set OPENAI_API_KEY or ANTHROPIC_API_KEY in .env');
}

function userMessage(frText, context) {
  const ctx = context.length ? `Previous subtitles:\n${context.join('\n')}\n\n` : '';
  return `${ctx}Translate to English:\n${frText}`;
}

// A subtitle is one sentence. Capping output stops a rambling model from
// stalling the queue; temperature 0 keeps repeated phrases consistent.
const MAX_TOKENS = 200;

export function makeTranslator(env = process.env) {
  const provider = pickProvider(env);
  const call = provider === 'openai' ? openaiTranslator(env) : anthropicTranslator(env);

  // ponytail: stderr timing beats a metrics stack — you need the ms to pick a model.
  return async (frText, context) => {
    const t0 = performance.now();
    const en = await call(frText, context);
    console.error(`translate ${Math.round(performance.now() - t0)}ms`);
    return en;
  };
}

function openaiTranslator(env) {
  // Vendor defaults are batch-tuned (600 s, 2 retries) — fatal on a 350 ms
  // caption budget where a stall parks the whole lane. 8 s for the non-streaming
  // path; streaming clients get 4 s below. maxRetries: 0 — a retry on a stale
  // caption triples the stall for zero benefit.
  const client = new OpenAI({ apiKey: env.OPENAI_API_KEY, timeout: 8000, maxRetries: 0 });
  const model = env.OPENAI_MODEL || 'gpt-4.1-mini';
  return async (frText, context) => {
    const res = await client.chat.completions.create({
      model,
      max_completion_tokens: MAX_TOKENS,
      temperature: 0,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: userMessage(frText, context) },
      ],
    });
    const content = res.choices[0].message.content;
    if (!content) throw new Error('OpenAI: empty response');
    return content.trim();
  };
}

function anthropicTranslator(env) {
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, timeout: 8000, maxRetries: 0 });
  const model = env.ANTHROPIC_MODEL || 'claude-haiku-4-5';
  return async (frText, context) => {
    const res = await client.messages.create({
      model,
      max_tokens: MAX_TOKENS,
      temperature: 0,
      system: SYSTEM,
      messages: [{ role: 'user', content: userMessage(frText, context) }],
    });
    const block = res.content.find((b) => b.type === 'text');
    if (!block) throw new Error('Anthropic: no text block in response');
    return block.text.trim();
  };
}

// Streaming variant for the provisional lane: the screen updates at
// time-to-first-token instead of time-to-completion. onToken receives the
// accumulated text so consumers never reassemble deltas.
export function makeStreamingTranslator(env = process.env) {
  const provider = pickProvider(env);
  return provider === 'openai' ? openaiStream(env) : anthropicStream(env);
}

function openaiStream(env) {
  const client = new OpenAI({ apiKey: env.OPENAI_API_KEY, timeout: 4000, maxRetries: 0 });
  const model = env.OPENAI_MODEL || 'gpt-4.1-mini';
  return async (frText, context, onToken, signal) => {
    const t0 = performance.now(); // before the request: ttft must include the round-trip
    const stream = await client.chat.completions.create(
      {
        model,
        max_completion_tokens: MAX_TOKENS,
        temperature: 0,
        stream: true,
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: userMessage(frText, context) },
        ],
      },
      { signal },
    );
    let text = '';
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content;
      if (delta) {
        if (!text) console.error(`ttft ${Math.round(performance.now() - t0)}ms`);
        text += delta;
        onToken(text);
      }
    }
    return text.trim();
  };
}

function anthropicStream(env) {
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, timeout: 4000, maxRetries: 0 });
  const model = env.ANTHROPIC_MODEL || 'claude-haiku-4-5';
  return async (frText, context, onToken, signal) => {
    const t0 = performance.now(); // before the request: ttft must include the round-trip
    const stream = await client.messages.create(
      {
        model,
        max_tokens: MAX_TOKENS,
        temperature: 0,
        stream: true,
        system: SYSTEM,
        messages: [{ role: 'user', content: userMessage(frText, context) }],
      },
      { signal },
    );
    let text = '';
    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        const delta = event.delta.text;
        if (!text) console.error(`ttft ${Math.round(performance.now() - t0)}ms`);
        text += delta;
        onToken(text);
      }
    }
    return text.trim();
  };
}
