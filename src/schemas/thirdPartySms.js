import { z } from 'zod';

export const thirdPartySendSmsSchema = z.object({
    phone_number: z.string({ required_error: 'phone_number is required' })
        .regex(/^998\d{9}$/, 'phone_number must be in format 998XXXXXXXXX'),
    message: z.string({ required_error: 'message is required' })
        .min(1, 'message must not be empty')
        .max(1000, 'message must be at most 1000 characters')
});
