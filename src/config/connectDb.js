const mongoose = require('mongoose');
require('dotenv').config();
require('colors');

// Cache connection across requests
let cachedConnection = null;
let cachedConnectionPromise = null;

const connectDB = async () => {
  if (!process.env.MONGO_URI) {
    throw new Error('MONGO_URI environment variable is not set');
  }

  // Quick sanity-check so misconfigured env vars are caught immediately
  if (!process.env.MONGO_URI.startsWith('mongodb://') && !process.env.MONGO_URI.startsWith('mongodb+srv://')) {
    const preview = process.env.MONGO_URI.slice(0, 20).replace(/./g, (c, i) => i < 10 ? c : '*');
    throw new Error(`MONGO_URI has invalid scheme (starts with: "${preview}…"). Expected mongodb:// or mongodb+srv://`);
  }

  // Already connected — reuse
  if (cachedConnection && mongoose.connection.readyState === 1) {
    return cachedConnection;
  }

  // Connection in progress — wait for it
  if (cachedConnectionPromise) {
    return cachedConnectionPromise;
  }

  cachedConnectionPromise = mongoose.connect(process.env.MONGO_URI, {
    connectTimeoutMS: 30000,
    socketTimeoutMS: 45000,
    serverSelectionTimeoutMS: 30000,
    bufferCommands: true,
    bufferTimeoutMS: 8000,    // fail fast — socket auth catches this and retries
    maxPoolSize: 10,
    minPoolSize: 1,
    family: 4,                // force IPv4 — avoids IPv6 resolution issues on Render
  });

  try {
    const conn = await cachedConnectionPromise;
    cachedConnection = conn;
    cachedConnectionPromise = null;
    console.log(`✅ MongoDB connected: ${mongoose.connection.host}`.green.bold);
    return conn;
  } catch (error) {
    cachedConnectionPromise = null;
    cachedConnection = null;
    console.error('❌ MongoDB connection failed:'.red.bold, error.message);
    throw error;
  }
};

module.exports = { connectDB };
