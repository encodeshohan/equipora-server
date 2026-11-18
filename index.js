import express from "express"
import cors from "cors"
import "dotenv/config"
import { MongoClient, ObjectId } from "mongodb"

const app = express()
const port = process.env.PORT || 5000

// middleware
const allowedOrigins = (process.env.CLIENT_URLS || "http://localhost:3000")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean)

app.use(express.json())
app.use(
    cors({
        origin: (origin, callback) => {
            // no Origin header = server-to-server call (Next.js server, curl)
            if (!origin || allowedOrigins.includes(origin)) {
                return callback(null, true)
            }
            callback(null, false)
        },
        methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
        allowedHeaders: ["Content-Type", "Authorization"],
    })
)

// mongodb connection (top-level await, same as the mentor)
if (!process.env.MONGODB_URI) {
    console.error("MONGODB_URI is missing in .env")
    process.exit(1)
}

const client = new MongoClient(process.env.MONGODB_URI)

try {
    await client.connect()
    await client.db("equiporadb").command({ ping: 1 })
    console.log("You successfully connected to MongoDB (equiporadb)!")
} catch (err) {
    console.error("MongoDB connection failed:", err.message)
    process.exit(1)
}

const database = client.db("equiporadb")
const users = database.collection("user") // better-auth
const sessions = database.collection("session") // better-auth
const equipment = database.collection("equipment")
const bookings = database.collection("bookings")
const favorites = database.collection("favorites")
const payments = database.collection("payments")
const reviews = database.collection("reviews")

// indexes: block payment replays and duplicate favorites at the DB level
try {
    await payments.createIndex({ sessionId: 1 }, { unique: true })
    await favorites.createIndex({ userId: 1, equipmentId: 1 }, { unique: true })
} catch (err) {
    console.error("Index setup failed:", err.message)
}

// helpers
// returns an ObjectId, or null for anything that is not a valid 24-hex id
const toObjectId = (id) => {
    if (id instanceof ObjectId) return id
    if (typeof id !== "string" || !/^[a-f\d]{24}$/i.test(id)) return null
    return new ObjectId(id)
}

// middlewares
// reads `Authorization: Bearer <token>`, finds it in the better-auth
// `session` collection and puts the user on req.user
const verifyToken = async (req, res, next) => {
    const authHeader = req.headers.authorization
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return res.status(401).send({ message: "Unauthorized" })
    }

    const token = authHeader.slice(7).trim()
    if (!token) {
        return res.status(401).send({ message: "Unauthorized" })
    }

    const session = await sessions.findOne({ token })
    if (!session) {
        return res.status(401).send({ message: "Unauthorized" })
    }

    if (session.expiresAt && new Date(session.expiresAt) < new Date()) {
        return res.status(401).send({ message: "Unauthorized" })
    }

    const userId = toObjectId(session.userId)
    if (!userId) {
        return res.status(401).send({ message: "Unauthorized" })
    }

    const user = await users.findOne({ _id: userId })
    if (!user) {
        return res.status(401).send({ message: "Unauthorized" })
    }

    if (user.banned) {
        return res.status(403).send({ message: "Forbidden" })
    }

    req.user = user
    next()
}

// role guards: must run after verifyToken
const requireRole = (role) => (req, res, next) => {
    if (!req.user || req.user.role !== role) {
        return res.status(403).send({ message: "Forbidden" })
    }
    next()
}

const verifyRenter = requireRole("customer")
const verifyOwner = requireRole("owner")
const verifyAdmin = requireRole("admin")

app.get("/", (req, res) => {
    res.send("Equipora server is running")
})

// users related apis
app.get("/me", verifyToken, async (req, res) => {
    const { _id, name, email, role, image } = req.user
    res.send({ id: _id.toString(), name, email, role, image: image ?? null })
})

// TEMPORARY guard checks, removed in Step 4
app.get("/dev/ping/renter", verifyToken, verifyRenter, (req, res) => {
    res.send({ ok: true, role: req.user.role })
})
app.get("/dev/ping/owner", verifyToken, verifyOwner, (req, res) => {
    res.send({ ok: true, role: req.user.role })
})
app.get("/dev/ping/admin", verifyToken, verifyAdmin, (req, res) => {
    res.send({ ok: true, role: req.user.role })
})

// 404 + error handler (Express 5 forwards rejected async handlers here)
app.use((req, res) => {
    res.status(404).send({ message: "Not found" })
})

app.use((err, req, res, next) => {
    const status = err.status >= 400 && err.status < 500 ? err.status : 500
    console.error("Request failed:", req.method, req.path, err.message)
    res.status(status).send({
        message: status === 500 ? "Internal server error" : err.message,
    })
})

app.listen(port, () => {
    console.log(`Equipora server is running on port ${port}`)
})

export default app