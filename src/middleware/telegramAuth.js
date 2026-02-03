import { validate, parse } from '@tma.js/init-data-node';

// Telegram Bot Token for validating init data
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

// Init data expiry time (1 hour in seconds)
const INIT_DATA_EXPIRES_IN = 3600;

/**
 * Telegram Mini App authentication middleware
 * Validates init data from Authorization header in format: "tma <initDataRaw>"
 */
export const telegramAuth = (req, res, next) => {
    try {
        if (!TELEGRAM_BOT_TOKEN) {
            return res.status(500).json({
                error: 'Telegram bot token not configured',
                error_code: 'CONFIG_ERROR'
            });
        }

        const authHeader = req.headers.authorization || '';
        const [authType, authData = ''] = authHeader.split(' ');

        if (authType !== 'tma' || !authData) {
            return res.status(401).json({
                error: 'Invalid authorization format. Expected: tma <initDataRaw>',
                error_code: 'INVALID_AUTH_FORMAT'
            });
        }

        // Validate init data signature and expiry
        validate(authData, TELEGRAM_BOT_TOKEN, {
            expiresIn: INIT_DATA_EXPIRES_IN
        });

        // Parse init data to extract user info
        const initData = parse(authData);

        if (!initData.user) {
            return res.status(401).json({
                error: 'User data not found in init data',
                error_code: 'NO_USER_DATA'
            });
        }

        // Attach Telegram user data to request
        req.telegramUser = initData.user;
        req.telegramInitData = initData;

        next();
    } catch (error) {
        // Handle specific validation errors
        if (error.message?.includes('expired') || error.message?.includes('Expired')) {
            return res.status(401).json({
                error: 'Init data has expired',
                error_code: 'INIT_DATA_EXPIRED'
            });
        }

        if (error.message?.includes('signature') || error.message?.includes('hash')) {
            return res.status(401).json({
                error: 'Invalid init data signature',
                error_code: 'INVALID_SIGNATURE'
            });
        }

        return res.status(401).json({
            error: 'Authentication failed',
            error_code: 'AUTH_FAILED',
            details: error.message
        });
    }
};
