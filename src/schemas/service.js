import { z } from 'zod';

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
        .positive('duration_minutes must be positive')
});

// Response schema
export const serviceResponseSchema = z.object({
    id: z.string(),
    name: z.string(),
    price: z.number(),
    duration_minutes: z.number(),
    business_id: z.string(),
    date_created: z.string()
});
