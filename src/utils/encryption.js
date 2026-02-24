import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

function getKey() {
    const hex = process.env.ENCRYPTION_KEY;
    if (!hex || hex.length !== 64) {
        throw new Error('ENCRYPTION_KEY must be a 64-character hex string (32 bytes)');
    }
    return Buffer.from(hex, 'hex');
}

/**
 * Encrypt plaintext using AES-256-GCM.
 * @param {string} text - Plaintext to encrypt
 * @returns {string} Format: iv:authTag:ciphertext (all hex-encoded)
 */
export function encrypt(text) {
    const key = getKey();
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });

    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag().toString('hex');

    return `${iv.toString('hex')}:${authTag}:${encrypted}`;
}

/**
 * Decrypt a string produced by encrypt().
 * @param {string} encryptedText - Format: iv:authTag:ciphertext (all hex-encoded)
 * @returns {string} Decrypted plaintext
 */
export function decrypt(encryptedText) {
    // Handle legacy unencrypted tokens (no iv:authTag:ciphertext format)
    const parts = encryptedText.split(':');
    if (parts.length !== 3) {
        return encryptedText;
    }

    const [ivHex, authTagHex, ciphertext] = parts;
    const key = getKey();
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');

    const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(ciphertext, 'hex', 'utf8');
    decrypted += decipher.final('utf8');

    return decrypted;
}
