import { z } from 'zod';

// Employee schema (for adding to business)
export const employeeSchema = z.object({
    first_name: z.string({ required_error: 'first_name is required' })
        .min(1, 'first_name is required'),
    last_name: z.string({ required_error: 'last_name is required' })
        .min(1, 'last_name is required'),
    phone_number: z.string({ required_error: 'phone_number is required' })
        .min(12, 'phone_number must be at least 12 digits')
        .regex(/^\d+$/, 'phone_number must contain only digits')
});

// Response schema
export const employeeResponseSchema = z.object({
    id: z.string(),
    business_id: z.string(),
    business_owner_id: z.string(),
    first_name: z.string(),
    last_name: z.string(),
    phone_number: z.string(),
    telegram_id: z.number().nullable(),
    is_confirmed_by_employee: z.boolean(),
    date_created: z.string()
});
