import { z } from 'zod';

// Business status enum
export const businessStatusEnum = z.enum(['verified', 'unverified', 'active', 'inactive']);

// Input schema (for creating/updating business)
export const businessSchema = z.object({
    business_name: z.string({ required_error: 'business_name is required' })
        .min(1, 'business_name is required'),
    business_address: z.object({
        lat: z.number({ required_error: 'lat is required' }),
        long: z.number({ required_error: 'long is required' }),
        city: z.string({ required_error: 'city is required' }).min(1, 'city is required'),
        country: z.string({ required_error: 'country is required' }).min(1, 'country is required'),
        region: z.string(),
        street_name: z.string(),
        building_number: z.string().default(''),
        postal_code: z.string().default('')
    }),
    business_phone_number: z.string({ required_error: 'business_phone_number is required' })
        .regex(/^\d+$/, 'business_phone_number must contain only digits')
        .min(12, 'business_phone_number must be at least 12 digits'),
    working_hours: z.object({
        start_time: z.string({ required_error: 'start_time is required' })
            .regex(/^([01]\d|2[0-3]):([0-5]\d)$/, 'start_time must be in HH:MM 24-hour format'),
        end_time: z.string({ required_error: 'end_time is required' })
            .regex(/^([01]\d|2[0-3]):([0-5]\d)$/, 'end_time must be in HH:MM 24-hour format')
    }),
    business_status: businessStatusEnum.default('unverified'),
    business_owner_id: z.string({ required_error: 'business_owner_id is required' })
        .min(1, 'business_owner_id is required')
});

// Output schema (for responses)
export const businessResponseSchema = z.object({
    id: z.string(),
    business_name: z.string(),
    business_address: z.object({
        lat: z.number(),
        long: z.number(),
        city: z.string(),
        country: z.string(),
        region: z.string().optional(),
        street_name: z.string().optional(),
        building_number: z.string().optional(),
        postal_code: z.string().optional()
    }),
    business_phone_number: z.string(),
    working_hours: z.object({
        start_time: z.string(),
        end_time: z.string()
    }),
    business_status: businessStatusEnum,
    date_created: z.string(),
    business_owner_id: z.string()
});
