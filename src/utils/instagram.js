/**
 * Meta/Instagram Graph API utilities for Instagram integration
 */

import crypto from 'crypto';

const META_APP_ID = process.env.META_APP_ID;
const META_APP_SECRET = process.env.META_APP_SECRET;
const INSTAGRAM_CALLBACK_URL = process.env.INSTAGRAM_CALLBACK_URL;

const GRAPH_API_BASE = 'https://graph.facebook.com/v21.0';

/**
 * Build the Meta OAuth URL for Instagram authorization
 * @param {string} businessId - The business ID to pass as state parameter
 * @returns {string} The full OAuth authorization URL
 */
export function getOAuthUrl(businessId) {
    const params = new URLSearchParams({
        client_id: META_APP_ID,
        redirect_uri: INSTAGRAM_CALLBACK_URL,
        scope: 'instagram_basic,instagram_manage_comments,pages_show_list,pages_read_engagement',
        response_type: 'code',
        state: businessId,
    });

    return `https://www.facebook.com/v21.0/dialog/oauth?${params.toString()}`;
}

/**
 * Exchange an authorization code for a long-lived access token
 * First exchanges code for short-lived token, then exchanges for long-lived token (~60 days)
 * @param {string} code - The authorization code from OAuth callback
 * @returns {Promise<{access_token: string, expires_in: number}>}
 */
export async function exchangeCodeForToken(code) {
    // Step 1: Exchange code for short-lived token
    const shortLivedResponse = await fetch(
        `${GRAPH_API_BASE}/oauth/access_token?` + new URLSearchParams({
            client_id: META_APP_ID,
            client_secret: META_APP_SECRET,
            redirect_uri: INSTAGRAM_CALLBACK_URL,
            code,
        })
    );

    const shortLivedData = await shortLivedResponse.json();

    if (shortLivedData.error) {
        console.error('Meta OAuth token exchange error:', shortLivedData.error);
        throw new Error(`Meta OAuth error: ${shortLivedData.error.message}`);
    }

    // Step 2: Exchange short-lived token for long-lived token
    const longLivedResponse = await fetch(
        `${GRAPH_API_BASE}/oauth/access_token?` + new URLSearchParams({
            grant_type: 'fb_exchange_token',
            client_id: META_APP_ID,
            client_secret: META_APP_SECRET,
            fb_exchange_token: shortLivedData.access_token,
        })
    );

    const longLivedData = await longLivedResponse.json();

    if (longLivedData.error) {
        console.error('Meta long-lived token exchange error:', longLivedData.error);
        throw new Error(`Meta long-lived token error: ${longLivedData.error.message}`);
    }

    return {
        access_token: longLivedData.access_token,
        expires_in: longLivedData.expires_in,
    };
}

/**
 * Get the user's Instagram Business Account from their Facebook Pages
 * Finds the first page with an instagram_business_account, retrieves
 * a page access token (long-lived, doesn't expire) and the IG username.
 * @param {string} userAccessToken - The user's long-lived access token
 * @returns {Promise<{ig_user_id: string, ig_username: string, page_id: string, page_access_token: string}>}
 * @throws {'NO_INSTAGRAM_ACCOUNT'} If no connected Instagram account is found
 */
export async function getInstagramAccount(userAccessToken) {
    // Get user's Facebook Pages with instagram_business_account field
    const pagesResponse = await fetch(
        `${GRAPH_API_BASE}/me/accounts?` + new URLSearchParams({
            fields: 'id,name,instagram_business_account,access_token',
            access_token: userAccessToken,
        })
    );

    const pagesData = await pagesResponse.json();

    if (pagesData.error) {
        console.error('Meta Pages API error:', pagesData.error);
        throw new Error(`Meta Pages API error: ${pagesData.error.message}`);
    }

    // Find the first page with an Instagram Business Account
    const pageWithIG = pagesData.data?.find(
        (page) => page.instagram_business_account
    );

    if (!pageWithIG) {
        throw 'NO_INSTAGRAM_ACCOUNT';
    }

    const igUserId = pageWithIG.instagram_business_account.id;
    const pageId = pageWithIG.id;
    const pageAccessToken = pageWithIG.access_token;

    // Get the IG username
    const igResponse = await fetch(
        `${GRAPH_API_BASE}/${igUserId}?` + new URLSearchParams({
            fields: 'username',
            access_token: pageAccessToken,
        })
    );

    const igData = await igResponse.json();

    if (igData.error) {
        console.error('Instagram account API error:', igData.error);
        throw new Error(`Instagram account API error: ${igData.error.message}`);
    }

    return {
        ig_user_id: igUserId,
        ig_username: igData.username,
        page_id: pageId,
        page_access_token: pageAccessToken,
    };
}

/**
 * Refresh a long-lived token before it expires
 * @param {string} currentToken - The current long-lived access token to refresh
 * @returns {Promise<{access_token: string, expires_in: number}>}
 */
export async function refreshLongLivedToken(currentToken) {
    const response = await fetch(
        `${GRAPH_API_BASE}/oauth/access_token?` + new URLSearchParams({
            grant_type: 'fb_exchange_token',
            client_id: META_APP_ID,
            client_secret: META_APP_SECRET,
            fb_exchange_token: currentToken,
        })
    );

    const data = await response.json();

    if (data.error) {
        console.error('Meta token refresh error:', data.error);
        throw new Error(`Meta token refresh error: ${data.error.message}`);
    }

    return {
        access_token: data.access_token,
        expires_in: data.expires_in,
    };
}

/**
 * Reply to an Instagram comment
 * @param {string} commentId - The comment ID to reply to
 * @param {string} message - The reply message text
 * @param {string} accessToken - The page access token
 * @returns {Promise<object>} The API response data
 */
export async function replyToComment(commentId, message, accessToken) {
    const response = await fetch(`${GRAPH_API_BASE}/${commentId}/replies`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            message,
            access_token: accessToken,
        }),
    });

    const data = await response.json();

    if (data.error) {
        console.error('Instagram reply error:', data.error);
        throw new Error(`Instagram reply error: ${data.error.message}`);
    }

    return data;
}

/**
 * Get media details (timestamp) for an Instagram media object
 * @param {string} mediaId - The media ID
 * @param {string} accessToken - The page access token
 * @returns {Promise<object|null>} The media data with timestamp, or null on error
 */
export async function getMediaDetails(mediaId, accessToken) {
    try {
        const response = await fetch(
            `${GRAPH_API_BASE}/${mediaId}?` + new URLSearchParams({
                fields: 'timestamp',
                access_token: accessToken,
            })
        );

        const data = await response.json();

        if (data.error) {
            console.error('Instagram media details error:', data.error);
            return null;
        }

        return data;
    } catch (error) {
        console.error('Error fetching media details:', error);
        return null;
    }
}

/**
 * Check if a comment already has a reply from the given Instagram user
 * @param {string} commentId - The comment ID to check
 * @param {string} igUserId - The Instagram user ID to check for
 * @param {string} accessToken - The page access token
 * @returns {Promise<boolean>} True if the IG user has already replied
 */
export async function hasExistingReply(commentId, igUserId, accessToken) {
    try {
        const response = await fetch(
            `${GRAPH_API_BASE}/${commentId}/replies?` + new URLSearchParams({
                fields: 'from',
                access_token: accessToken,
            })
        );

        const data = await response.json();

        if (data.error) {
            console.error('Instagram replies check error:', data.error);
            return false;
        }

        return data.data?.some((reply) => reply.from?.id === igUserId) ?? false;
    } catch (error) {
        console.error('Error checking existing replies:', error);
        return false;
    }
}

/**
 * Verify the webhook signature from Meta using HMAC-SHA256
 * Compares the x-hub-signature-256 header value against the computed signature
 * @param {Buffer|string} rawBody - The raw request body
 * @param {string} signature - The x-hub-signature-256 header value (with 'sha256=' prefix)
 * @returns {boolean} Whether the signature is valid
 */
export function verifyWebhookSignature(rawBody, signature) {
    if (!signature || !META_APP_SECRET) {
        return false;
    }

    const signatureHash = signature.replace('sha256=', '');

    const expectedHash = crypto
        .createHmac('sha256', META_APP_SECRET)
        .update(rawBody)
        .digest('hex');

    try {
        return crypto.timingSafeEqual(
            Buffer.from(signatureHash),
            Buffer.from(expectedHash)
        );
    } catch (error) {
        // timingSafeEqual throws if buffers have different lengths
        return false;
    }
}

/**
 * Subscribe a Facebook Page to webhook events (feed)
 * @param {string} pageId - The Facebook Page ID
 * @param {string} pageAccessToken - The page access token
 * @returns {Promise<object>} The API response data
 */
export async function subscribeToWebhooks(pageId, pageAccessToken) {
    const response = await fetch(`${GRAPH_API_BASE}/${pageId}/subscribed_apps`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            subscribed_fields: 'feed',
            access_token: pageAccessToken,
        }),
    });

    const data = await response.json();

    if (data.error) {
        console.error('Instagram webhook subscription error:', data.error);
        throw new Error(`Webhook subscription error: ${data.error.message}`);
    }

    return data;
}
