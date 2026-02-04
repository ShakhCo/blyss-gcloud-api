import { z } from 'zod';

// Input schema (for registration)
export const userSchema = z.object({
    first_name: z.string({ required_error: 'first_name is required' }).min(1, 'first_name is required'),
    last_name: z.string().default(''),
    phone_number: z.string({ required_error: 'phone_number is required' })
        .regex(/^\d+$/, 'phone_number must contain only digits')
        .min(12, 'phone_number must be at least 12 digits'),
    telegram_id: z.coerce
        .number({ required_error: 'telegram_id is required', invalid_type_error: 'telegram_id must be a number' })
        .positive('telegram_id must be positive')
});

// Input schema (for login)
export const loginSchema = z.object({
    phone_number: z.string({ required_error: 'phone_number is required' })
        .regex(/^\d+$/, 'phone_number must contain only digits')
        .min(12, 'phone_number must be at least 12 digits')
});

const response = {
    time_slots: [
        {
            start: 36000, // 10:00
            end: 36900, // 10:15,
            availabe_employees: [
                {
                    employee_id: 0,
                    first_name: '',
                    last_name: '',
                    services: [
                        {
                            service_od: 0,
                            name: {
                                uz: '',
                                ru: ''
                            },
                            description: {
                                uz: '',
                                ru: ''
                            },
                            duration_in_minutes: 0,
                            price: 0
                        },
                    ]
                }
            ]
        },
        {
            start: 36900, // 10:15
            end: 37800,  // 10:30
            availabe_employees: [
                {
                    employee_id: 0,
                    first_name: '',
                    last_name: '',
                    services: [
                        {
                            service_od: 0,
                            name: {
                                uz: '',
                                ru: ''
                            },
                            description: {
                                uz: '',
                                ru: ''
                            },
                            duration_in_minutes: 0,
                            price: 0
                        },
                    ]
                }
            ]
        }, //etc
    ]
}

// Output schema (for responses)
export const userResponseSchema = z.object({
    id: z.string(),
    first_name: z.string(),
    last_name: z.string(),
    phone_number: z.string(),
    telegram_id: z.number(),
    is_verified: z.boolean()
});
