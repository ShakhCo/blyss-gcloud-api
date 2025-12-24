import { Router } from 'express';
import { validate } from '../middleware/validate.js';
import { placeSearchSchema } from '../schemas/places.js';

const router = Router();

// Search places using Google Places API (restricted to Uzbekistan)
router.get('/search', validate(placeSearchSchema, 'query'), async (req, res) => {
    try {
        const { query } = req.validated;

        const apiKey = process.env.GOOGLE_PLACES_API_KEY;
        if (!apiKey) {
            return res.status(500).json({ error: 'Google Places API key not configured', error_code: 'API_KEY_MISSING' });
        }

        // Uzbekistan center coordinates and search parameters
        const uzbekistanLat = 41.377491;
        const uzbekistanLng = 64.585262;
        const radiusMeters = 800000; // 800km to cover all of Uzbekistan

        const url = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(query)}&location=${uzbekistanLat},${uzbekistanLng}&radius=${radiusMeters}&region=uz&key=${apiKey}`;

        const response = await fetch(url);
        const data = await response.json();

        if (data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
            return res.status(400).json({
                error: data.error_message || 'Failed to search places',
                error_code: data.status
            });
        }

        // Format results with all data
        const places = (data.results || []).map(place => ({
            place_id: place.place_id,
            name: place.name,
            business_status: place.business_status ?? null,
            formatted_address: place.formatted_address,
            geometry: place.geometry,
            icon: place.icon,
            icon_background_color: place.icon_background_color,
            icon_mask_base_uri: place.icon_mask_base_uri,
            opening_hours: place.opening_hours ?? null,
            photos: place.photos?.map(photo => ({
                height: photo.height,
                width: photo.width,
                photo_reference: photo.photo_reference,
                photo_url: `https://maps.googleapis.com/maps/api/place/photo?maxwidth=400&photoreference=${photo.photo_reference}&key=${apiKey}`
            })) ?? [],
            rating: place.rating ?? null,
            user_ratings_total: place.user_ratings_total ?? null,
            types: place.types || [],
            reference: place.reference
        }));

        res.json({
            results: places,
            total: places.length,
            status: data.status
        });
    } catch (error) {
        res.status(500).json({ error: error.message, error_code: 'INTERNAL_ERROR' });
    }
});

export default router;
