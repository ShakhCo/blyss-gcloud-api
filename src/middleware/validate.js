export const validate = (schema) => (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
        const validation_errors = result.error.issues.map(e => ({
            field: e.path.join('.') || 'body',
            error: e.message
        }));
        return res.status(400).json({ validation_errors });
    }
    req.validated = result.data;
    next();
};
