import { Storage } from '@google-cloud/storage';

let storage = null;
const bucketName = process.env.GCS_BUCKET_NAME || 'blyss';

function getStorage() {
    if (!storage) {
        storage = new Storage();
    }
    return storage;
}

/**
 * Upload a file to Google Cloud Storage
 * @param {Buffer} buffer - File buffer
 * @param {string} filename - Destination filename (will be prefixed with business ID)
 * @param {string} contentType - MIME type of the file
 * @returns {Promise<string>} - Public URL of the uploaded file
 */
export async function uploadFile(buffer, filename, contentType = 'image/jpeg') {
    const bucket = getStorage().bucket(bucketName);
    const file = bucket.file(filename);

    await file.save(buffer, {
        contentType,
        metadata: { cacheControl: 'public, max-age=31536000' }
    });

    // Make file publicly readable
    await file.makePublic();

    return `https://storage.googleapis.com/${bucketName}/${filename}`;
}

/**
 * Delete a file from Google Cloud Storage
 * @param {string} filename - Filename to delete
 * @returns {Promise<void>}
 */
export async function deleteFile(filename) {
    const bucket = getStorage().bucket(bucketName);
    const file = bucket.file(filename);
    await file.delete();
}

/**
 * Get the GCS filename from a full URL
 * @param {string} url - Full GCS URL
 * @returns {string|null} - Filename or null if not a GCS URL
 */
export function getFilenameFromUrl(url) {
    if (!url) return null;
    const match = url.match(/\/([^/]+)$/);
    return match ? match[1] : null;
}
