import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import routes from './routes/index.js';

const app = express();
const PORT = process.env.PORT || 3000;
const upload = multer();

app.use(cors({
    origin: [
        'https://barbershop-miniapp-beta.automations.uz',
        'https://barbershop-miniapp.automations.uz'
    ],
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type']
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(upload.none());

app.get('/', (req, res) => {
    res.send('Hello world');
});

app.use(routes);

app.listen(PORT, () => {
    console.log(`App is running on port: http://localhost:${PORT}`);
});

export default app;
