import { z } from 'zod';

// Input schema (for registration)
export const userSchema = z.object({
    first_name: z.string().min(1, 'first_name is required'),
    last_name: z.string().default(''),
    phone_number: z.string().min(13, 'phone_number is required'),
    telegram_id: z.number({ required_error: 'telegram_id is required' }).positive('telegram_id must be positive')
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
