import { Router } from 'express';
import { authenticate } from '../middleware/authenticate.js';

const router = Router({ mergeParams: true });

router.use(authenticate);

export default router;
