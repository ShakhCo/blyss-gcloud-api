import { describe, it, expect, vi } from 'vitest';

// Mock external dependencies so chatAi.js can be imported without real services
vi.mock('../db/db.js', () => ({ db: {} }));
vi.mock('./eskiz.js', () => ({ sendOtpSms: vi.fn() }));
vi.mock('./jwt.js', () => ({ generateTokenPair: vi.fn() }));
vi.mock('./discountResolver.js', () => ({ resolveDiscount: vi.fn() }));

import { _buildChatSystemPrompt } from './chatAi.js';

// ─── Mock business data ───

const mockBusinessData = {
    business_name: 'Test Barber',
    bio: 'Best barber in town',
    business_phone_number: '+998901234567',
    tenant_url: 'test-barber.blyss.uz',
    is_solo: false,
    working_hours: {
        monday: { start: 32400, end: 68400, is_open: true },    // 09:00-19:00
        tuesday: { start: 32400, end: 68400, is_open: true },
        wednesday: { start: 32400, end: 68400, is_open: true },
        thursday: { start: 32400, end: 68400, is_open: true },
        friday: { start: 32400, end: 68400, is_open: true },
        saturday: { start: 36000, end: 64800, is_open: true },  // 10:00-18:00
        sunday: { start: 0, end: 0, is_open: false },
    },
    location: {
        display_address: 'Toshkent, Chilonzor 9-kvartal',
        lat: 41.28,
        lng: 69.22,
    },
};

const mockBusinessDataNoAddress = {
    ...mockBusinessData,
    location: { lat: 41.28, lng: 69.22 },
};

// ─── Tests ───

describe('buildChatSystemPrompt', () => {

    it('Test 1 (CONV-04/PROMPT-01): contains formatted working hours string', () => {
        const prompt = _buildChatSystemPrompt(mockBusinessData, 'test-business-id', {});
        // Formatted hours should appear as "Dushanba: 09:00-19:00" style
        expect(prompt).toContain('Dushanba: 09:00-19:00');
    });

    it('Test 2 (PROMPT-03): contains address when location.display_address is provided', () => {
        const prompt = _buildChatSystemPrompt(mockBusinessData, 'test-business-id', {});
        expect(prompt).toContain('Manzil:');
        expect(prompt).toContain('Toshkent, Chilonzor 9-kvartal');
    });

    it('Test 3 (PROMPT-03): does NOT contain "Manzil:" when address is empty/undefined', () => {
        const prompt = _buildChatSystemPrompt(mockBusinessDataNoAddress, 'test-business-id', {});
        expect(prompt).not.toContain('Manzil:');
    });

    it('Test 4 (PROMPT-04): contains payment fallback "naqd pul yoki karta" when no payment_methods', () => {
        const prompt = _buildChatSystemPrompt(mockBusinessData, 'test-business-id', {});
        expect(prompt).toContain('naqd pul yoki karta');
    });

    it('Test 5 (BTN-03): contains "FAQAT 3 HOLAT" button rule text', () => {
        const prompt = _buildChatSystemPrompt(mockBusinessData, 'test-business-id', {});
        expect(prompt).toContain('FAQAT 3 HOLAT');
    });

    it('Test 6 (BTN-01): contains "TASDIQLASH" confirmation section', () => {
        const prompt = _buildChatSystemPrompt(mockBusinessData, 'test-business-id', {});
        expect(prompt).toContain('TASDIQLASH');
    });

    it('Test 7 (BTN-04): contains prohibition on buttons for phone/OTP/name input', () => {
        const prompt = _buildChatSystemPrompt(mockBusinessData, 'test-business-id', {});
        // Should contain rule about never showing buttons when asking for phone/OTP/name
        expect(prompt).toMatch(/[Tt]elefon.*button|button.*telefon|HECH QACHON.*button.*telefon|telefon.*HECH QACHON/s);
    });

    it('Test 8 (CONV-01): contains one-question-per-turn rule', () => {
        const prompt = _buildChatSystemPrompt(mockBusinessData, 'test-business-id', {});
        // Should contain rule about asking only 1 question per turn
        expect(prompt).toContain('1 ta savol');
    });

    it('Test 9 (PROMPT-09): contains nudge phrases like "Yozdiraysizmi?"', () => {
        const prompt = _buildChatSystemPrompt(mockBusinessData, 'test-business-id', {});
        expect(prompt).toContain('Yozdiraysizmi?');
    });

    it('Test 10 (PROMPT-07): contains rules for greetings/small talk handling', () => {
        const prompt = _buildChatSystemPrompt(mockBusinessData, 'test-business-id', {});
        // Should contain salom/rahmat handling — no nudge for greetings
        expect(prompt).toMatch(/[Ss]alom|rahmat|xayr/);
        expect(prompt).toMatch(/nudge|NUDGE|YO'Q/);
    });

    it('Test 11 (PROMPT-08): contains redirect to phone for unknown questions', () => {
        const prompt = _buildChatSystemPrompt(mockBusinessData, 'test-business-id', {});
        // Should mention phone redirect for unknown questions
        expect(prompt).toContain('+998901234567');
        expect(prompt).toMatch(/noma.lum|taxmin|bilmasam/i);
    });

});
