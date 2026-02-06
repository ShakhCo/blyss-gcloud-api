export const validate = (schema, source = 'body') => (req, res, next) => {
    const data = source === 'query' ? (req.parsedQuery || req.query) : req.body;

    if (source === 'body' && (!data || Object.keys(data).length === 0)) {
        return res.status(400).json({ error: 'Request body is required', error_code: 'EMPTY_REQUEST' });
    }

    const result = schema.safeParse(data);
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
