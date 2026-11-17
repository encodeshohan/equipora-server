import express from 'express';
import "dotenv/config";
import { MongoClient} from "mongodb";
import cors from 'cors';

const app = express();
const port = process.env.PORT || 5000;

// Middleware
app.use(express.json());
app.use(cors());

const client = new MongoClient(process.env.MONGODB_URI);

app.get('/', (req, res) => {
    res.send("Equipora is RUNNING")
})

app.listen(port, ()=>{
    console.log(`Equipora is running on port ${port}`)
})