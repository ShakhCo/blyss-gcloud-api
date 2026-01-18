import { z } from 'zod';

// Notification schema (for creating)
export const notificationSchema = z.object({
    title: z.string({ required_error: 'title is required' }).min(1, 'title is required'),
    description: z.string({ required_error: 'description is required' }).min(1, 'description is required'),
    type: z.string({ required_error: 'type is required' }).min(1, 'type is required'),
    phone_number: z.string({ required_error: 'phone_number is required' })
        .min(12, 'phone_number must be at least 12 digits')
        .regex(/^\d+$/, 'phone_number must contain only digits')
});

// Response schema
export const notificationResponseSchema = z.object({
    id: z.string(),
    title: z.string(),
    description: z.string(),
    type: z.string(),
    is_viewed: z.boolean(),
    viewed_at: z.string().nullable(),
    phone_number: z.string(),
    created_at: z.string()
});
