import { z } from 'zod';

// Business status enum
export const businessStatusEnum = z.enum(['verified', 'unverified', 'active', 'inactive']);

// Image source enum
export const imageSourceEnum = z.enum(['place_id_photo', 'local_upload']);

// Day names enum
export const dayNameEnum = z.enum(['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']);

// Time format regex (HH:MM 24-hour)
const timeRegex = /^([01]\d|2[0-3]):([0-5]\d)$/;

// Business address schema
const businessAddressSchema = z.object({
    lat: z.number({ required_error: 'lat is required' }),
    long: z.number({ required_error: 'long is required' }),
    city: z.string({ required_error: 'city is required' }).min(1, 'city is required'),
    country: z.string({ required_error: 'country is required' }).min(1, 'country is required'),
    region: z.string().default(''),
    street_name: z.string().default('')
});

// Business image schema
const businessImageSchema = z.object({
    source: imageSourceEnum,
    photo_reference: z.string().optional(),
    data: z.string().optional(),
    is_primary: z.boolean().default(false)
}).refine(
    (data) => {
        if (data.source === 'place_id_photo') return !!data.photo_reference;
        if (data.source === 'local_upload') return !!data.data;
        return false;
    },
    { message: 'photo_reference required for place_id_photo, data required for local_upload' }
);

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
    business_phone_number: z.string({ required_error: 'business_phone_number is required' })
        .regex(/^\d+$/, 'business_phone_number must contain only digits')
        .min(12, 'business_phone_number must be at least 12 digits'),
    business_owner_id: z.string({ required_error: 'business_owner_id is required' })
        .min(1, 'business_owner_id is required'),
    business_address: businessAddressSchema,
    business_images: z.array(businessImageSchema).default([]),
    business_hours: z.array(businessHourSchema).length(7, 'business_hours must have exactly 7 days'),
    place_id: z.string().optional()
});

// Output schema (for responses)
export const businessResponseSchema = z.object({
    id: z.string(),
    business_name: z.string(),
    business_phone_number: z.string(),
    business_owner_id: z.string(),
    business_address: z.object({
        lat: z.number(),
        long: z.number(),
        city: z.string(),
        country: z.string(),
        region: z.string().optional(),
        street_name: z.string().optional()
    }),
    business_images: z.array(z.object({
        source: imageSourceEnum,
        photo_reference: z.string().optional(),
        url: z.string().optional(),
        is_primary: z.boolean()
    })),
    business_hours: z.array(z.object({
        day: z.number(),
        day_name: dayNameEnum,
        start_time: z.string(),
        end_time: z.string(),
        is_closed: z.boolean()
    })),
    place_id: z.string().optional(),
    business_status: businessStatusEnum,
    date_created: z.string()
});
