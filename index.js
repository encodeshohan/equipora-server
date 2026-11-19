import express from "express"
import cors from "cors"
import "dotenv/config"
import Stripe from "stripe"
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

// booking helpers
const BOOKING_HOLD_MS = 35 * 60 * 1000
const MAX_RENTAL_DAYS = 365
const DAY_MS = 24 * 60 * 60 * 1000
const PHONE_PATTERN = /^\+?[\d\s-]{7,20}$/
const UNIT_LABELS = { daily: "day", weekly: "week", monthly: "month" }

// "YYYY-MM-DD" in Bangladesh time
const todayInDhaka = () =>
    new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Dhaka" })

const isValidDay = (value) => {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        return false
    }
    const date = new Date(`${value}T00:00:00Z`)
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}

// both days are inclusive
const countDays = (start, end) =>
    Math.round((Date.parse(end) - Date.parse(start)) / DAY_MS) + 1

const rentalUnits = (rentalType, days) => {
    if (rentalType === "weekly") return Math.ceil(days / 7)
    if (rentalType === "monthly") return Math.ceil(days / 30)
    return days
}

const validateBookingRequest = (body) => {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
        return { error: "Invalid request body" }
    }

    const equipmentId = toObjectId(body.equipmentId)
    if (!equipmentId) return { error: "Invalid equipment id" }

    const { startDate, endDate } = body
    if (!isValidDay(startDate) || !isValidDay(endDate)) {
        return { error: "Start and end dates are required" }
    }
    if (startDate < todayInDhaka()) {
        return { error: "Start date cannot be in the past" }
    }
    if (endDate < startDate) {
        return { error: "End date cannot be before the start date" }
    }
    if (countDays(startDate, endDate) > MAX_RENTAL_DAYS) {
        return { error: `Rentals are limited to ${MAX_RENTAL_DAYS} days` }
    }

    const quantity = toNumber(body.quantity)
    if (!Number.isInteger(quantity) || quantity < 1) {
        return { error: "Quantity must be a whole number of at least 1" }
    }

    const contactNumber = trimmed(body.contactNumber, 7, 20)
    if (!contactNumber || !PHONE_PATTERN.test(contactNumber)) {
        return { error: "Contact number is invalid" }
    }

    const deliveryAddress = trimmed(body.deliveryAddress, 5, 300)
    if (!deliveryAddress) {
        return { error: "Delivery address is required (5 to 300 characters)" }
    }

    const notes = typeof body.notes === "string" ? body.notes.trim() : ""
    if (notes.length > 500) {
        return { error: "Notes are too long (500 characters max)" }
    }

    return {
        data: { equipmentId, startDate, endDate, quantity, contactNumber, deliveryAddress, notes },
    }
}

// highest number of units reserved on any single day of the requested range.
// Counts confirmed/completed bookings and recent unpaid holds. `beforeId`
// restricts the count to bookings inserted earlier (race guard).
const getReservedPeak = async ({ equipmentId, startDate, endDate, beforeId }) => {
    const holdCutoff = new Date(Date.now() - BOOKING_HOLD_MS)
    const filter = {
        equipmentId,
        startDate: { $lte: endDate },
        endDate: { $gte: startDate },
        $or: [
            { bookingStatus: { $in: ["confirmed", "completed"] } },
            { bookingStatus: "pending", createdAt: { $gte: holdCutoff } },
        ],
    }
    if (beforeId) filter._id = { $lt: beforeId }

    const overlapping = await bookings
        .find(filter, { projection: { startDate: 1, endDate: 1, quantity: 1 } })
        .toArray()

    const points = new Set([startDate])
    for (const booking of overlapping) {
        if (booking.startDate > startDate) points.add(booking.startDate)
    }

    let peak = 0
    for (const point of points) {
        let sum = 0
        for (const booking of overlapping) {
            if (booking.startDate <= point && booking.endDate >= point) {
                sum += booking.quantity
            }
        }
        peak = Math.max(peak, sum)
    }
    return peak
}

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

// payments config
const stripe = process.env.STRIPE_SECRET_KEY
    ? new Stripe(process.env.STRIPE_SECRET_KEY)
    : null
const CLIENT_URL = (process.env.CLIENT_URL || allowedOrigins[0]).replace(/\/$/, "")
const STRIPE_CURRENCY = (process.env.STRIPE_CURRENCY || "bdt").toLowerCase()
const BDT_PER_UNIT = Number(process.env.STRIPE_BDT_PER_UNIT) || 0
const paymentsConfigured =
    Boolean(stripe) && (STRIPE_CURRENCY === "bdt" || BDT_PER_UNIT > 0)

if (!paymentsConfigured) {
    console.warn("Stripe is not fully configured: bookings will return 503")
}

// prices are in BDT; Stripe amounts are in the smallest currency unit
const toChargeAmount = (totalBdt) =>
    STRIPE_CURRENCY === "bdt"
        ? Math.round(totalBdt * 100)
        : Math.round((totalBdt / BDT_PER_UNIT) * 100)

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
    await bookings.createIndex({ equipmentId: 1, startDate: 1, endDate: 1 })
    await bookings.createIndex({ customerId: 1, createdAt: -1 })
    await bookings.createIndex({ ownerId: 1, createdAt: -1 })
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

    // confirmed bookings, or an unpaid checkout that is still open
    const holdCutoff = new Date(Date.now() - BOOKING_HOLD_MS)
    const activeBooking = await bookings.findOne({
        equipmentId: id.toString(),
        $or: [
            { bookingStatus: "confirmed" },
            { bookingStatus: "pending", createdAt: { $gte: holdCutoff } },
        ],
    })
    if (activeBooking) {
        return res.status(409).send({
            message: "This equipment has active bookings and cannot be deleted right now.",
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

// bookings + payments related apis (customers only)
app.post("/bookings/checkout", verifyToken, verifyRenter, async (req, res) => {
    if (!paymentsConfigured) {
        return res.status(503).send({ message: "Payments are not configured" })
    }

    const { data, error } = validateBookingRequest(req.body)
    if (error) return res.status(400).send({ message: error })

    const item = await equipment.findOne({ _id: data.equipmentId, status: "approved" })
    if (!item) return res.status(404).send({ message: "Equipment not found" })

    if (data.quantity > item.quantity) {
        return res.status(400).send({
            message:
                item.quantity === 0
                    ? "This equipment is currently unavailable"
                    : `Only ${item.quantity} available`,
        })
    }

    const equipmentId = item._id.toString()
    const reserved = await getReservedPeak({
        equipmentId,
        startDate: data.startDate,
        endDate: data.endDate,
    })
    if (reserved + data.quantity > item.quantity) {
        return res.status(409).send({
            message: "Not enough quantity is available for these dates",
        })
    }

    // the total is always computed here from the stored price
    const days = countDays(data.startDate, data.endDate)
    const units = rentalUnits(item.rentalType, days)
    const total = Math.round(item.price * units * data.quantity * 100) / 100
    const chargeAmount = toChargeAmount(total)
    if (!Number.isSafeInteger(chargeAmount) || chargeAmount < 1) {
        return res.status(400).send({ message: "Total is invalid" })
    }

    const now = new Date()
    const booking = {
        equipmentId,
        equipmentName: item.name,
        equipmentImage: item.image,
        category: item.category,
        location: item.location,
        ownerId: item.ownerId,
        ownerName: item.ownerName,
        customerId: req.user._id.toString(),
        customerName: req.user.name,
        customerEmail: req.user.email,
        customerImage: req.user.image ?? null,
        startDate: data.startDate,
        endDate: data.endDate,
        days,
        rentalType: item.rentalType,
        units,
        unitPrice: item.price,
        quantity: data.quantity,
        total,
        currency: "bdt",
        chargeAmount,
        chargeCurrency: STRIPE_CURRENCY,
        contactNumber: data.contactNumber,
        deliveryAddress: data.deliveryAddress,
        notes: data.notes,
        paymentStatus: "unpaid",
        bookingStatus: "pending",
        createdAt: now,
        updatedAt: now,
    }

    const inserted = await bookings.insertOne(booking)

    // race guard: only bookings inserted before this one count
    const earlier = await getReservedPeak({
        equipmentId,
        startDate: data.startDate,
        endDate: data.endDate,
        beforeId: inserted.insertedId,
    })
    if (earlier + data.quantity > item.quantity) {
        await bookings.deleteOne({ _id: inserted.insertedId })
        return res.status(409).send({
            message: "Not enough quantity is available for these dates",
        })
    }

    try {
        const unitLabel = UNIT_LABELS[item.rentalType]
        const session = await stripe.checkout.sessions.create({
            mode: "payment",
            customer_email: req.user.email,
            line_items: [
                {
                    quantity: 1,
                    price_data: {
                        currency: STRIPE_CURRENCY,
                        unit_amount: chargeAmount,
                        product_data: {
                            name: `${item.name} (${data.quantity} x ${units} ${unitLabel}${units === 1 ? "" : "s"})`.slice(0, 200),
                            description: `${data.startDate} to ${data.endDate}`,
                        },
                    },
                },
            ],
            metadata: {
                bookingId: inserted.insertedId.toString(),
                userId: req.user._id.toString(),
            },
            expires_at: Math.floor(Date.now() / 1000) + 31 * 60,
            success_url: `${CLIENT_URL}/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${CLIENT_URL}/equipment/${equipmentId}?canceled=1`,
        })

        await bookings.updateOne(
            { _id: inserted.insertedId },
            { $set: { stripeSessionId: session.id } }
        )
        res.status(201).send({ bookingId: inserted.insertedId, url: session.url, total })
    } catch (err) {
        console.error("Stripe session failed:", err.message)
        await bookings.deleteOne({ _id: inserted.insertedId })
        res.status(502).send({ message: "Payment service is unavailable. Please try again." })
    }
})

app.post("/payments/checkout-verify", verifyToken, verifyRenter, async (req, res) => {
    if (!paymentsConfigured) {
        return res.status(503).send({ message: "Payments are not configured" })
    }

    const sessionId = req.body?.sessionId
    if (typeof sessionId !== "string" || !/^cs_(test|live)_[A-Za-z0-9]+$/.test(sessionId)) {
        return res.status(400).send({ message: "Invalid session id" })
    }

    let session
    try {
        session = await stripe.checkout.sessions.retrieve(sessionId)
    } catch (err) {
        console.error("Stripe retrieve failed:", err.message)
        return res.status(404).send({ message: "Checkout session not found" })
    }

    // the session must belong to the logged-in user
    const userId = req.user._id.toString()
    if (session.metadata?.userId !== userId) {
        return res.status(403).send({ message: "Forbidden" })
    }

    const bookingId = toObjectId(session.metadata?.bookingId)
    if (!bookingId) return res.status(400).send({ message: "Invalid booking" })

    const booking = await bookings.findOne({
        _id: bookingId,
        customerId: userId,
        stripeSessionId: sessionId,
    })
    if (!booking) return res.status(404).send({ message: "Booking not found" })

    if (session.status !== "complete" || session.payment_status !== "paid") {
        return res.send({ success: false, message: "Payment has not been completed." })
    }

    if (
        session.amount_total !== booking.chargeAmount ||
        session.currency !== booking.chargeCurrency
    ) {
        console.error("Payment amount mismatch for booking", booking._id.toString())
        return res.status(409).send({ message: "Payment does not match the booking" })
    }

    // replay protection: the unique index on sessionId allows one record only
    let alreadyVerified = false
    try {
        await payments.insertOne({
            sessionId,
            bookingId: booking._id.toString(),
            userId,
            customerEmail: booking.customerEmail,
            equipmentId: booking.equipmentId,
            ownerId: booking.ownerId,
            amount: booking.total,
            currency: booking.currency,
            status: "paid",
            transactionId:
                typeof session.payment_intent === "string" ? session.payment_intent : sessionId,
            paymentDate: new Date(),
        })
    } catch (err) {
        if (err.code !== 11000) throw err
        alreadyVerified = true
    }

    await bookings.updateOne(
        { _id: booking._id, paymentStatus: "unpaid" },
        {
            $set: {
                paymentStatus: "paid",
                bookingStatus: "confirmed",
                paidAt: new Date(),
                updatedAt: new Date(),
            },
        }
    )

    const updated = await bookings.findOne({ _id: booking._id })
    const payment = await payments.findOne({ sessionId })
    res.send({
        success: true,
        alreadyVerified,
        booking: updated,
        transactionId: payment?.transactionId ?? null,
    })
})

// my bookings (customer dashboard, paginated)
app.get("/bookings/mine", verifyToken, verifyRenter, async (req, res) => {
    const { page, limit, skip } = getPaging(req.query, 10)
    const filter = { customerId: req.user._id.toString() }

    const [items, total] = await Promise.all([
        bookings.find(filter).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit).toArray(),
        bookings.countDocuments(filter),
    ])

    res.send({
        items,
        total,
        page,
        limit,
        totalPages: Math.max(1, Math.ceil(total / limit)),
    })
})

// profile related apis (all roles, own profile only)
const profileOf = (user) => ({
    id: user._id.toString(),
    name: user.name,
    email: user.email,
    role: user.role,
    image: user.image ?? null,
    phone: user.phone ?? "",
    address: user.address ?? "",
    createdAt: user.createdAt,
})

app.get("/profile", verifyToken, (req, res) => {
    res.send(profileOf(req.user))
})

app.patch("/profile", verifyToken, async (req, res) => {
    const body = req.body
    if (!body || typeof body !== "object" || Array.isArray(body)) {
        return res.status(400).send({ message: "Invalid request body" })
    }

    const name = trimmed(body.name, 2, 80)
    if (!name) {
        return res.status(400).send({ message: "Name must be 2 to 80 characters" })
    }

    let image = null
    if (typeof body.image === "string" && body.image.trim() !== "") {
        const value = body.image.trim()
        if (value.length > 500 || !isHttpUrl(value)) {
            return res.status(400).send({ message: "Image must be a valid http(s) link" })
        }
        image = value
    }

    const phone = typeof body.phone === "string" ? body.phone.trim() : ""
    if (phone && !PHONE_PATTERN.test(phone)) {
        return res.status(400).send({ message: "Phone number is invalid" })
    }

    const address = typeof body.address === "string" ? body.address.trim() : ""
    if (address.length > 300) {
        return res.status(400).send({ message: "Address is too long (300 characters max)" })
    }

    // only these four fields can change: never email, role or banned
    await users.updateOne(
        { _id: req.user._id },
        { $set: { name, image, phone, address, updatedAt: new Date() } }
    )

    res.send(profileOf(await users.findOne({ _id: req.user._id })))
})

// owner dashboard: paid bookings of my equipment
app.get("/owner/bookings", verifyToken, verifyOwner, async (req, res) => {
    const { page, limit, skip } = getPaging(req.query, 10)
    const filter = { ownerId: req.user._id.toString(), paymentStatus: "paid" }
    const projection = { stripeSessionId: 0, chargeAmount: 0, chargeCurrency: 0 }

    const [items, total] = await Promise.all([
        bookings
            .find(filter, { projection })
            .sort({ createdAt: -1, _id: -1 })
            .skip(skip)
            .limit(limit)
            .toArray(),
        bookings.countDocuments(filter),
    ])

    res.send({
        items,
        total,
        page,
        limit,
        totalPages: Math.max(1, Math.ceil(total / limit)),
    })
})

// admin: users
const USER_ROLE_VALUES = ["customer", "owner", "admin"]

const adminUserOf = (user) => ({
    id: user._id.toString(),
    name: user.name,
    email: user.email,
    role: USER_ROLE_VALUES.includes(user.role) ? user.role : "customer",
    image: user.image ?? null,
    banned: Boolean(user.banned),
    createdAt: user.createdAt,
})

app.get("/admin/users", verifyToken, verifyAdmin, async (req, res) => {
    const { page, limit, skip } = getPaging(req.query, 10)
    const filter = {}

    const role = queryString(req.query.role)
    if (USER_ROLE_VALUES.includes(role)) filter.role = role

    const search = queryString(req.query.search)
    if (search) {
        const pattern = searchPattern(search)
        filter.$or = [{ name: pattern }, { email: pattern }]
    }

    const projection = { name: 1, email: 1, role: 1, image: 1, banned: 1, createdAt: 1 }
    const [items, total] = await Promise.all([
        users
            .find(filter, { projection })
            .sort({ createdAt: -1, _id: -1 })
            .skip(skip)
            .limit(limit)
            .toArray(),
        users.countDocuments(filter),
    ])

    res.send({
        items: items.map(adminUserOf),
        total,
        page,
        limit,
        totalPages: Math.max(1, Math.ceil(total / limit)),
    })
})

app.patch("/admin/users/:id/role", verifyToken, verifyAdmin, async (req, res) => {
    const id = toObjectId(req.params.id)
    if (!id) return res.status(400).send({ message: "Invalid id" })

    const role = req.body?.role
    if (!USER_ROLE_VALUES.includes(role)) {
        return res.status(400).send({ message: "Role is invalid" })
    }
    if (id.equals(req.user._id)) {
        return res.status(400).send({ message: "You cannot change your own role" })
    }

    const result = await users.updateOne(
        { _id: id },
        { $set: { role, updatedAt: new Date() } }
    )
    if (result.matchedCount === 0) {
        return res.status(404).send({ message: "User not found" })
    }

    res.send(result)
})

app.patch("/admin/users/:id/ban", verifyToken, verifyAdmin, async (req, res) => {
    const id = toObjectId(req.params.id)
    if (!id) return res.status(400).send({ message: "Invalid id" })

    const banned = req.body?.banned
    if (typeof banned !== "boolean") {
        return res.status(400).send({ message: "banned must be true or false" })
    }
    if (id.equals(req.user._id)) {
        return res.status(400).send({ message: "You cannot suspend your own account" })
    }

    const target = await users.findOne({ _id: id }, { projection: { role: 1 } })
    if (!target) return res.status(404).send({ message: "User not found" })
    if (target.role === "admin" && banned) {
        return res.status(400).send({
            message: "Change this user's role before suspending the account",
        })
    }

    await users.updateOne({ _id: id }, { $set: { banned, updatedAt: new Date() } })
    // log the user out everywhere (sessions may store the id as text or ObjectId)
    if (banned) {
        await sessions.deleteMany({ userId: { $in: [id, id.toString()] } })
    }

    res.send({ acknowledged: true, banned })
})

// admin: all rentals
const PAYMENT_STATUSES = ["paid", "unpaid"]
const BOOKING_STATUSES = ["pending", "confirmed", "completed", "cancelled"]

app.get("/admin/bookings", verifyToken, verifyAdmin, async (req, res) => {
    const { page, limit, skip } = getPaging(req.query, 10)
    const filter = {}

    const paymentStatus = queryString(req.query.paymentStatus)
    if (PAYMENT_STATUSES.includes(paymentStatus)) filter.paymentStatus = paymentStatus

    const bookingStatus = queryString(req.query.bookingStatus)
    if (BOOKING_STATUSES.includes(bookingStatus)) filter.bookingStatus = bookingStatus

    const projection = { stripeSessionId: 0, chargeAmount: 0, chargeCurrency: 0 }
    const [items, total] = await Promise.all([
        bookings
            .find(filter, { projection })
            .sort({ createdAt: -1, _id: -1 })
            .skip(skip)
            .limit(limit)
            .toArray(),
        bookings.countDocuments(filter),
    ])

    res.send({
        items,
        total,
        page,
        limit,
        totalPages: Math.max(1, Math.ceil(total / limit)),
    })
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