import { z } from 'zod';

// Schema for generating OTP (input)
export const generateOtpSchema = z.object({
    user_id: z.string({ required_error: 'user_id is required' }).min(16, 'user_id is required')
});

// Schema for verifying OTP (input)
export const verifyOtpSchema = z.object({
    user_id: z.string({ required_error: 'user_id is required' }).min(16, 'user_id is required'),
    otp_code: z.string({ required_error: 'otp_code is required' }).length(6, 'otp_code must be 6 digits')
});

// Schema for OTP document (Firestore)
export const otpSchema = z.object({
    user_id: z.string(),
    otp_code: z.string(),
    date_created: z.date(),
    used: z.boolean().default(false)
});
