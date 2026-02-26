/**
 * Instagram API utilities for Instagram Business Login integration
 */

import crypto from 'crypto';

const INSTAGRAM_APP_ID = process.env.INSTAGRAM_APP_ID?.trim();
const INSTAGRAM_APP_SECRET = process.env.INSTAGRAM_APP_SECRET?.trim();
const INSTAGRAM_CALLBACK_URL = process.env.INSTAGRAM_CALLBACK_URL?.trim();

const GRAPH_API_BASE = 'https://graph.instagram.com';

/**
 * Build the Instagram OAuth URL for Business Login authorization
 * @param {string} businessId - The business ID to pass as state parameter
 * @returns {string} The full OAuth authorization URL
 */
export function getOAuthUrl(businessId) {
    const params = new URLSearchParams({
        client_id: INSTAGRAM_APP_ID,
        redirect_uri: INSTAGRAM_CALLBACK_URL,
        scope: 'instagram_business_basic,instagram_business_manage_comments,instagram_business_manage_insights',
        response_type: 'code',
        state: businessId,
    });

    return `https://www.instagram.com/oauth/authorize?${params.toString()}`;
}

/**
 * Exchange an authorization code for a long-lived access token
 * First exchanges code for short-lived token, then exchanges for long-lived token (~60 days)
 * @param {string} code - The authorization code from OAuth callback
 * @returns {Promise<{access_token: string, expires_in: number}>}
 */
export async function exchangeCodeForToken(code) {
    // Step 1: Exchange code for short-lived token
    const shortLivedResponse = await fetch('https://api.instagram.com/oauth/access_token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            client_id: INSTAGRAM_APP_ID,
            client_secret: INSTAGRAM_APP_SECRET,
            grant_type: 'authorization_code',
            redirect_uri: INSTAGRAM_CALLBACK_URL,
            code,
        }),
    });

    const shortLivedData = await shortLivedResponse.json();

    if (shortLivedData.error_type || shortLivedData.error) {
        console.error('Instagram OAuth token exchange error:', shortLivedData);
        throw new Error(`Instagram OAuth error: ${shortLivedData.error_message || shortLivedData.error?.message || 'Unknown error'}`);
    }

    // Step 2: Exchange short-lived token for long-lived token
    const longLivedResponse = await fetch(
        `${GRAPH_API_BASE}/v21.0/access_token?` + new URLSearchParams({
            grant_type: 'ig_exchange_token',
            client_secret: INSTAGRAM_APP_SECRET,
            access_token: shortLivedData.access_token,
        })
    );

    const longLivedData = await longLivedResponse.json();

    if (longLivedData.error) {
        console.error('Instagram long-lived token exchange error:', longLivedData.error);
        throw new Error(`Instagram long-lived token error: ${longLivedData.error.message}`);
    }

    return {
        access_token: longLivedData.access_token,
        user_id: shortLivedData.user_id,
        expires_in: longLivedData.expires_in,
    };
}

/**
 * Get the Instagram user's profile info using their access token
 * @param {string} accessToken - The user's long-lived access token
 * @param {string} userId - The Instagram user ID from token exchange
 * @returns {Promise<{ig_user_id: string, ig_username: string, profile_picture_url: string|null, followers_count: number, follows_count: number, media_count: number}>}
 */
export async function getInstagramProfile(accessToken, userId) {
    const response = await fetch(
        `${GRAPH_API_BASE}/v21.0/me?` + new URLSearchParams({
            fields: 'user_id,username,profile_picture_url,followers_count,follows_count,media_count',
            access_token: accessToken,
        })
    );

    const data = await response.json();

    if (data.error) {
        console.error('Instagram profile API error:', data.error);
        throw new Error(`Instagram profile API error: ${data.error.message}`);
    }

    return {
        ig_user_id: String(data.user_id || userId),
        ig_username: data.username,
        profile_picture_url: data.profile_picture_url || null,
        followers_count: data.followers_count || 0,
        follows_count: data.follows_count || 0,
        media_count: data.media_count || 0,
    };
}

/**
 * Refresh a long-lived Instagram token before it expires
 * @param {string} currentToken - The current long-lived access token to refresh
 * @returns {Promise<{access_token: string, expires_in: number}>}
 */
export async function refreshLongLivedToken(currentToken) {
    const response = await fetch(
        `${GRAPH_API_BASE}/refresh_access_token?` + new URLSearchParams({
            grant_type: 'ig_refresh_token',
            access_token: currentToken,
        })
    );

    const data = await response.json();

    if (data.error) {
        console.error('Instagram token refresh error:', data.error);
        throw new Error(`Instagram token refresh error: ${data.error.message}`);
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
 * @param {string} accessToken - The access token
 * @returns {Promise<object>} The API response data
 */
export async function replyToComment(commentId, message, accessToken) {
    const response = await fetch(`${GRAPH_API_BASE}/v21.0/${commentId}/replies`, {
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
 * @param {string} accessToken - The access token
 * @returns {Promise<object|null>} The media data with timestamp, or null on error
 */
export async function getMediaDetails(mediaId, accessToken) {
    try {
        const response = await fetch(
            `${GRAPH_API_BASE}/v21.0/${mediaId}?` + new URLSearchParams({
                fields: 'timestamp,caption',
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
 * @param {string} accessToken - The access token
 * @returns {Promise<boolean>} True if the IG user has already replied
 */
export async function hasExistingReply(commentId, igUserId, accessToken) {
    try {
        const response = await fetch(
            `${GRAPH_API_BASE}/v21.0/${commentId}/replies?` + new URLSearchParams({
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
 * Get Instagram posts (media) for a user
 * Uses cursor-based pagination from the Instagram Graph API
 * @param {string} accessToken - The user's access token
 * @param {string} igUserId - The Instagram user ID
 * @param {object} options - Pagination options
 * @param {number} [options.limit=20] - Number of posts to return (max 100)
 * @param {string} [options.after] - Cursor for next page
 * @returns {Promise<{posts: Array, pagination: {has_next: boolean, next_cursor: string|null}}>}
 */
export async function getInstagramPosts(accessToken, igUserId, { limit = 20, after } = {}) {
    const params = new URLSearchParams({
        fields: 'id,caption,media_type,media_url,thumbnail_url,permalink,timestamp,like_count,comments_count',
        limit: String(limit),
        access_token: accessToken,
    });

    if (after) {
        params.set('after', after);
    }

    const response = await fetch(
        `${GRAPH_API_BASE}/v21.0/${igUserId}/media?${params}`
    );

    const data = await response.json();

    if (data.error) {
        console.error('Instagram posts fetch error:', data.error);
        throw new Error(`Instagram posts error: ${data.error.message}`);
    }

    const rawPosts = (data.data || []).map((post) => ({
        id: post.id,
        caption: post.caption || '',
        media_type: post.media_type,
        media_url: post.media_url || null,
        thumbnail_url: post.thumbnail_url || null,
        permalink: post.permalink,
        timestamp: post.timestamp,
        like_count: post.like_count,
        comments_count: post.comments_count,
    }));

    // Fetch view counts (impressions) in parallel
    const viewCounts = await Promise.all(
        rawPosts.map((post) => getMediaImpressions(post.id, accessToken))
    );

    const posts = rawPosts.map((post, i) => ({
        ...post,
        view_count: viewCounts[i],
    }));

    const nextCursor = data.paging?.cursors?.after || null;
    const hasNext = !!data.paging?.next;

    return {
        posts,
        pagination: {
            has_next: hasNext,
            next_cursor: nextCursor,
        },
    };
}

/**
 * Get impressions (view count) for a single media item
 * @param {string} mediaId - The media ID
 * @param {string} accessToken - The access token
 * @returns {Promise<number|undefined>} The impressions count, or undefined if unavailable
 */
async function getMediaImpressions(mediaId, accessToken) {
    try {
        const response = await fetch(
            `${GRAPH_API_BASE}/v21.0/${mediaId}/insights?` + new URLSearchParams({
                metric: 'impressions',
                access_token: accessToken,
            })
        );
        const data = await response.json();
        if (data.error) return undefined;
        return data.data?.[0]?.values?.[0]?.value;
    } catch {
        return undefined;
    }
}

/**
 * Get carousel/album children media items
 * @param {string} mediaId - The carousel media ID
 * @param {string} accessToken - The access token
 * @returns {Promise<Array<{id: string, media_type: string, media_url: string|null, thumbnail_url: string|null}>>}
 */
export async function getCarouselChildren(mediaId, accessToken) {
    const response = await fetch(
        `${GRAPH_API_BASE}/v21.0/${mediaId}/children?` + new URLSearchParams({
            fields: 'id,media_type,media_url,thumbnail_url',
            access_token: accessToken,
        })
    );

    const data = await response.json();

    if (data.error) {
        console.error('Instagram carousel children error:', data.error);
        throw new Error(`Instagram carousel children error: ${data.error.message}`);
    }

    return (data.data || []).map((item) => ({
        id: item.id,
        media_type: item.media_type,
        media_url: item.media_url || null,
        thumbnail_url: item.thumbnail_url || null,
    }));
}

/**
 * Verify the webhook signature from Meta using HMAC-SHA256
 * Compares the x-hub-signature-256 header value against the computed signature
 * @param {Buffer|string} rawBody - The raw request body
 * @param {string} signature - The x-hub-signature-256 header value (with 'sha256=' prefix)
 * @returns {boolean} Whether the signature is valid
 */
export function verifyWebhookSignature(rawBody, signature) {
    if (!signature || !INSTAGRAM_APP_SECRET) {
        return false;
    }

    const signatureHash = signature.replace('sha256=', '');

    const expectedHash = crypto
        .createHmac('sha256', INSTAGRAM_APP_SECRET)
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
