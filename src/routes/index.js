import { Router } from 'express';
import authRouter from './auth.js';
import usersRouter from './users.js';
import otpRouter from './otp.js';
import businessOwnersRouter from './businessOwners.js';
import businessesRouter from './businesses.js';
import placesRouter from './places.js';
import employeesRouter from './employees.js';
import publicRouter from './public.js';
import notificationsRouter from './notifications.js';
import distanceRouter from './distance.js';

const router = Router();

router.use('/auth', authRouter);
router.use('/users', usersRouter);
router.use('/otp', otpRouter);
router.use('/business-owners', businessOwnersRouter);
router.use('/businesses', businessesRouter);
router.use('/places', placesRouter);
router.use('/employees', employeesRouter);
router.use('/public', publicRouter);
router.use('/notifications', notificationsRouter);
router.use('/distance', distanceRouter);

export default router;
