import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';

const SYSTEM =
  'You are a live subtitle translator for a conference stream. Translate the ' +
  'French text into natural, concise English. Output ONLY the translation — ' +
  'no quotes, no commentary. Earlier subtitles may be provided as context; ' +
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
  const client = new OpenAI({ apiKey: env.OPENAI_API_KEY });
  const model = env.OPENAI_MODEL || 'gpt-4.1-nano';
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
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
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
