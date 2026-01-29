const { MongoClient } = require("mongodb");

const uri = process.env.MONGODB_URI;
const client = new MongoClient(uri);

let db;

async function connectDB() {
  if (!db) {
    await client.connect();
    db = client.db(); // db name comes from URI
    console.log("MongoDB connected");
  }
  return db;
}

function productsCol() {
  if (!db) throw new Error("DB not connected");
  return db.collection("products");
}

module.exports = { connectDB, productsCol };