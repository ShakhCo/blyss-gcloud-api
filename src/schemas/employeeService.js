import { z } from 'zod';

// Employee service schema (for employee's custom version of a service)
export const employeeServiceSchema = z.object({
    service_id: z.string({ required_error: 'service_id is required' }),
    name: z.string({ required_error: 'name is required' }).min(1, 'name is required'),
    price: z.number({ required_error: 'price is required' })
        .positive('price must be positive')
        .max(999999.99, 'price is too large'),
    duration_minutes: z.number({ required_error: 'duration_minutes is required' })
        .positive('duration_minutes must be positive')
        .int('duration_minutes must be an integer')
        .max(1440, 'duration_minutes cannot exceed 1440 (24 hours)'),
    is_active: z.boolean().default(true)
});

// Add employee services schema
export const addEmployeeServicesSchema = z.object({
    services: z.array(employeeServiceSchema).min(1, 'at least one service is required')
});

// Update employee service schema
export const updateEmployeeServiceSchema = z.object({
    price: z.number().positive().max(999999.99).optional(),
    duration_minutes: z.number().positive().int().max(1440).optional(),
    is_active: z.boolean().optional()
});
