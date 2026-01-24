import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import routes from './routes/index.js';
import { upload } from './config/multer.js';

const app = express();
const PORT = process.env.PORT || 3000;

// Trust proxy for rate limiting (behind Cloudflare/Google Cloud)
app.set('trust proxy', true);

app.use(cors({
    origin: [
        'https://business-miniapp.blyss.uz',
        'https://barbershop-miniapp-beta.automations.uz',
        "https://barbershop-miniapp.automations.uz"
    ],
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true
}));

app.use(cookieParser());

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get('/', (req, res) => {
    res.send('Hello world');
});

app.use(routes);

app.listen(PORT, () => {
    console.log(`App is running on port: http://localhost:${PORT}`);
});

export default app;
