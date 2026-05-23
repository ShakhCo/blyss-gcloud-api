import OpenAI from 'openai';

let client = null;
function getClient() {
    if (!process.env.OPENAI_API_KEY) {
        const err = new Error('OpenAI not configured');
        err.code = 'AI_UNAVAILABLE';
        throw err;
    }
    if (!client) client = new OpenAI();
    return client;
}

const SYSTEM_PROMPT = `You polish SMS marketing messages for Uzbek barbershops and salons sending via the Eskiz SMS gateway. Output ONE message body, plain text, no more than 160 characters total, no emojis, no URLs, no phone numbers other than the business's own, no all-caps shouting. Preserve the user's language (Uzbek/Russian/mixed) and intent. Append "BLYSS" on its own line at the end if not already present. Return only the polished message, no preamble.`;

const URL_REGEX = /\b(https?:\/\/|www\.)\S+|\b[\w-]+\.(com|uz|ru|net|org|io|app)(\/|:|\?|#)\S*/i;

export function _validatePolishedOutput(text) {
    const trimmed = (text || '').trim();
    if (trimmed.length === 0) {
        const err = new Error('empty: Polished message is empty');
        err.code = 'AI_OUTPUT_INVALID';
        err.rule = 'empty';
        throw err;
    }
    if (trimmed.length > 160) {
        const err = new Error(`too_long: Polished message exceeds 160 chars (${trimmed.length})`);
        err.code = 'AI_OUTPUT_INVALID';
        err.rule = 'too_long';
        throw err;
    }
    if (URL_REGEX.test(trimmed)) {
        const err = new Error('no_urls: Polished message contains a URL');
        err.code = 'AI_OUTPUT_INVALID';
        err.rule = 'no_urls';
        throw err;
    }
}

export async function polishSmsText(exampleText) {
    const openai = getClient();
    const response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        temperature: 0.3,
        max_tokens: 200,
        messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: exampleText },
        ],
    });
    const text = response.choices?.[0]?.message?.content ?? '';
    _validatePolishedOutput(text);
    return text.trim();
}
