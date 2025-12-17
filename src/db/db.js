import { Firestore } from '@google-cloud/firestore';

const db = new Firestore({
    databaseId: process.env.DATABASE_ID
});

export { db };
