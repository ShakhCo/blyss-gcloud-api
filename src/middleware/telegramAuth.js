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
        console.error('Failed to fetch business bot tokens:', err.message);
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

        console.log('[telegramAuth] Incoming request:', req.method, req.originalUrl);
        console.log('[telegramAuth] Auth type:', authType, '| Auth data present:', !!authData);

        if (authType !== 'tma' || !authData) {
            console.log('[telegramAuth] REJECTED: Invalid auth format');
            return res.status(401).json({
                error: 'Invalid authorization format. Expected: tma <initDataRaw>',
                error_code: 'INVALID_AUTH_FORMAT'
            });
        }

        // Fast path: try main bot token first (if configured)
        let matched = false;
        if (TELEGRAM_BOT_TOKEN) {
            console.log('[telegramAuth] Trying main bot token...');
            try {
                validate(authData, TELEGRAM_BOT_TOKEN, {
                    expiresIn: INIT_DATA_EXPIRES_IN
                });
                matched = true;
                console.log('[telegramAuth] Main bot token matched');
            } catch (error) {
                console.log('[telegramAuth] Main bot token failed:', error.message);
                if (isExpiryError(error)) {
                    console.log('[telegramAuth] REJECTED: Init data expired');
                    return res.status(401).json({
                        error: 'Init data has expired',
                        error_code: 'INIT_DATA_EXPIRED'
                    });
                }
                if (!isSignatureError(error)) {
                    throw error;
                }
            }
        } else {
            console.log('[telegramAuth] No main bot token configured');
        }

        // Slow path: try business bot tokens
        if (!matched) {
            const businessTokens = await getBusinessBotTokens();
            console.log('[telegramAuth] Trying business bot tokens, count:', businessTokens.length);

            for (const { token, business_id } of businessTokens) {
                try {
                    validate(authData, token, {
                        expiresIn: INIT_DATA_EXPIRES_IN
                    });
                    matched = true;
                    req.matchedBusinessId = business_id;
                    console.log('[telegramAuth] Business bot token matched, business_id:', business_id);
                    break;
                } catch (error) {
                    console.log('[telegramAuth] Business token failed for', business_id, ':', error.message);
                    if (isSignatureError(error)) {
                        continue;
                    }
                    // Non-signature error — stop trying
                    throw error;
                }
            }
        }

        if (!matched) {
            console.log('[telegramAuth] REJECTED: No token matched');
            return res.status(401).json({
                error: 'Invalid init data signature',
                error_code: 'INVALID_SIGNATURE'
            });
        }

        // Parse init data to extract user info
        const initData = parse(authData);
        console.log('[telegramAuth] Parsed init data, user:', initData.user?.id, initData.user?.firstName);

        if (!initData.user) {
            console.log('[telegramAuth] REJECTED: No user data in init data');
            return res.status(401).json({
                error: 'User data not found in init data',
                error_code: 'NO_USER_DATA'
            });
        }

        // Attach Telegram user data to request
        req.telegramUser = initData.user;
        req.telegramInitData = initData;

        console.log('[telegramAuth] SUCCESS: User authenticated, id:', initData.user.id);
        next();
    } catch (error) {
        console.error('[telegramAuth] ERROR:', error.message);

        return res.status(401).json({
            error: 'Authentication failed',
            error_code: 'AUTH_FAILED',
            details: error.message
        });
    }
};
