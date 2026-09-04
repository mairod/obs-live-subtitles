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

export function makeTranslator(env = process.env) {
  const provider = pickProvider(env);

  if (provider === 'openai') {
    const client = new OpenAI({ apiKey: env.OPENAI_API_KEY });
    const model = env.OPENAI_MODEL || 'gpt-4o-mini';
    return async (frText, context) => {
      const res = await client.chat.completions.create({
        model,
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: userMessage(frText, context) },
        ],
      });
      return res.choices[0].message.content.trim();
    };
  }

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const model = env.ANTHROPIC_MODEL || 'claude-opus-4-8';
  return async (frText, context) => {
    const res = await client.messages.create({
      model,
      max_tokens: 1024,
      system: SYSTEM,
      messages: [{ role: 'user', content: userMessage(frText, context) }],
    });
    const block = res.content.find((b) => b.type === 'text');
    if (!block) throw new Error('Anthropic: no text block in response');
    return block.text.trim();
  };
}
