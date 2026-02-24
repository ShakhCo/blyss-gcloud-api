import { z } from 'zod';

// Discount trigger types
export const discountTriggerEnum = z.enum(['date_range', 'day_of_week', 'time_of_day', 'first_visit']);

// Discount type (percentage or fixed amount)
export const discountTypeEnum = z.enum(['percentage', 'fixed']);

// Create/update discount schema
export const discountSchema = z.object({
    name: z.string().max(100).optional(),
    discount_type: discountTypeEnum,
    discount_value: z.number().positive('discount_value must be positive'),
    applies_to: z.array(z.string()).default([]),
    trigger: discountTriggerEnum,
    date_start: z.string().optional(),
    date_end: z.string().optional(),
    days_of_week: z.array(z.number().int().min(1).max(7)).optional(),
    time_start: z.number().min(0).max(86399).optional(),
    time_end: z.number().min(0).max(86399).optional(),
    is_active: z.boolean().default(true),
}).refine((data) => {
    // Percentage must be 1-100
    if (data.discount_type === 'percentage' && data.discount_value > 100) {
        return false;
    }
    return true;
}, {
    message: 'percentage discount_value must be between 1 and 100',
    path: ['discount_value'],
}).refine((data) => {
    if (data.trigger === 'date_range') {
        return data.date_start && data.date_end;
    }
    return true;
}, {
    message: 'date_start and date_end are required for date_range trigger',
    path: ['trigger'],
}).refine((data) => {
    if (data.trigger === 'date_range' && data.date_start && data.date_end) {
        return data.date_end >= data.date_start;
    }
    return true;
}, {
    message: 'date_end must be on or after date_start',
    path: ['date_end'],
}).refine((data) => {
    if (data.trigger === 'day_of_week') {
        return data.days_of_week && data.days_of_week.length > 0;
    }
    return true;
}, {
    message: 'days_of_week is required for day_of_week trigger',
    path: ['trigger'],
}).refine((data) => {
    if (data.trigger === 'time_of_day') {
        return data.time_start != null && data.time_end != null;
    }
    return true;
}, {
    message: 'time_start and time_end are required for time_of_day trigger',
    path: ['trigger'],
});

// Update discount schema (all fields optional except what's being changed)
export const updateDiscountSchema = z.object({
    name: z.string().max(100).optional(),
    discount_type: discountTypeEnum.optional(),
    discount_value: z.number().positive('discount_value must be positive').optional(),
    applies_to: z.array(z.string()).optional(),
    trigger: discountTriggerEnum.optional(),
    date_start: z.string().optional(),
    date_end: z.string().optional(),
    days_of_week: z.array(z.number().int().min(1).max(7)).optional(),
    time_start: z.number().min(0).max(86399).optional(),
    time_end: z.number().min(0).max(86399).optional(),
    is_active: z.boolean().optional(),
});

// Loyalty rule schema
const loyaltyRuleSchema = z.object({
    visit_number: z.number().int().min(1).max(50),
    discount_type: discountTypeEnum,
    discount_value: z.number().positive('discount_value must be positive'),
});

// Loyalty config schema
export const loyaltyConfigSchema = z.object({
    is_enabled: z.boolean(),
    rules: z.array(loyaltyRuleSchema).max(10).refine((rules) => {
        // No duplicate visit numbers
        const visitNumbers = rules.map(r => r.visit_number);
        return new Set(visitNumbers).size === visitNumbers.length;
    }, {
        message: 'Each visit_number must be unique',
    }).refine((rules) => {
        // Percentage values must be 1-100
        return rules.every(r => r.discount_type !== 'percentage' || r.discount_value <= 100);
    }, {
        message: 'percentage discount_value must be between 1 and 100',
    }),
});
