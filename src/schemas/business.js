import { z } from 'zod';

// Business status enum
export const businessStatusEnum = z.enum(['verified', 'unverified', 'active', 'inactive']);

// Input schema (for creating/updating business)
export const businessSchema = z.object({
    business_name: z.string({ required_error: 'business_name is required' })
        .min(1, 'business_name is required'),
    business_address: z.string({ required_error: 'business_address is required' })
        .min(1, 'business_address is required'),
    business_phone_number: z.string({ required_error: 'business_phone_number is required' })
        .regex(/^\d+$/, 'business_phone_number must contain only digits')
        .min(12, 'business_phone_number must be at least 12 digits'),
    working_hours: z.object({
        start_time: z.string({ required_error: 'start_time is required' })
            .min(1, 'start_time is required'),
        end_time: z.string({ required_error: 'end_time is required' })
            .min(1, 'end_time is required')
    }),
    business_status: businessStatusEnum.default('unverified'),
    business_owner_id: z.string({ required_error: 'business_owner_id is required' })
        .min(1, 'business_owner_id is required')
});

// Output schema (for responses)
export const businessResponseSchema = z.object({
    id: z.string(),
    business_name: z.string(),
    business_address: z.string(),
    business_phone_number: z.string(),
    working_hours: z.object({
        start_time: z.string(),
        end_time: z.string()
    }),
    business_status: businessStatusEnum,
    date_created: z.string(),
    business_owner_id: z.string()
});
