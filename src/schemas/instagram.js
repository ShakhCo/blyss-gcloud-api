import { z } from 'zod';

export const instagramAuthSchema = z.object({
    code: z.string({ required_error: 'code is required' })
        .min(1, 'code is required'),
    business_id: z.string({ required_error: 'business_id is required' })
        .min(1, 'business_id is required'),
});

export const instagramSettingsSchema = z.object({
    is_active: z.boolean().optional(),
    reply_template: z.string()
        .max(500, 'reply_template must be 500 characters or less')
        .optional(),
});
