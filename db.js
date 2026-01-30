const { MongoClient } = require("mongodb");

const uri = process.env.MONGODB_URI;
const client = new MongoClient(uri);

let db;

async function connectDB() {
  if (!db) {
    await client.connect();
    db = client.db(); // db name comes from URI
    console.log("Connected to the database.");
  }
  return db;
}

function productsCol() {
  if (!db) throw new Error("DB not connected");
  return db.collection("products");
}

function ordersCol() {
  if (!db) throw new Error("DB not connected");
  return db.collection("orders");
}

module.exports = { connectDB, productsCol, ordersCol };