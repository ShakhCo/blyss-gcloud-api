import { z } from 'zod';

// Location schema - use coerce to convert strings to numbers
const locationSchema = z.object({
    lat: z.coerce.number({
        required_error: 'lat is required',
        invalid_type_error: 'lat must be a number'
    }).min(-90, 'lat must be between -90 and 90')
     .max(90, 'lat must be between -90 and 90'),
    lng: z.coerce.number({
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

// Body schema for POST distance calculation
export const distanceBodySchema = z.object({
    from: locationSchema,
    to: locationSchema
});
