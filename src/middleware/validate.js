export const validate = (schema, source = 'body') => (req, res, next) => {
    const data = source === 'query' ? req.query : req.body;

    if (!data || Object.keys(data).length === 0) {
        const errorMsg = source === 'query' ? 'Query parameters are required' : 'Request body is required';
        return res.status(400).json({ error: errorMsg, error_code: 'EMPTY_REQUEST' });
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
