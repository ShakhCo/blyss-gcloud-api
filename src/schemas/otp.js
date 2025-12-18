import { z } from 'zod';

// Schema for generating OTP (input)
export const generateOtpSchema = z.object({
    user_id: z.string({ required_error: 'user_id is required' }).min(16, 'user_id is required')
});

// Schema for sending OTP by phone number
export const sendOtpSchema = z.object({
    phone_number: z.string({ required_error: 'phone_number is required' })
        .regex(/^998\d{9}$/, 'phone_number must be in format 998XXXXXXXXX')
});

// Schema for verifying OTP (input)
export const verifyOtpSchema = z.object({
    user_id: z.string({ required_error: 'user_id is required' }).min(16, 'user_id is required'),
    otp_code: z.coerce.number({ required_error: 'otp_code is required' })
        .int('otp_code must be an integer')
        .min(10000, 'otp_code must be 5 digits')
        .max(99999, 'otp_code must be 5 digits')
});

// Schema for OTP document (Firestore)
export const otpSchema = z.object({
    user_id: z.string(),
    otp_code: z.string(),
    date_created: z.date(),
    used: z.boolean().default(false)
});
