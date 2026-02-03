import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import routes from './routes/index.js';
import { upload } from './config/multer.js';

const app = express();
const PORT = process.env.PORT || 3000;

// Trust proxy for rate limiting (behind Cloudflare/Google Cloud)
// Use 1 to trust only the first proxy hop (recommended for Cloud Run)
app.set('trust proxy', 1);

app.use(cors({
    origin: [
        'https://botservice.blyss.uz',
        'https://miniapp.blyss.uz',
        'https://business-miniapp.blyss.uz',
        "https://barbershop-miniapp-beta.automations.uz"
    ],
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Timestamp', 'X-Signature'],
    credentials: true
}));

app.use(cookieParser());

// IMPORTANT: Parse JSON and URL-encoded bodies BEFORE routes
// Remove express.text() - it interferes with JSON parsing
app.use(express.json({ limit: '10mb' })); // Added limit for larger payloads
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

app.get('/', (req, res) => {
    res.send('Hello world');
});

// Debug endpoint to test body parsing
app.post('/debug-body', (req, res) => {
    console.log('Headers:', req.headers);
    console.log('Body:', req.body);
    res.json({
        'content-type': req.headers['content-type'],
        'body-exists': !!req.body,
        'body-type': typeof req.body,
        'body-keys': Object.keys(req.body || {}),
        'body': req.body
    });
});

// For multipart/form-data with files, use multer on specific routes
// Example: app.post('/upload', upload.single('file'), (req, res) => { ... })

app.use(routes);

app.listen(PORT, () => {
    console.log(`App is running on port: http://localhost:${PORT}`);
});

export default app;