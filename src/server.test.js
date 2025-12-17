import { describe, it, expect } from 'vitest';
import request from 'supertest';
import app from './server.js';

describe('CORS', () => {
    it('allows requests from allowed origin', async () => {
        const res = await request(app)
            .get('/')
            .set('Origin', 'https://barbershop-miniapp-beta.automations.uz');

        expect(res.headers['access-control-allow-origin']).toBe('https://barbershop-miniapp-beta.automations.uz');
    });

    it('handles preflight requests', async () => {
        const res = await request(app)
            .options('/users/register')
            .set('Origin', 'https://barbershop-miniapp-beta.automations.uz')
            .set('Access-Control-Request-Method', 'POST');

        expect(res.status).toBe(204);
        expect(res.headers['access-control-allow-origin']).toBe('https://barbershop-miniapp-beta.automations.uz');
        expect(res.headers['access-control-allow-methods']).toContain('POST');
    });
});

describe('API', () => {
    it('GET / returns hello world', async () => {
        const res = await request(app).get('/');
        expect(res.status).toBe(200);
        expect(res.text).toBe('Hello world');
    });

    it('POST /users/register validates input', async () => {
        const res = await request(app)
            .post('/users/register')
            .send({ first_name: 'Test' });

        expect(res.status).toBe(400);
        expect(res.body.validation_errors).toBeDefined();
        expect(res.body.error_code).toBe('VALIDATION_ERROR');
    });
});
