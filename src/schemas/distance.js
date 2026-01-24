import { z } from 'zod';

// Location schema
const locationSchema = z.object({
    lat: z.number({
        required_error: 'lat is required',
        invalid_type_error: 'lat must be a number'
    }).min(-90, 'lat must be between -90 and 90')
     .max(90, 'lat must be between -90 and 90'),
    lng: z.number({
        required_error: 'lng is required',
        invalid_type_error: 'lng must be a number'
    }).min(-180, 'lng must be between -180 and 180')
     .max(180, 'lng must be between -180 and 180')
});

// Query schema for distance calculation
export const distanceQuerySchema = z.object({
    user_location: locationSchema,
    business_location: locationSchema
});
