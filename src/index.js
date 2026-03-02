require('dotenv').config();
const http = require('http');
const express = require('express');
const session = require('express-session');
const passport = require('passport');
const cookieParser = require('cookie-parser');
const { connectDB } = require('./config/connectDb');
const configMiddlewares = require('./config/configMiddlewares');
const routes = require('./config/routes');
const { initializeSocket } = require('./utils/socket');

// Cron jobs – uncomment if running on a persistent server (Render/Railway)
require("./utils/updateRequest");   // marks completed bookings + creates escrow hold
require("./utils/PayoutCrone");     // releases escrow after 72h dispute window
// require("./utils/VendorPayout"); // DISABLED – replaced by escrow-aware PayoutCrone
// require("./utils/checkstripebalance");
// require("./utils/autoDeleteOldPendingBookings");

const app = express();
const server = http.createServer(app);

app.use(cookieParser());
app.use(express.urlencoded({ extended: true }));
 
app.set('trust proxy', 1);
// Configure middlewares
configMiddlewares(app);

// setting the session
app.use(
  session({
    secret: process.env.SESSION_SECRET || 'SESSION_SECRET_FALLBACK',
    resave: false,
    saveUninitialized: true,
    cookie: {
      secure: false, // Set to true in production with HTTPS
      httpOnly: true,
      maxAge: 1000 * 60 * 60 * 24, // 24 hours
      sameSite: 'lax' // Important for OAuth redirects
    },
    name: 'gala-tab-session' // Custom session name
  })
);


// initialize passport
app.use(passport.initialize());
app.use(passport.session());

// Passport serialization (required for sessions)
passport.serializeUser((user, done) => {
  done(null, user);
});

passport.deserializeUser((user, done) => {
  done(null, user);
});

// loading authentication strategies(Google, Facebook) - wrapped in try-catch
try {
  require('./auth/GoogleStrategy')(passport);
  require("./auth/FacebookStrategy")(passport);
} catch (error) {
  console.error('Error loading auth strategies:', error.message);
}

app.use('/api', async (req, res, next) => {
  // These routes don't need DB — skip connectDB entirely
  if (req.path === '/health' || req.path.startsWith('/upload/')) return next();
  try {
    await connectDB();
    next();
  } catch (error) {
    return res.status(500).json({
      status: 'fail',
      message: 'Database connection failed',
      error: error.message
    });
  }
});

// Initialize routes
routes(app);

// Initialize Socket.io on the HTTP server
initializeSocket(server);

const PORT = process.env.PORT || 5000;

// Connect to MongoDB then start listening
const requiredEnv = ['JWT_SECRET', 'MONGO_URI', 'OTP_SECRET'];
const missingEnv = requiredEnv.filter(k => !process.env[k]);
if (missingEnv.length) {
  console.error('⚠️  MISSING REQUIRED ENV VARS:', missingEnv.join(', '));
} else {
  console.log('✅ All required env vars present');
}

connectDB()
  .then(() => {
    server.listen(PORT, () => {
      console.log(`Server is running on port ${PORT}`);
    });
  })
  .catch(err => {
    console.error('MongoDB connection error:', err.message);
    // Still start server so health checks pass even if DB is momentarily down
    server.listen(PORT, () => {
      console.log(`Server is running on port ${PORT} (DB connection pending)`);
    });
  });

module.exports = app;







