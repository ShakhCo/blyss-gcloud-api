import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        environment: 'node',
        env: {
            JWT_SECRET: 'test-jwt-secret-at-least-32-chars-long-abc123',
            API_SECRET: 'test-api-secret-at-least-32-chars-long-abc123',
            DATABASE_ID: '(default)',
            NODE_ENV: 'test',
        },
    },
});
