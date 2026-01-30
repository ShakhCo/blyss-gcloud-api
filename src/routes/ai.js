import { Router } from 'express';
import OpenAI from 'openai';
import { zodTextFormat } from 'openai/helpers/zod';
import { validate } from '../middleware/validate.js';
import { authenticate } from '../middleware/authenticate.js';
import { translateSchema, TranslateResponse } from '../schemas/ai.js';

const router = Router();

const openai = new OpenAI();

// Translate text
router.post('/translate', authenticate, validate(translateSchema), async (req, res) => {
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
        res.status(500).json({ error: error.message, error_code: 'INTERNAL_ERROR' });
    }
});

export default router;
