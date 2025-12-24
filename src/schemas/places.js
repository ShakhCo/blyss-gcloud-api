import { z } from 'zod';

// Input schema for place search
export const placeSearchSchema = z.object({
    query: z.string({ required_error: 'query is required' })
        .min(1, 'query is required')
});

// Output schema for place result
export const placeResultSchema = z.object({
    place_id: z.string(),
    name: z.string(),
    address: z.string(),
    location: z.object({
        lat: z.number(),
        lng: z.number()
    }),
    rating: z.number().nullable(),
    user_ratings_total: z.number().nullable(),
    types: z.array(z.string()),
    open_now: z.boolean().nullable(),
    photo_url: z.string().nullable()
});
