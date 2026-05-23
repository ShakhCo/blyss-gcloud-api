import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockCreate } = vi.hoisted(() => ({
    mockCreate: vi.fn(),
}));

vi.mock('openai', () => ({
    default: class {
        chat = { completions: { create: mockCreate } };
    },
}));

import { polishSmsText, _validatePolishedOutput } from './aiPolish.js';

beforeEach(() => {
    mockCreate.mockReset();
    process.env.OPENAI_API_KEY = 'test-key';
});

describe('polishSmsText', () => {
    it('returns the polished text from OpenAI', async () => {
        mockCreate.mockResolvedValue({
            choices: [{ message: { content: 'Salom! 50% chegirma bor.\nBLYSS' } }],
        });

        const result = await polishSmsText('salom 50% chegirma');

        expect(result).toBe('Salom! 50% chegirma bor.\nBLYSS');
        expect(mockCreate).toHaveBeenCalledOnce();
        const callArgs = mockCreate.mock.calls[0][0];
        expect(callArgs.model).toBe('gpt-4o-mini');
        expect(callArgs.temperature).toBe(0.3);
    });

    it('throws AI_UNAVAILABLE if OPENAI_API_KEY is missing', async () => {
        delete process.env.OPENAI_API_KEY;
        await expect(polishSmsText('anything')).rejects.toMatchObject({
            code: 'AI_UNAVAILABLE',
        });
    });

    it('throws AI_OUTPUT_INVALID when model returns text with a URL', async () => {
        mockCreate.mockResolvedValue({
            choices: [{ message: { content: 'Visit https://spam.com now' } }],
        });
        await expect(polishSmsText('visit spam')).rejects.toMatchObject({
            code: 'AI_OUTPUT_INVALID',
            rule: 'no_urls',
        });
    });

    it('throws AI_OUTPUT_INVALID when model returns text >160 chars', async () => {
        mockCreate.mockResolvedValue({
            choices: [{ message: { content: 'x'.repeat(161) } }],
        });
        await expect(polishSmsText('long text')).rejects.toMatchObject({
            code: 'AI_OUTPUT_INVALID',
            rule: 'too_long',
        });
    });
});

describe('_validatePolishedOutput', () => {
    it('passes for a clean short message', () => {
        expect(() => _validatePolishedOutput('Salom! Chegirma bor.\nBLYSS')).not.toThrow();
    });

    it('rejects URLs (http and bare domain)', () => {
        expect(() => _validatePolishedOutput('Go to http://a.com')).toThrow(/no_urls/);
        expect(() => _validatePolishedOutput('visit example.com today')).toThrow(/no_urls/);
    });

    it('rejects messages >160 chars', () => {
        expect(() => _validatePolishedOutput('a'.repeat(161))).toThrow(/too_long/);
    });

    it('rejects empty messages', () => {
        expect(() => _validatePolishedOutput('   ')).toThrow(/empty/);
    });
});
