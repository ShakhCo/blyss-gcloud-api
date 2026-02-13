import { validate, parse } from '@tma.js/init-data-node';
import { db } from '../db/db.js';

// Telegram Bot Token for validating init data
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

// Init data expiry time (1 hour in seconds)
const INIT_DATA_EXPIRES_IN = 3600;

// In-memory cache for business bot tokens (5-minute TTL)
const CACHE_TTL_MS = 5 * 60 * 1000;
let botTokenCache = { tokens: [], fetchedAt: 0 };

function isSignatureError(error) {
    const msg = error.message?.toLowerCase() || '';
    return msg.includes('signature') || msg.includes('hash');
}

function isExpiryError(error) {
    const msg = error.message?.toLowerCase() || '';
    return msg.includes('expired');
}

async function getBusinessBotTokens() {
    if (Date.now() - botTokenCache.fetchedAt < CACHE_TTL_MS) {
        return botTokenCache.tokens;
    }

    try {
        const snapshot = await db
            .collection('businesses')
            .where('telegram_bot.is_active', '==', true)
            .get();

        const tokens = [];
        snapshot.forEach((doc) => {
            const token = doc.data().telegram_bot?.token;
            if (token) {
                tokens.push({ token, business_id: doc.id });
            }
        });

        botTokenCache = { tokens, fetchedAt: Date.now() };
        return tokens;
    } catch (err) {
        console.error('[getBusinessBotTokens] Failed to fetch:', err.message);
        return botTokenCache.tokens;
    }
}

/**
 * Telegram Mini App authentication middleware
 * Validates init data from Authorization header in format: "tma <initDataRaw>"
 * Tries the main bot token first, then business bot tokens.
 */
export const telegramAuth = async (req, res, next) => {
    try {
        const authHeader = req.headers.authorization || '';
        const [authType, authData = ''] = authHeader.split(' ');

        if (authType !== 'tma' || !authData) {
            return res.status(401).json({
                error: 'Invalid authorization format. Expected: tma <initDataRaw>',
                error_code: 'INVALID_AUTH_FORMAT'
            });
        }

        // Fast path: try main bot token first (if configured)
        let matched = false;
        if (TELEGRAM_BOT_TOKEN) {
            try {
                validate(authData, TELEGRAM_BOT_TOKEN, {
                    expiresIn: INIT_DATA_EXPIRES_IN
                });
                matched = true;
            } catch (error) {
                if (isExpiryError(error)) {
                    return res.status(401).json({
                        error: 'Init data has expired',
                        error_code: 'INIT_DATA_EXPIRED'
                    });
                }
                // Treat validation errors (including empty message) as signature mismatch — fall through to business tokens
            }
        }

        // Slow path: try business bot tokens
        if (!matched) {
            const businessTokens = await getBusinessBotTokens();

            for (const { token, business_id } of businessTokens) {
                try {
                    validate(authData, token, {
                        expiresIn: INIT_DATA_EXPIRES_IN
                    });
                    matched = true;
                    req.matchedBusinessId = business_id;
                    break;
                } catch (error) {
                    // Continue trying other tokens for any validation error
                    continue;
                }
            }
        }

        if (!matched) {
            return res.status(401).json({
                error: 'Invalid init data signature',
                error_code: 'INVALID_SIGNATURE'
            });
        }

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
        console.error('[telegramAuth] ERROR:', error);

        return res.status(401).json({
            error: 'Authentication failed',
            error_code: 'AUTH_FAILED'
        });
    }
};
