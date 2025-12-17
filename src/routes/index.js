import { Router } from 'express';
import usersRouter from './users.js';
import otpRouter from './otp.js';

const router = Router();

router.use('/users', usersRouter);
router.use('/otp', otpRouter);

export default router;
