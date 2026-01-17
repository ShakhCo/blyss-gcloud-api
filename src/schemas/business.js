import { z } from 'zod';

// Business status enum
export const businessStatusEnum = z.enum(['verified', 'unverified', 'active', 'inactive']);

// Working graphic type enum
export const workingGraphicTypeEnum = z.enum(['on_demand', 'fixed_hours']);

// Day names enum
export const dayNameEnum = z.enum(['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']);

// Time format regex (HH:MM 24-hour)
const timeRegex = /^([01]\d|2[0-3]):([0-5]\d)$/;

// Location schema
const locationSchema = z.object({
    lat: z.number({ required_error: 'lat is required' }),
    lng: z.number({ required_error: 'lng is required' })
});

// Business hours schema (single day)
const businessHourSchema = z.object({
    day: z.number().min(0).max(6),
    day_name: dayNameEnum,
    start_time: z.string().regex(timeRegex, 'start_time must be in HH:MM 24-hour format'),
    end_time: z.string().regex(timeRegex, 'end_time must be in HH:MM 24-hour format'),
    is_closed: z.boolean().default(false)
});

// Input schema (for creating/updating business)
export const businessSchema = z.object({
    business_name: z.string({ required_error: 'business_name is required' })
        .min(1, 'business_name is required'),
    business_type: z.string({ required_error: 'business_type is required' })
        .min(1, 'business_type is required'),
    location: locationSchema,
    working_graphic_type: workingGraphicTypeEnum,
    working_hours: z.array(businessHourSchema).length(7, 'working_hours must have exactly 7 days').nullable().optional(),
    business_phone_number: z.string({ required_error: 'business_phone_number is required' })
        .regex(/^\d+$/, 'business_phone_number must contain only digits')
        .min(12, 'business_phone_number must be at least 12 digits'),
    business_owner_id: z.string({ required_error: 'business_owner_id is required' })
        .min(1, 'business_owner_id is required')
});

// Input schema for creating business (without business_owner_id - taken from auth)
export const createBusinessSchema = z.object({
    business_name: z.string({ required_error: 'business_name is required' })
        .min(1, 'business_name is required'),
    business_type: z.string({ required_error: 'business_type is required' })
        .min(1, 'business_type is required'),
    location: locationSchema,
    working_graphic_type: workingGraphicTypeEnum,
    working_hours: z.array(businessHourSchema).length(7, 'working_hours must have exactly 7 days').nullable().optional(),
    business_phone_number: z.string({ required_error: 'business_phone_number is required' })
        .regex(/^\d+$/, 'business_phone_number must contain only digits')
        .min(12, 'business_phone_number must be at least 12 digits')
});

// Input schema for updating business (without business_owner_id - cannot be changed)
export const updateBusinessSchema = z.object({
    business_name: z.string({ required_error: 'business_name is required' })
        .min(1, 'business_name is required'),
    business_type: z.string({ required_error: 'business_type is required' })
        .min(1, 'business_type is required'),
    location: locationSchema,
    working_graphic_type: workingGraphicTypeEnum,
    working_hours: z.array(businessHourSchema).length(7, 'working_hours must have exactly 7 days').nullable().optional(),
    business_phone_number: z.string({ required_error: 'business_phone_number is required' })
        .regex(/^\d+$/, 'business_phone_number must contain only digits')
        .min(12, 'business_phone_number must be at least 12 digits')
});

// Output schema (for responses)
export const businessResponseSchema = z.object({
    id: z.string(),
    business_name: z.string(),
    business_type: z.string(),
    location: z.object({
        lat: z.number(),
        lng: z.number()
    }),
    working_graphic_type: workingGraphicTypeEnum,
    working_hours: z.array(z.object({
        day: z.number(),
        day_name: dayNameEnum,
        start_time: z.string(),
        end_time: z.string(),
        is_closed: z.boolean()
    })).optional(),
    business_phone_number: z.string(),
    business_owner_id: z.string(),
    business_status: businessStatusEnum,
    tenant_url: z.string().optional(),
    date_created: z.string()
});
