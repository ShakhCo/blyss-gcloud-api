import { z } from 'zod';

export const instagramAuthSchema = z.object({
    code: z.string({ required_error: 'code is required' })
        .min(1, 'code is required'),
    business_id: z.string({ required_error: 'business_id is required' })
        .min(1, 'business_id is required'),
});

export const instagramSettingsSchema = z.object({
    is_active: z.boolean().optional(),
    reply_mode: z.enum(['static', 'ai']).optional(),
    reply_template: z.string()
        .max(500, 'reply_template must be 500 characters or less')
        .optional(),
    ai_instructions: z.string()
        .max(1000, 'ai_instructions must be 1000 characters or less')
        .optional(),
    ai_example_replies: z.string()
        .max(1500, 'ai_example_replies must be 1500 characters or less')
        .optional(),
});
