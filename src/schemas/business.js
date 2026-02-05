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
        .min(1, 'business_owner_id is required'),
    avatar_url: z.string().url('Invalid avatar URL').optional()
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
        .min(12, 'business_phone_number must be at least 12 digits'),
    avatar_url: z.string().url('Invalid avatar URL').optional(),
    place_id: z.string().default('')
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
        .min(12, 'business_phone_number must be at least 12 digits'),
    avatar_url: z.string().url('Invalid avatar URL').optional()
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
    avatar_url: z.string().optional(),
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
        .max(1000, 'radius must be at most 1000 km')
        .default(1000)
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

// Query schema for telegram available slots
export const telegramAvailableSlotsQuerySchema = z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD'),
    business_id: z.string().min(1, 'business_id is required'),
    service_ids: z.string().min(1, 'service_ids is required')
        .transform(val => val.split(',').map(s => s.trim()).filter(Boolean))
        .refine(arr => arr.length > 0, 'at least one service_id is required')
});

// Query schema for telegram slot employees
export const telegramSlotEmployeesQuerySchema = z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD'),
    business_id: z.string().min(1, 'business_id is required'),
    service_ids: z.string().min(1, 'service_ids is required')
        .transform(val => val.split(',').map(s => s.trim()).filter(Boolean))
        .refine(arr => arr.length > 0, 'at least one service_id is required'),
    start_time: z.coerce.number().int().min(0).max(86399, 'start_time must be seconds from midnight (0-86399)')
});

// Schema for telegram booking service item (v2 - simplified)
const telegramBookingServiceSchemaV2 = z.object({
    service_id: z.string().min(1, 'service_id is required'),
    employee_id: z.string().nullable().optional()
});

// Schema for telegram booking creation (v2)
export const telegramCreateBookingSchemaV2 = z.object({
    user_id: z.string().min(1, 'user_id is required'),
    business_id: z.string().min(1, 'business_id is required'),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD'),
    start_time: z.coerce.number().int().min(0).max(86399, 'start_time must be seconds from midnight (0-86399)'),
    services: z.array(telegramBookingServiceSchemaV2).min(1, 'at least one service is required'),
    notes: z.string().optional().default('')
});

// Query schema for distance calculation with flat parameters
export const distanceQuerySchema = z.object({
    user_lat: z.coerce.number({
        required_error: 'user_lat is required',
        invalid_type_error: 'user_lat must be a number'
    }).min(-90, 'user_lat must be between -90 and 90')
        .max(90, 'user_lat must be between -90 and 90'),
    user_lng: z.coerce.number({
        required_error: 'user_lng is required',
        invalid_type_error: 'user_lng must be a number'
    }).min(-180, 'user_lng must be between -180 and 180')
        .max(180, 'user_lng must be between -180 and 180'),
    business_lat: z.coerce.number({
        required_error: 'business_lat is required',
        invalid_type_error: 'business_lat must be a number'
    }).min(-90, 'business_lat must be between -90 and 90')
        .max(90, 'business_lat must be between -90 and 90'),
    business_lng: z.coerce.number({
        required_error: 'business_lng is required',
        invalid_type_error: 'business_lng must be a number'
    }).min(-180, 'business_lng must be between -180 and 180')
        .max(180, 'business_lng must be between -180 and 180')
});
