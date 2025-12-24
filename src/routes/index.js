import { Router } from 'express';
import usersRouter from './users.js';
import otpRouter from './otp.js';
import businessOwnersRouter from './businessOwners.js';
import businessesRouter from './businesses.js';
import placesRouter from './places.js';

const router = Router();

router.use('/users', usersRouter);
router.use('/otp', otpRouter);
router.use('/business-owners', businessOwnersRouter);
router.use('/businesses', businessesRouter);
router.use('/places', placesRouter);

export default router;
