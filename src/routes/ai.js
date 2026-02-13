import { Router } from 'express';
import OpenAI from 'openai';
import { zodTextFormat } from 'openai/helpers/zod';
import { validate } from '../middleware/validate.js';
import { authenticate } from '../middleware/authenticate.js';
import { translateSchema, TranslateResponse, validateTextSchema, ValidateResponse } from '../schemas/ai.js';

const router = Router();

let openai = null;
if (process.env.OPENAI_API_KEY) {
    openai = new OpenAI();
} else {
    console.warn('WARNING: OPENAI_API_KEY not set - AI routes will be disabled');
}

// Translate text
router.post('/translate', authenticate, validate(translateSchema), async (req, res) => {
    if (!openai) {
        return res.status(503).json({ error: 'AI service not configured', error_code: 'SERVICE_UNAVAILABLE' });
    }
    try {
        const { original_text, translate_to, instruction } = req.validated;

        const languageNames = {
            uz: 'Uzbek',
            ru: 'Russian'
        };

        const targetLanguage = languageNames[translate_to];

        let systemPrompt = `You are a professional translator. Translate the given text to ${targetLanguage}. Only return the translated text, nothing else.`;

        if (instruction) {
            systemPrompt += ` Additional instruction: ${instruction}`;
        }

        const response = await openai.responses.parse({
            model: 'gpt-4o-2024-08-06',
            input: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: original_text }
            ],
            text: {
                format: zodTextFormat(TranslateResponse, 'translation')
            }
        });

        const result = response.output_parsed;

        res.json({
            original_text,
            translated_text: result.translated_text,
            translate_to
        });
    } catch (error) {
        console.error(error); res.status(500).json({ error: 'Internal server error', error_code: 'INTERNAL_ERROR' });
    }
});

// Validate text
router.post('/validate', authenticate, validate(validateTextSchema), async (req, res) => {
    if (!openai) {
        return res.status(503).json({ error: 'AI service not configured', error_code: 'SERVICE_UNAVAILABLE' });
    }
    try {
        const { text, instruction } = req.validated;

        let systemPrompt = 'You are a content validator. Analyze the given text and determine if it is valid. Return true if the text is appropriate, meaningful, and not spam/gibberish. Return false otherwise.';

        if (instruction) {
            systemPrompt = `You are a content validator. ${instruction}`;
        }

        const response = await openai.responses.parse({
            model: 'gpt-4o-2024-08-06',
            input: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: text }
            ],
            text: {
                format: zodTextFormat(ValidateResponse, 'validation')
            }
        });

        const result = response.output_parsed;

        res.json({
            text,
            is_valid: result.is_valid
        });
    } catch (error) {
        console.error(error); res.status(500).json({ error: 'Internal server error', error_code: 'INTERNAL_ERROR' });
    }
});

export default router;
