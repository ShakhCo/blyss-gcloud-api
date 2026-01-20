import { z } from 'zod';

// Availability type enum
export const availabilityTypeEnum = z.enum(['flexible', 'fixed']);

// Employee working hours schema (for individual employee)
export const employeeWorkingHourSchema = z.object({
    day: z.number().min(0).max(6),
    start_time: z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/, 'start_time must be in HH:MM 24-hour format'),
    end_time: z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/, 'end_time must be in HH:MM 24-hour format'),
});

// Employee schema (for adding to business)
export const employeeSchema = z.object({
    phone_number: z.string({ required_error: 'phone_number is required' })
        .min(12, 'phone_number must be at least 12 digits')
        .regex(/^\d+$/, 'phone_number must contain only digits'),
    position: z.string({ required_error: 'position is required' })
        .min(1, 'position is required'),
    availability_type: availabilityTypeEnum.default('flexible'),
    working_hours: z.array(z.nullable(employeeWorkingHourSchema)).length(7, 'working_hours must have exactly 7 days (0-6), use null for off days')
});

// Update employee working hours schema
export const updateEmployeeWorkingHoursSchema = z.object({
    availability_type: availabilityTypeEnum,
    working_hours: z.array(z.nullable(employeeWorkingHourSchema)).length(7, 'working_hours must have exactly 7 days (0-6), use null for off days')
});

// Accept/deny workplace schema
export const workplaceActionSchema = z.object({
    accept: z.boolean({ required_error: 'accept is required' })
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
    working_hours: z.any().nullable(),
    date_created: z.string()
});
