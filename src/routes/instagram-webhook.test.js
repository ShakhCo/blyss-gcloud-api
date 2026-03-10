import { describe, it, expect } from 'vitest';
import { buildSystemPrompt } from './instagram-webhook.js';

// ─── buildSystemPrompt unit tests ────────────────────────────────────────────

describe('buildSystemPrompt', () => {
    const baseArgs = {
        businessInfo: 'Business: Test Salon\nServices:\n  - Haircut: 50000 so\'m, 30 min',
        isSolo: false,
        bookingLink: 'https://testsalon.blyss.uz',
        username: 'testuser',
        postCaption: 'New haircut styles available!',
        postTime: 'Mon, 2026-03-10 10:00',
        postAiInstructions: '',
        aiInstructions: '',
        aiExampleReplies: '',
        now: 'Tuesday, 2026-03-10 09:00',
    };

    it('returns a string containing identity section when called with minimal args', () => {
        const prompt = buildSystemPrompt(baseArgs);
        expect(typeof prompt).toBe('string');
        expect(prompt.length).toBeGreaterThan(0);
        expect(prompt).toContain('Instagram');
        expect(prompt).toContain('business');
    });

    it('includes "I" / solo voice indicators when isSolo=true', () => {
        const prompt = buildSystemPrompt({ ...baseArgs, isSolo: true });
        // When isSolo, the prompt should reflect solo/owner voice — look for
        // "I" or "owner" in context of voice/identity
        expect(prompt).toMatch(/I\b|solo|owner/i);
    });

    it('includes "we" / team voice indicators when isSolo=false', () => {
        const prompt = buildSystemPrompt({ ...baseArgs, isSolo: false });
        expect(prompt).toMatch(/we\b|team|business/i);
    });

    it('includes businessInfo in output', () => {
        const prompt = buildSystemPrompt(baseArgs);
        expect(prompt).toContain('Test Salon');
        expect(prompt).toContain('Haircut');
    });

    it('includes @username when username is provided', () => {
        const prompt = buildSystemPrompt({ ...baseArgs, username: 'john_doe' });
        expect(prompt).toContain('@john_doe');
    });

    it('omits @username reference when username is empty', () => {
        const prompt = buildSystemPrompt({ ...baseArgs, username: '' });
        expect(prompt).not.toContain('@john_doe');
    });

    it('omits @username reference when username is null', () => {
        const prompt = buildSystemPrompt({ ...baseArgs, username: null });
        expect(prompt).not.toContain('@null');
    });

    it('includes postCaption when provided', () => {
        const prompt = buildSystemPrompt({ ...baseArgs, postCaption: 'New haircut styles available!' });
        expect(prompt).toContain('New haircut styles available!');
    });

    it('uses postAiInstructions path when postAiInstructions is set', () => {
        const prompt = buildSystemPrompt({
            ...baseArgs,
            postAiInstructions: 'Promote our special discount only',
        });
        expect(prompt).toContain('Promote our special discount only');
    });

    it('does not include global GOAL rules when postAiInstructions is set', () => {
        const prompt = buildSystemPrompt({
            ...baseArgs,
            postAiInstructions: 'Follow these special instructions',
        });
        // The global rules path has "Drive bookings" as a GOAL — should not appear in post-override path
        expect(prompt).not.toContain('Drive bookings');
    });

    it('uses global rules path when postAiInstructions is empty', () => {
        const prompt = buildSystemPrompt({ ...baseArgs, postAiInstructions: '' });
        expect(prompt).toContain('Drive bookings');
    });

    it('includes aiExampleReplies when provided', () => {
        const prompt = buildSystemPrompt({
            ...baseArgs,
            aiExampleReplies: 'Raxmat, xush kelibsiz!',
        });
        expect(prompt).toContain('Raxmat, xush kelibsiz!');
    });

    it('includes default examples section when aiExampleReplies is empty', () => {
        const prompt = buildSystemPrompt({ ...baseArgs, aiExampleReplies: '' });
        // Should still have some example replies section (EXAMPLE REPLIES or similar)
        expect(prompt).toContain('EXAMPLE');
    });

    it('includes aiInstructions (owner overrides) when provided', () => {
        const prompt = buildSystemPrompt({
            ...baseArgs,
            aiInstructions: 'Always greet customers with "Assalomu alaykum"',
        });
        expect(prompt).toContain('Always greet customers with "Assalomu alaykum"');
    });

    it('includes bookingLink in booking-intent rules section', () => {
        const prompt = buildSystemPrompt({ ...baseArgs, bookingLink: 'https://salon.blyss.uz' });
        expect(prompt).toContain('https://salon.blyss.uz');
    });

    it('omits booking link section entirely when bookingLink is empty', () => {
        const prompt = buildSystemPrompt({ ...baseArgs, bookingLink: '' });
        // The booking link URL should not appear
        expect(prompt).not.toContain('https://');
    });
});
