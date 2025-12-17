import { z } from 'zod';

// Input schema (for registration)
export const userSchema = z.object({
    first_name: z.string({ required_error: 'first_name is required' }).min(1, 'first_name is required'),
    last_name: z.string().default(''),
    phone_number: z.string({ required_error: 'phone_number is required' }).regex(/^\d+$/, 'phone_number must contain only digits').min(13, 'phone_number must be at least 13 digits'),
    telegram_id: z.coerce.number({ required_error: 'telegram_id is required', invalid_type_error: 'telegram_id must be a number' }).positive('telegram_id must be positive')
});

// Output schema (for responses)
export const userResponseSchema = z.object({
    id: z.string(),
    first_name: z.string(),
    last_name: z.string(),
    phone_number: z.string(),
    telegram_id: z.number(),
    is_verified: z.boolean()
});
