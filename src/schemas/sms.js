import { z } from 'zod';

export const createTemplateSchema = z.object({
    example_text: z
        .string({ required_error: 'example_text is required' })
        .min(1, 'example_text must not be empty')
        .max(500, 'example_text must be at most 500 characters'),
});

export const sendCampaignSchema = z.object({
    template_id: z
        .string({ required_error: 'template_id is required' })
        .min(1, 'template_id must not be empty'),
    phone_numbers: z
        .array(z.string().regex(/^998\d{9}$/, 'phone must be in format 998XXXXXXXXX'))
        .min(1, 'phone_numbers must have at least 1 entry')
        .max(100, 'phone_numbers may not exceed 100 entries'),
});

export const listTemplatesQuerySchema = z.object({
    status: z.enum(['pending_moderation', 'confirmed', 'rejected']).optional(),
});

export const listCampaignsQuerySchema = z.object({
    cursor: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(50).optional().default(20),
});
