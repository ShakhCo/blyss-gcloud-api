import { z } from 'zod';

// Description schema (multilingual)
const descriptionSchema = z.object({
    uz: z.string({ required_error: 'uz description is required' })
        .min(1, 'uz description is required'),
    ru: z.string({ required_error: 'ru description is required' })
        .min(1, 'ru description is required')
});

// Service schema
export const serviceSchema = z.object({
    name: z.string({ required_error: 'name is required' })
        .min(1, 'name is required'),
    price: z.number({ required_error: 'price is required' })
        .positive('price must be positive')
        .refine(
            (val) => Number(val.toFixed(2)) === val,
            { message: 'price can have at most 2 decimal places' }
        ),
    duration_minutes: z.number({ required_error: 'duration_minutes is required' })
        .int('duration_minutes must be an integer')
        .positive('duration_minutes must be positive'),
    description: descriptionSchema
});

// Response schema
export const serviceResponseSchema = z.object({
    id: z.string(),
    name: z.string(),
    price: z.number(),
    duration_minutes: z.number(),
    is_active: z.boolean(),
    business_id: z.string(),
    date_created: z.string()
});
