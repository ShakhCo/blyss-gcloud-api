import { z } from 'zod';

// Translate request schema
export const translateSchema = z.object({
    original_text: z.string({ required_error: 'original_text is required' })
        .min(1, 'original_text is required'),
    translate_to: z.enum(['uz', 'ru'], { required_error: 'translate_to is required' }),
    instruction: z.string().optional()
});

// Translate response schema (for OpenAI structured output)
export const TranslateResponse = z.object({
    translated_text: z.string()
});

// Validate request schema
export const validateTextSchema = z.object({
    text: z.string({ required_error: 'text is required' })
        .min(1, 'text is required'),
    instruction: z.string().optional()
});

// Validate response schema (for OpenAI structured output)
export const ValidateResponse = z.object({
    is_valid: z.boolean()
});
