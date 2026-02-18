import { z } from 'zod';

// Individual rating for a service item
const ratingItemSchema = z.object({
    booking_item_id: z.string().min(1, 'booking_item_id is required'),
    rating: z.number().int().min(1, 'rating must be at least 1').max(5, 'rating must be at most 5')
});

// Submit review schema
export const submitReviewSchema = z.object({
    ratings: z.array(ratingItemSchema).min(1, 'at least one rating is required'),
    comment: z.string().max(1000, 'comment must be 1000 characters or less').optional().default('')
});
