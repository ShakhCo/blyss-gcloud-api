import { z } from 'zod';

// Multilingual text schema
const multilingualSchema = z.object({
    uz: z.string({ required_error: 'uz is required' })
        .min(1, 'uz is required'),
    ru: z.string({ required_error: 'ru is required' })
        .min(1, 'ru is required')
});

// Service schema
export const serviceSchema = z.object({
    name: multilingualSchema,
    price: z.number({ required_error: 'price is required' })
        .positive('price must be positive')
        .refine(
            (val) => Number(val.toFixed(2)) === val,
            { message: 'price can have at most 2 decimal places' }
        ),
    duration_minutes: z.number({ required_error: 'duration_minutes is required' })
        .int('duration_minutes must be an integer')
        .positive('duration_minutes must be positive'),
    description: multilingualSchema.optional(),
    color: z.string()
        .regex(/^#[0-9A-Fa-f]{6}$/, 'color must be a valid hex color (e.g. #088395)')
        .optional()
        .default('#088395'),
    allow_employee_customization: z.boolean().optional().default(true),
    overwrite_employees_price: z.boolean().optional().default(false),
    overwrite_employees_duration: z.boolean().optional().default(false)
});

// Response schema
export const serviceResponseSchema = z.object({
    id: z.string(),
    name: z.string(),
    price: z.number(),
    duration_minutes: z.number(),
    is_active: z.boolean(),
    color: z.string(),
    allow_employee_customization: z.boolean(),
    business_id: z.string(),
    date_created: z.string()
});
