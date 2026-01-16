import { z } from 'zod';

// User type enum
export const userTypeEnum = z.enum(['user', 'business_owner']);

// POST /auth/send-otp
export const sendOtpSchema = z.object({
    phone_number: z.string({ required_error: 'phone_number is required' })
        .regex(/^998\d{9}$/, 'phone_number must be in format 998XXXXXXXXX'),
    user_type: userTypeEnum.default('user')
});

// POST /auth/verify-otp
export const verifyOtpSchema = z.object({
    phone_number: z.string({ required_error: 'phone_number is required' })
        .regex(/^998\d{9}$/, 'phone_number must be in format 998XXXXXXXXX'),
    otp_code: z.coerce.number({ required_error: 'otp_code is required' })
        .int('otp_code must be an integer')
        .min(10000, 'otp_code must be 5 digits')
        .max(99999, 'otp_code must be 5 digits')
});

// POST /auth/login
export const loginSchema = z.object({
    otp_id: z.string({ required_error: 'otp_id is required' }),
    phone_number: z.string({ required_error: 'phone_number is required' })
        .regex(/^998\d{9}$/, 'phone_number must be in format 998XXXXXXXXX'),
    user_type: userTypeEnum.default('user')
});

// POST /auth/register (user)
export const registerUserSchema = z.object({
    otp_id: z.string({ required_error: 'otp_id is required' }),
    user_type: z.literal('user'),
    first_name: z.string({ required_error: 'first_name is required' }).min(1, 'first_name is required'),
    last_name: z.string().default(''),
    telegram_id: z.coerce.number({ invalid_type_error: 'telegram_id must be a number' })
        .positive('telegram_id must be positive')
});

// POST /auth/register (business_owner)
export const registerBusinessOwnerSchema = z.object({
    otp_id: z.string({ required_error: 'otp_id is required' }),
    user_type: z.literal('business_owner'),
    first_name: z.string({ required_error: 'first_name is required' }).min(1, 'first_name is required'),
    last_name: z.string().default(''),
    telegram_id: z.coerce.number({ invalid_type_error: 'telegram_id must be a number' })
        .positive('telegram_id must be positive')
        .nullable()
        .optional()
});

// Combined register schema with discriminator
export const registerSchema = z.discriminatedUnion('user_type', [
    registerUserSchema,
    registerBusinessOwnerSchema
]);

// Response schemas
export const authUserSchema = z.object({
    id: z.string(),
    user_type: userTypeEnum,
    first_name: z.string(),
    last_name: z.string(),
    phone_number: z.string(),
    telegram_id: z.number().nullable().optional(),
    is_verified: z.boolean(),
    created_at: z.string().optional()
});

export const authResponseSchema = z.object({
    user: authUserSchema,
    access_token: z.string(),
    refresh_token: z.string(),
    expires_at: z.string()
});

export const otpResponseSchema = z.object({
    message: z.string(),
    otp_id: z.string()
});

export const meResponseSchema = z.object({
    id: z.string(),
    user_type: userTypeEnum,
    first_name: z.string(),
    last_name: z.string(),
    phone_number: z.string(),
    telegram_id: z.number().nullable().optional(),
    is_verified: z.boolean(),
    created_at: z.string().optional()
});
