/**
 * Cloudflare DNS utility for managing subdomain records
 */

const CLOUDFLARE_API_BASE = 'https://api.cloudflare.com/client/v4';

/**
 * Generate a clean, URL-friendly subdomain from a business name
 * @param {string} businessName - The original business name
 * @param {string} businessId - The unique business ID (for fallback)
 * @returns {string} - A URL-friendly subdomain name
 */
export function generateSubdomainName(businessName, businessId) {
    // Remove special characters, convert to lowercase, replace spaces with hyphens
    const cleaned = businessName
        .toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // Remove accents
        .replace(/[^a-z0-9\s-]/g, '') // Remove special chars except spaces and hyphens
        .trim()
        .replace(/\s+/g, '-') // Replace spaces with hyphens
        .replace(/-+/g, '-') // Remove duplicate hyphens
        .substring(0, 50); // Limit to 50 characters

    // Fallback to business ID if name becomes empty
    const baseName = cleaned || businessId;

    return baseName;
}

/**
 * Check if a DNS record already exists in Cloudflare
 * @param {string} subdomainName - The subdomain name to check
 * @param {object} config - Cloudflare configuration
 * @returns {Promise<boolean>} - True if record exists
 */
export async function dnsRecordExists(subdomainName, config) {
    const { zoneId, apiToken, zoneDomain } = config;

    try {
        const response = await fetch(
            `${CLOUDFLARE_API_BASE}/zones/${zoneId}/dns_records?type=A&name=${subdomainName}.${zoneDomain}`,
            {
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${apiToken}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        const data = await response.json();

        if (data.success && data.result && data.result.length > 0) {
            return true; // Record exists
        }

        return false; // Record doesn't exist
    } catch (error) {
        console.error('Error checking DNS record:', error);
        throw new Error(`Failed to check DNS record: ${error.message}`);
    }
}

/**
 * Create a DNS record in Cloudflare
 * @param {string} subdomainName - The subdomain name
 * @param {string} ip - The IP address to point to
 * @param {object} config - Cloudflare configuration
 * @returns {Promise<object>} - The created DNS record data
 */
export async function createDnsRecord(subdomainName, ip, config) {
    const { zoneId, apiToken, zoneDomain } = config;

    try {
        const response = await fetch(
            `${CLOUDFLARE_API_BASE}/zones/${zoneId}/dns_records`,
            {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${apiToken}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    type: 'A',
                    name: subdomainName,
                    content: ip,
                    proxied: false
                })
            }
        );

        const data = await response.json();

        if (data.success) {
            return data.result;
        }

        // Check for duplicate record error
        if (data.errors && data.errors.some(e => e.code === 81058)) {
            return null; // Indicates duplicate
        }

        throw new Error(data.errors?.map(e => e.message).join(', ') || 'Failed to create DNS record');
    } catch (error) {
        console.error('Error creating DNS record:', error);
        throw error;
    }
}

/**
 * Suggest and create a unique subdomain for a business
 * Generates a subdomain from the business name and tries variations until finding an available one
 * @param {string} businessName - The business name
 * @param {string} businessId - The unique business ID
 * @param {string} ip - The IP address to point to
 * @param {object} config - Cloudflare configuration
 * @returns {Promise<{subdomain: string, fullUrl: string, record: object}>}
 */
export async function suggestAndCreateSubdomain(businessName, businessId, ip, config) {
    const { zoneDomain } = config;
    const baseSubdomain = generateSubdomainName(businessName, businessId);

    let attempt = 0;
    const maxAttempts = 10;

    while (attempt < maxAttempts) {
        let subdomainName = baseSubdomain;

        // Add suffix for subsequent attempts
        if (attempt > 0) {
            subdomainName = `${baseSubdomain}-${attempt}`;
        }

        try {
            // Try to create the DNS record
            const record = await createDnsRecord(subdomainName, ip, config);

            if (record) {
                // Success! Return the subdomain info
                const fullUrl = `${subdomainName}.${zoneDomain}`;
                return {
                    subdomain: subdomainName,
                    fullUrl: fullUrl,
                    record: record
                };
            }

            // Record returned null means it's a duplicate, try next variation
            attempt++;
        } catch (error) {
            // If it's not a duplicate error, re-throw
            if (!error.message?.includes('81058') && !error.message?.includes('already exists')) {
                throw error;
            }
            attempt++;
        }
    }

    throw new Error(`Unable to create unique subdomain after ${maxAttempts} attempts`);
}

/**
 * Get Cloudflare config from environment variables
 * @returns {object} - Cloudflare configuration
 */
export function getCloudflareConfig() {
    const zoneId = process.env.CLOUDFLARE_ZONE_ID;
    const apiToken = process.env.CLOUDFLARE_API_TOKEN;
    const zoneDomain = process.env.CLOUDFLARE_ZONE_DOMAIN || 'blyss.uz';
    const serverIp = process.env.SERVER_IP || '164.68.109.33';

    if (!zoneId || !apiToken) {
        throw new Error('Missing required Cloudflare environment variables: CLOUDFLARE_ZONE_ID, CLOUDFLARE_API_TOKEN');
    }

    return {
        zoneId,
        apiToken,
        zoneDomain,
        serverIp
    };
}
