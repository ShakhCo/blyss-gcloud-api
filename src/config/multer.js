import multer from 'multer';

// Multer for parsing form data without files
export const upload = multer();

// Multer for single file uploads (stored in memory)
export const uploadSingle = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 } // 5MB limit
});
