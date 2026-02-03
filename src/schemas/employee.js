import { z } from 'zod';

// Availability type enum
export const availabilityTypeEnum = z.enum(['flexible', 'fixed']);

// Single day working hour schema
const dayWorkingHourSchema = z.object({
    start: z.number().min(0).max(86399), // 0 to 23:59:59 in seconds
    end: z.number().min(0).max(86399),   // 0 to 23:59:59 in seconds
    is_open: z.boolean().default(false)
});

// Full working hours schema (all 7 days required) - same as business
export const workingHoursSchema = z.object({
    monday: dayWorkingHourSchema,
    tuesday: dayWorkingHourSchema,
    wednesday: dayWorkingHourSchema,
    thursday: dayWorkingHourSchema,
    friday: dayWorkingHourSchema,
    saturday: dayWorkingHourSchema,
    sunday: dayWorkingHourSchema
});

// Employee schema (for adding to business)
export const employeeSchema = z.object({
    phone_number: z.string({ required_error: 'phone_number is required' })
        .min(12, 'phone_number must be at least 12 digits')
        .regex(/^\d+$/, 'phone_number must contain only digits'),
    position: z.string({ required_error: 'position is required' })
        .min(1, 'position is required'),
    availability_type: availabilityTypeEnum.default('flexible'),
    working_hours: workingHoursSchema,
    is_open_now: z.boolean().default(false),
    allowed_booking_count_per_slot: z.number().int().min(1).max(5).default(1)
});

// Update employee working hours schema
export const updateEmployeeWorkingHoursSchema = z.object({
    availability_type: availabilityTypeEnum,
    working_hours: workingHoursSchema,
    is_open_now: z.boolean().optional()
});

// Update employee is_open_now schema
export const updateEmployeeIsOpenNowSchema = z.object({
    is_open_now: z.boolean({ required_error: 'is_open_now is required' })
});

// Accept/deny workplace schema
export const workplaceActionSchema = z.object({
    accept: z.boolean({ required_error: 'accept is required' })
});

// Update employee slot capacity schema
export const updateEmployeeSlotCapacitySchema = z.object({
    allowed_booking_count_per_slot: z.number({ required_error: 'allowed_booking_count_per_slot is required' })
        .int('must be an integer')
        .min(1, 'minimum value is 1')
        .max(5, 'maximum value is 5')
});

// Response schema
export const employeeResponseSchema = z.object({
    id: z.string(),
    business_id: z.string(),
    business_owner_id: z.string(),
    first_name: z.string(),
    last_name: z.string(),
    phone_number: z.string(),
    telegram_id: z.number().nullable(),
    is_confirmed_by_employee: z.boolean(),
    availability_type: z.string().nullable(),
    working_hours: workingHoursSchema,
    is_open_now: z.boolean(),
    allowed_booking_count_per_slot: z.number().default(1),
    date_created: z.string()
});
