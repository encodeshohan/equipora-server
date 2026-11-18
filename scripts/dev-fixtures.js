import "dotenv/config"
import crypto from "node:crypto"
import { MongoClient } from "mongodb"

const client = new MongoClient(process.env.MONGODB_URI)
await client.connect()

const database = client.db("equiporadb")
const users = database.collection("user")
const sessions = database.collection("session")

// remove old fixtures first so the script can be re-run
await sessions.deleteMany({ isTestFixture: true })
await users.deleteMany({ isTestFixture: true })

if (process.argv.includes("--clean")) {
  console.log("Test fixtures removed.")
  await client.close()
  process.exit(0)
}

const newToken = () => crypto.randomBytes(32).toString("hex")
const now = new Date()
const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000)
const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000)

const tokens = {}

for (const role of ["customer", "owner", "admin"]) {
  const { insertedId } = await users.insertOne({
    name: `Test ${role}`,
    email: `${role}@fixture.equipora.test`,
    emailVerified: true,
    image: null,
    role,
    createdAt: now,
    updatedAt: now,
    isTestFixture: true,
  })

  tokens[role] = newToken()
  await sessions.insertOne({
    token: tokens[role],
    userId: insertedId.toString(),
    expiresAt: tomorrow,
    createdAt: now,
    updatedAt: now,
    isTestFixture: true,
  })

  // one already-expired session for the customer
  if (role === "customer") {
    tokens.expired = newToken()
    await sessions.insertOne({
      token: tokens.expired,
      userId: insertedId.toString(),
      expiresAt: yesterday,
      createdAt: yesterday,
      updatedAt: yesterday,
      isTestFixture: true,
    })
  }
}

console.log("Dev-only tokens (valid 24h):")
console.table(tokens)
await client.close()