export const validate = (schema) => (req, res, next) => {
    if (!req.body || Object.keys(req.body).length === 0) {
        return res.status(400).json({ error: 'Request body is required', error_code: 'EMPTY_BODY' });
    }
    const result = schema.safeParse(req.body);
    if (!result.success) {
        const validation_errors = result.error.issues.map(e => ({
            field: e.path.join('.'),
            error: e.message
        }));
        return res.status(400).json({ validation_errors, error_code: 'VALIDATION_ERROR' });
    }
    req.validated = result.data;
    next();
};
