import { z } from 'zod';

// Business status enum
export const businessStatusEnum = z.enum(['verified', 'unverified', 'active', 'inactive']);

// Firestore timestamp schema (seconds from midnight)
const firestoreTimestampSchema = z.object({
    _seconds: z.number(),
    _nanoseconds: z.number().default(0)
});

// Single day working hour schema
const dayWorkingHourSchema = z.object({
    start: z.number().min(0).max(86399), // 0 to 23:59:59 in seconds
    end: z.number().min(0).max(86399),   // 0 to 23:59:59 in seconds
    is_open: z.boolean().default(false)
});

// Full working hours schema (all 7 days required)
export const businessWorkingHoursSchema = z.object({
    monday: dayWorkingHourSchema,
    tuesday: dayWorkingHourSchema,
    wednesday: dayWorkingHourSchema,
    thursday: dayWorkingHourSchema,
    friday: dayWorkingHourSchema,
    saturday: dayWorkingHourSchema,
    sunday: dayWorkingHourSchema
});

// Location schema
const locationSchema = z.object({
    lat: z.number({ required_error: 'lat is required' }),
    lng: z.number({ required_error: 'lng is required' })
});

// Input schema (for creating/updating business) - with working_graphic_type for backward compatibility
export const businessSchema = z.object({
    business_name: z.string({ required_error: 'business_name is required' })
        .min(1, 'business_name is required'),
    business_type: z.string({ required_error: 'business_type is required' })
        .min(1, 'business_type is required'),
    location: locationSchema,
    working_hours: businessWorkingHoursSchema,
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
    working_hours: businessWorkingHoursSchema,
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
    working_hours: businessWorkingHoursSchema,
    business_phone_number: z.string({ required_error: 'business_phone_number is required' })
        .regex(/^\d+$/, 'business_phone_number must contain only digits')
        .min(12, 'business_phone_number must be at least 12 digits')
});

// Working hours update schema (for PATCH /:id/working-hours)
export const updateWorkingHoursSchema = z.object({
    working_hours: businessWorkingHoursSchema
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
    working_hours: businessWorkingHoursSchema,
    business_phone_number: z.string(),
    business_owner_id: z.string(),
    business_status: businessStatusEnum,
    tenant_url: z.string().optional(),
    date_created: z.string()
});

// Query schema for nearest businesses with pagination
export const nearestBusinessesQuerySchema = z.object({
    lat: z.coerce.number({
        required_error: 'lat is required',
        invalid_type_error: 'lat must be a number'
    }).min(-90, 'lat must be between -90 and 90')
        .max(90, 'lat must be between -90 and 90'),
    lng: z.coerce.number({
        required_error: 'lng is required',
        invalid_type_error: 'lng must be a number'
    }).min(-180, 'lng must be between -180 and 180')
        .max(180, 'lng must be between -180 and 180'),
    radius: z.coerce.number({
        invalid_type_error: 'radius must be a number'
    }).positive('radius must be positive')
        .max(1000, 'radius must be at most 100 km')
        .default(10)
        .optional(),
    page: z.coerce.number({
        invalid_type_error: 'page must be a number'
    }).positive('page must be positive')
        .int('page must be an integer')
        .default(1)
        .optional(),
    page_size: z.coerce.number({
        invalid_type_error: 'page_size must be a number'
    }).positive('page_size must be positive')
        .int('page_size must be an integer')
        .max(100, 'page_size must be at most 100')
        .default(5)
        .optional()
});
