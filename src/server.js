import 'dotenv/config';
import express from 'express';
import routes from './routes/index.js';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

app.get('/', (req, res) => {
    res.send('Hello world');
});

app.use(routes);

app.listen(PORT, () => {
    console.log(`App is running on port: http://localhost:${PORT}`);
});
