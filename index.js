import express from "express"
import cors from "cors"
import "dotenv/config"
import { MongoClient, ObjectId } from "mongodb"

const app = express()
const port = process.env.PORT || 5000

const isHttpUrl = (value) => {
    try {
        const url = new URL(value)
        return url.protocol === "http:" || url.protocol === "https:"
    } catch {
        return false
    }
}

// equipment helpers
const EQUIPMENT_CATEGORIES = [
    { name: "Construction Equipment", slug: "construction-equipment" },
    { name: "Photography Equipment", slug: "photography-equipment" },
    { name: "Vehicles & Transportation", slug: "vehicles-transportation" },
    { name: "Agriculture Equipment", slug: "agriculture-equipment" },
    { name: "Electronics", slug: "electronics" },
    { name: "Event Equipment", slug: "event-equipment" },
]
const RENTAL_TYPES = ["daily", "weekly", "monthly"]
const CONDITIONS = ["new", "like-new", "good", "fair"]
const EQUIPMENT_STATUSES = ["pending", "approved", "rejected"]

const EQUIPMENT_SORTS = {
    newest: { createdAt: -1, _id: -1 },
    "price-asc": { price: 1, _id: 1 },
    "price-desc": { price: -1, _id: 1 },
}

// fields that never leave the server on public routes
const PUBLIC_PROJECTION = { ownerEmail: 0, isSeed: 0 }

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

// query params can arrive as arrays/objects (?a[$ne]=1): only strings count
const queryString = (value) => (typeof value === "string" ? value.trim() : "")

const queryNumber = (value) => {
    const text = queryString(value)
    if (text === "") return null
    const number = Number(text)
    return Number.isFinite(number) ? number : null
}

const toNumber = (value) => {
    if (typeof value === "number") return value
    if (typeof value === "string" && value.trim() !== "") return Number(value)
    return NaN
}

const trimmed = (value, min, max) => {
    if (typeof value !== "string") return undefined
    const text = value.trim()
    return text.length >= min && text.length <= max ? text : undefined
}

// each rule returns the cleaned value, or undefined when the value is invalid
const EQUIPMENT_FIELDS = {
    name: { label: "Name", required: true, clean: (v) => trimmed(v, 3, 100) },
    description: {
        label: "Description",
        required: true,
        clean: (v) => trimmed(v, 10, 2000),
    },
    category: {
        label: "Category",
        required: true,
        clean: (v) => EQUIPMENT_CATEGORIES.find((c) => c.name === v)?.name,
    },
    location: { label: "Location", required: true, clean: (v) => trimmed(v, 2, 120) },
    price: {
        label: "Price",
        required: true,
        clean: (v) => {
            const number = toNumber(v)
            return Number.isFinite(number) && number > 0 && number <= 10_000_000
                ? number
                : undefined
        },
    },
    rentalType: {
        label: "Rental type",
        required: true,
        clean: (v) => (RENTAL_TYPES.includes(v) ? v : undefined),
    },
    quantity: {
        label: "Quantity",
        required: true,
        clean: (v) => {
            const number = toNumber(v)
            return Number.isInteger(number) && number >= 0 && number <= 1000
                ? number
                : undefined
        },
    },
    condition: {
        label: "Condition",
        required: true,
        clean: (v) => (CONDITIONS.includes(v) ? v : undefined),
    },
    brand: {
        label: "Brand",
        required: false,
        clean: (v) => (v === "" ? "" : trimmed(v, 1, 80)),
    },
    model: {
        label: "Model",
        required: false,
        clean: (v) => (v === "" ? "" : trimmed(v, 1, 80)),
    },
    image: {
        label: "Image",
        required: true,
        clean: (v) =>
            typeof v === "string" && v.length <= 500 && isHttpUrl(v.trim())
                ? v.trim()
                : undefined,
    },
    terms: {
        label: "Terms",
        required: false,
        clean: (v) => (v === "" ? "" : trimmed(v, 1, 2000)),
    },
}

// only whitelisted fields get through: status, ownerId, etc. are never read
// from the body
const validateEquipment = (body, { partial = false } = {}) => {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
        return { error: "Invalid request body" }
    }

    const data = {}
    for (const [key, field] of Object.entries(EQUIPMENT_FIELDS)) {
        if (body[key] === undefined) {
            if (!partial && field.required) {
                return { error: `${field.label} is required` }
            }
            continue
        }
        const cleaned = field.clean(body[key])
        if (cleaned === undefined) {
            return { error: `${field.label} is invalid` }
        }
        data[key] = cleaned
    }

    if (partial && Object.keys(data).length === 0) {
        return { error: "Nothing to update" }
    }
    return { data }
}

const getPaging = (query, defaultLimit) => {
    const page = Math.min(10000, Math.max(1, Math.floor(queryNumber(query.page) ?? 1)))
    const limit = Math.min(
        24,
        Math.max(1, Math.floor(queryNumber(query.limit) ?? defaultLimit))
    )
    return { page, limit, skip: (page - 1) * limit }
}

const searchPattern = (text) => ({
    $regex: escapeRegex(text.slice(0, 60)),
    $options: "i",
})

// public listing filters: search, category, rentalType, price range, availability
const buildEquipmentFilter = (query, base) => {
    const filter = { ...base }

    const search = queryString(query.search)
    if (search) {
        const pattern = searchPattern(search)
        filter.$or = [{ name: pattern }, { location: pattern }, { category: pattern }]
    }

    // accepts the category name or its slug
    const category = queryString(query.category)
    if (category) {
        filter.category =
            EQUIPMENT_CATEGORIES.find((c) => c.name === category || c.slug === category)
                ?.name ?? category
    }

    const rentalType = queryString(query.rentalType)
    if (rentalType) filter.rentalType = rentalType

    const minPrice = queryNumber(query.minPrice)
    const maxPrice = queryNumber(query.maxPrice)
    if (minPrice !== null || maxPrice !== null) {
        filter.price = {}
        if (minPrice !== null) filter.price.$gte = minPrice
        if (maxPrice !== null) filter.price.$lte = maxPrice
    }

    const availability = queryString(query.availability)
    if (availability === "available") filter.quantity = { $gt: 0 }
    if (availability === "unavailable") filter.quantity = 0

    return filter
}

// dashboard tables: status + search
const buildManageFilter = (query, base) => {
    const filter = { ...base }

    const status = queryString(query.status)
    if (EQUIPMENT_STATUSES.includes(status)) filter.status = status

    const search = queryString(query.search)
    if (search) {
        const pattern = searchPattern(search)
        filter.$or = [{ name: pattern }, { category: pattern }, { ownerName: pattern }]
    }

    return filter
}

const listEquipment = async (
    filter,
    query,
    { defaultLimit = 9, projection } = {}
) => {
    const { page, limit, skip } = getPaging(query, defaultLimit)
    const sortKey = queryString(query.sort)
    const sort = Object.hasOwn(EQUIPMENT_SORTS, sortKey)
        ? EQUIPMENT_SORTS[sortKey]
        : EQUIPMENT_SORTS.newest

    const options = projection ? { projection } : {}
    const [items, total] = await Promise.all([
        equipment.find(filter, options).sort(sort).skip(skip).limit(limit).toArray(),
        equipment.countDocuments(filter),
    ])

    return { items, total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)) }
}

// owner of the item, or an admin
const canManage = (user, item) =>
    user.role === "admin" || item.ownerId === user._id.toString()

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
    await equipment.createIndex({ status: 1, createdAt: -1 })
    await equipment.createIndex({ ownerId: 1, createdAt: -1 })
    await equipment.createIndex({ category: 1, status: 1 })
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

// equipment related apis (public, approved items only)
app.get("/equipment", async (req, res) => {
    const filter = buildEquipmentFilter(req.query, { status: "approved" })
    const result = await listEquipment(filter, req.query, {
        projection: PUBLIC_PROJECTION,
    })
    res.send(result)
})

// 6 approved items for the home page (MongoDB limit)
app.get("/equipment/featured", async (req, res) => {
    const result = await equipment
        .find({ status: "approved" }, { projection: PUBLIC_PROJECTION })
        .sort({ createdAt: -1, _id: -1 })
        .limit(6)
        .toArray()
    res.send(result)
})

// category cards with a live count of approved items
app.get("/equipment/categories", async (req, res) => {
    const counts = await equipment
        .aggregate([
            { $match: { status: "approved" } },
            { $group: { _id: "$category", count: { $sum: 1 } } },
        ])
        .toArray()
    const countMap = new Map(counts.map((item) => [item._id, item.count]))

    res.send(
        EQUIPMENT_CATEGORIES.map((category) => ({
            ...category,
            count: countMap.get(category.name) ?? 0,
        }))
    )
})

app.get("/equipment/:id", async (req, res) => {
    const id = toObjectId(req.params.id)
    if (!id) return res.status(400).send({ message: "Invalid id" })

    const item = await equipment.findOne(
        { _id: id, status: "approved" },
        { projection: PUBLIC_PROJECTION }
    )
    if (!item) return res.status(404).send({ message: "Equipment not found" })

    res.send(item)
})

// equipment management (token required)
// full document for the edit form: the owner of the item, or an admin
app.get("/equipment/:id/manage", verifyToken, async (req, res) => {
    const id = toObjectId(req.params.id)
    if (!id) return res.status(400).send({ message: "Invalid id" })

    const item = await equipment.findOne({ _id: id })
    if (!item) return res.status(404).send({ message: "Equipment not found" })
    if (!canManage(req.user, item)) {
        return res.status(403).send({ message: "Forbidden" })
    }

    res.send(item)
})

app.post("/equipment", verifyToken, verifyOwner, async (req, res) => {
    const { data, error } = validateEquipment(req.body)
    if (error) return res.status(400).send({ message: error })

    const now = new Date()
    const item = {
        brand: "",
        model: "",
        terms: "",
        ...data,
        // set by the server, never by the request body
        status: "pending",
        ownerId: req.user._id.toString(),
        ownerName: req.user.name,
        ownerEmail: req.user.email,
        ownerImage: req.user.image ?? null,
        createdAt: now,
        updatedAt: now,
    }

    const result = await equipment.insertOne(item)
    res.status(201).send(result)
})

// admin only: approve / reject
app.patch("/equipment/:id/status", verifyToken, verifyAdmin, async (req, res) => {
    const id = toObjectId(req.params.id)
    if (!id) return res.status(400).send({ message: "Invalid id" })

    const status = req.body?.status
    if (!EQUIPMENT_STATUSES.includes(status)) {
        return res.status(400).send({ message: "Status is invalid" })
    }

    const result = await equipment.updateOne(
        { _id: id },
        { $set: { status, updatedAt: new Date() } }
    )
    if (result.matchedCount === 0) {
        return res.status(404).send({ message: "Equipment not found" })
    }

    res.send(result)
})

app.patch("/equipment/:id", verifyToken, async (req, res) => {
    const id = toObjectId(req.params.id)
    if (!id) return res.status(400).send({ message: "Invalid id" })

    const item = await equipment.findOne({ _id: id })
    if (!item) return res.status(404).send({ message: "Equipment not found" })
    if (!canManage(req.user, item)) {
        return res.status(403).send({ message: "Forbidden" })
    }

    const { data, error } = validateEquipment(req.body, { partial: true })
    if (error) return res.status(400).send({ message: error })

    const update = { ...data, updatedAt: new Date() }
    // owner edits go back to review; admin edits keep the current status
    if (req.user.role !== "admin") update.status = "pending"

    const result = await equipment.updateOne({ _id: id }, { $set: update })
    res.send(result)
})

app.delete("/equipment/:id", verifyToken, async (req, res) => {
    const id = toObjectId(req.params.id)
    if (!id) return res.status(400).send({ message: "Invalid id" })

    const item = await equipment.findOne({ _id: id })
    if (!item) return res.status(404).send({ message: "Equipment not found" })
    if (!canManage(req.user, item)) {
        return res.status(403).send({ message: "Forbidden" })
    }

    const activeBooking = await bookings.findOne({
        equipmentId: id.toString(),
        bookingStatus: "confirmed",
    })
    if (activeBooking) {
        return res.status(409).send({
            message: "This equipment has confirmed bookings and cannot be deleted.",
        })
    }

    const result = await equipment.deleteOne({ _id: id })
    await favorites.deleteMany({ equipmentId: id.toString() })
    res.send(result)
})

// owner dashboard: only my own equipment
app.get("/owner/equipment", verifyToken, verifyOwner, async (req, res) => {
    const filter = buildManageFilter(req.query, { ownerId: req.user._id.toString() })
    res.send(await listEquipment(filter, req.query, { defaultLimit: 10 }))
})

// admin dashboard: all equipment
app.get("/admin/equipment", verifyToken, verifyAdmin, async (req, res) => {
    const filter = buildManageFilter(req.query, {})
    res.send(await listEquipment(filter, req.query, { defaultLimit: 10 }))
})

// favorites related apis (customers only)
app.get("/favorites/ids", verifyToken, verifyRenter, async (req, res) => {
    const docs = await favorites
        .find({ userId: req.user._id.toString() }, { projection: { equipmentId: 1 } })
        .toArray()
    res.send(docs.map((doc) => doc.equipmentId))
})

app.get("/favorites", verifyToken, verifyRenter, async (req, res) => {
    const docs = await favorites
        .find({ userId: req.user._id.toString() })
        .sort({ createdAt: -1, _id: -1 })
        .toArray()

    const ids = docs.map((doc) => toObjectId(doc.equipmentId)).filter(Boolean)
    const items = await equipment
        .find({ _id: { $in: ids }, status: "approved" }, { projection: PUBLIC_PROJECTION })
        .toArray()
    const byId = new Map(items.map((item) => [item._id.toString(), item]))

    res.send(
        docs
            .filter((doc) => byId.has(doc.equipmentId))
            .map((doc) => ({
                ...byId.get(doc.equipmentId),
                favoriteId: doc._id,
                favoritedAt: doc.createdAt,
            }))
    )
})

app.post("/favorites", verifyToken, verifyRenter, async (req, res) => {
    const equipmentId = toObjectId(req.body?.equipmentId)
    if (!equipmentId) return res.status(400).send({ message: "Invalid id" })

    const item = await equipment.findOne(
        { _id: equipmentId, status: "approved" },
        { projection: { _id: 1 } }
    )
    if (!item) return res.status(404).send({ message: "Equipment not found" })

    try {
        const result = await favorites.insertOne({
            userId: req.user._id.toString(),
            equipmentId: equipmentId.toString(),
            createdAt: new Date(),
        })
        res.status(201).send(result)
    } catch (err) {
        // the unique index makes a double click harmless
        if (err.code === 11000) {
            return res.send({ acknowledged: true, alreadyFavorite: true })
        }
        throw err
    }
})

app.delete("/favorites/:equipmentId", verifyToken, verifyRenter, async (req, res) => {
    const equipmentId = toObjectId(req.params.equipmentId)
    if (!equipmentId) return res.status(400).send({ message: "Invalid id" })

    const result = await favorites.deleteOne({
        userId: req.user._id.toString(),
        equipmentId: equipmentId.toString(),
    })
    res.send(result)
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