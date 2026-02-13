import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import routes from './routes/index.js';
import { upload } from './config/multer.js';

const app = express();
const PORT = process.env.PORT || 3000;

// Trust proxy for rate limiting (behind Cloudflare/Google Cloud)
// Use 1 to trust only the first proxy hop (recommended for Cloud Run)
app.set('trust proxy', 1);

// Security headers
app.use(helmet());

app.use(cors({
    origin: (origin, callback) => {
        const allowed = [
            'https://botservice.blyss.uz',
            'https://miniapp.blyss.uz',
            'https://barbershop-miniapp-beta.automations.uz'
        ];
        // Only allow [a-z0-9-]+-miniapp.blyss.uz (no underscores or special chars)
        if (!origin || allowed.includes(origin) || /^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?-miniapp\.blyss\.uz$/.test(origin)) {
            callback(null, true);
        } else {
            callback(new Error('Not allowed by CORS'));
        }
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Timestamp', 'X-Signature'],
    credentials: true
}));

app.use(cookieParser());

// IMPORTANT: Parse JSON and URL-encoded bodies BEFORE routes
// Remove express.text() - it interferes with JSON parsing
app.use(express.json({
    limit: '1mb',
    verify: (req, _res, buf) => { req.rawBody = buf.toString('utf-8'); }
}));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

app.get('/', (req, res) => {
    res.send('Hello world');
});

// For multipart/form-data with files, use multer on specific routes
// Example: app.post('/upload', upload.single('file'), (req, res) => { ... })

app.use(routes);

app.listen(PORT, () => {
    console.log(`App is running on port: http://localhost:${PORT}`);
});

export default app;