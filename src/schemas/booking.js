import { z } from 'zod';

// Booking status enum
export const bookingStatusEnum = z.enum(['pending', 'confirmed', 'completed', 'cancelled', 'no_show']);

// Localized name schema (for service names)
const localizedNameSchema = z.object({
    uz: z.string(),
    ru: z.string()
});

// Booking item schema (individual service in a booking)
export const bookingItemSchema = z.object({
    service_id: z.string({ required_error: 'service_id is required' }).min(1),
    service_name: localizedNameSchema,
    employee_id: z.string({ required_error: 'employee_id is required' }).min(1),
    employee_name: z.string({ required_error: 'employee_name is required' }).min(1),
    start_time: z.string({ required_error: 'start_time is required' })
        .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, 'start_time must be in YYYY-MM-DDTHH:mm format'),
    price: z.number({ required_error: 'price is required' }).min(0),
    duration_minutes: z.number({ required_error: 'duration_minutes is required' }).int().min(1)
});

// Create booking schema
export const createBookingSchema = z.object({
    business_id: z.string({ required_error: 'business_id is required' }).min(1),
    customer_name: z.string({ required_error: 'customer_name is required' }).min(1),
    customer_phone: z.string({ required_error: 'customer_phone is required' })
        .min(9, 'customer_phone must be at least 9 digits')
        .regex(/^\d+$/, 'customer_phone must contain only digits'),
    customer_telegram_id: z.number().nullable().optional(),
    booking_date: z.string({ required_error: 'booking_date is required' })
        .regex(/^\d{4}-\d{2}-\d{2}$/, 'booking_date must be in YYYY-MM-DD format'),
    notes: z.string().optional().default(''),
    items: z.array(bookingItemSchema).min(1, 'at least one booking item is required')
});

// Available slots query schema
export const availableSlotsQuerySchema = z.object({
    date: z.string({ required_error: 'date is required' })
        .regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be in YYYY-MM-DD format'),
    service_id: z.string({ required_error: 'service_id is required' }).min(1),
    employee_id: z.string().optional(),
    duration_minutes: z.coerce.number().int().min(1).optional()
});

// User bookings query schema
export const userBookingsQuerySchema = z.object({
    page: z.coerce.number().int().min(1).default(1),
    page_size: z.coerce.number().int().min(1).max(50).default(10),
    status: bookingStatusEnum.optional(),
    date_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date_from must be in YYYY-MM-DD format').optional(),
    date_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date_to must be in YYYY-MM-DD format').optional()
});

// Business bookings query schema
export const businessBookingsQuerySchema = z.object({
    page: z.coerce.number().int().min(1).default(1),
    page_size: z.coerce.number().int().min(1).max(50).default(10),
    status: bookingStatusEnum.optional(),
    employee_id: z.string().optional(),
    date_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date_from must be in YYYY-MM-DD format').optional(),
    date_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date_to must be in YYYY-MM-DD format').optional()
});

// Update booking status schema
export const updateBookingStatusSchema = z.object({
    status: bookingStatusEnum
});

// Service employees query schema
export const serviceEmployeesQuerySchema = z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be in YYYY-MM-DD format').optional()
});

// Booking response schema
export const bookingResponseSchema = z.object({
    id: z.string(),
    business_id: z.string(),
    business_name: z.string(),
    user_id: z.string(),
    customer_name: z.string(),
    customer_phone: z.string(),
    customer_telegram_id: z.number().nullable(),
    booking_date: z.string(),
    status: bookingStatusEnum,
    total_price: z.number(),
    total_duration_minutes: z.number(),
    notes: z.string(),
    items: z.array(z.object({
        id: z.string(),
        service_id: z.string(),
        service_name: localizedNameSchema,
        employee_id: z.string(),
        employee_name: z.string(),
        start_time: z.string(),
        end_time: z.string(),
        price: z.number(),
        duration_minutes: z.number(),
        status: z.string(),
        order_index: z.number()
    })),
    created_at: z.string(),
    updated_at: z.string()
});
