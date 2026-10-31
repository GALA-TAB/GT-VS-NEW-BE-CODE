const express = require('express');
const passport = require('passport');
const requireAuth = require('../middlewares/requireAuth');
const {
  registerUser,
  loginUser,
  googleCallback,
  facebookCallback,
  verifyotp,
  verifyPhoneotp,
  sendEmailVerification,
  sendPhoneVerification,
  sendSignupEmailOtp,
  sendSignupPhoneOtp,
  verifySignupEmailOtp,
  verifySignupPhoneOtp,
  forgotPassword,
  resetPassword,
  createFirstPassword,
  delinkGoogle,
  delinkFacebook,
  verifyForgetOtp,
  resendOtp,
  resendOtpNumber,
  // buySubscription,
  updatePassword
} = require('../controllers/authController');
const userModel = require('../models/users/User');
const logActionMiddleware = require('../middlewares/logActionMiddleware');

// const checkSubscriptionValidity = require('../middlewares/checkSubscriptionValidity');

const router = express.Router();

router.post('/register', logActionMiddleware('Register', 'User'), registerUser);
// router.post("/login", checkSubscriptionValidity, loginUser);
router.post('/login', logActionMiddleware('Login', 'User'), loginUser);
router.patch('/updateUserPassword', requireAuth, logActionMiddleware('update password', 'User'), updatePassword);

// SOCIAL LOGIN ROUTES (GOOGLE)
router.get('/login/withGoogle', (req, res, next) => {
  const linking = req.query.linking === 'true';
  const role = req.query.role || 'vendor'; // Default to vendor instead of invalid
  console.log(role, 'role from query params');
  console.log(linking, 'linking from query params');
  
  // Validate role
  if (!['vendor', 'customer'].includes(role)) {
    return res.status(400).json({
      status: 'error',
      message: 'Invalid role. Must be "vendor" or "customer"'
    });
  }
  
  // First, let's test with basic scopes only
  passport.authenticate('google', {
    scope: ['profile', 'email'],
    accessType: 'offline',
    prompt: 'consent',
    state: JSON.stringify({ linking, role })
  })(req, res, next);
});


router.get(
  '/login/google/callback',
  (req, res, next) => {
    console.log('Google callback received');
    console.log('Query params:', req.query);
    
    // Parse the state parameter to check if this is calendar-only
    let stateData = {};
    try {
      stateData = JSON.parse(req.query.state || '{}');
    } catch (error) {
      console.log('Failed to parse state, treating as login:', error.message);
      stateData = {};
    }
    
    console.log('Parsed state data:', stateData);
    
    // Check if this is a calendar-only request
    if (stateData.isCalendarOnly) {
      console.log('Routing to calendar callback handler');
      // Import and use the calendar callback handler
      const { handleGoogleCallback } = require('../controllers/googleOAuthController');
      return handleGoogleCallback(req, res, next);
    }
    
    // Otherwise, handle as normal login
    console.log('Routing to passport authentication');
    passport.authenticate('google', async (err, user, info) => {
      console.log('Passport callback result:', { 
        hasError: !!err, 
        hasUser: !!user, 
        info,
        errorDetails: err 
      });
      
      if (err || !user) {
        console.error('Authentication failed:', err);
        const error = encodeURIComponent(err?.toString() || 'Authentication failed.');
        return res.redirect(`${process.env.FRONTEND_URL}/login-error?error=${error}`);
      }
      req.login(user, async (loginErr) => {
        if (loginErr) {
          const error = encodeURIComponent(loginErr.toString());
          return res.redirect(`${process.env.FRONTEND_URL}/login-error?error=${error}`);
        }
        next(); // go to googleCallback
      });
    })(req, res, next);
  },
  googleCallback
);



router.get('/dashboard', async (req, res) => {
  console.log('Checking user authentication', req.user);

  if (!req.user) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }

  const user = await userModel.findById(req.user.id);
  return res.json({
    success: true,
    message: 'Welcome to the dashboard',
    user
  });
});

router.get('/logout', (req, res, next) => {
  console.log('inside logout route');
  req.logout((err) => {
    if (err) return next(err);
    res.redirect('/');
    return 0;
  });
});

// SOCIAL LOGIN ROUTES (FACEBOOK)
router.get('/login/withFacebook', (req, res, next) => {
  const linking = req.query.linking === 'true';
  const role = req.query.role || 'user'; // default role to 'user' if not provided

  // JSON stringify state only if needed
  const state = JSON.stringify({ linking, role });

  passport.authenticate('facebook', {
    scope: ['email'],
    state // Facebook accepts `state` as a query string param
  })(req, res, next);
});


router.get(
  '/login/facebook/callback',
 (req, res, next) => {
    passport.authenticate('facebook', async (err, user, info) => {
      console.log('inside google callback', err, user, info);
      if (err || !user) {
        const error = encodeURIComponent(err?.toString() || 'Authentication failed.');
        return res.redirect(`${process.env.FRONTEND_URL}/login-error?error=${error}`);
      }
      req.login(user, async (loginErr) => {
        if (loginErr) {
          const error = encodeURIComponent(loginErr.toString());
          return res.redirect(`${process.env.FRONTEND_URL}/login-error?error=${error}`);
        }
        next(); // go to googleCallback
      });
    })(req, res, next);
  },
  facebookCallback
);

router.post('/send-otp-email', logActionMiddleware('Send OTP Email', 'User'), sendEmailVerification);
router.post('/verifyotp', logActionMiddleware('Verify OTP', 'User'), verifyotp);
router.post('/resend-otp-email', logActionMiddleware('Resend OTP Email', 'User'), resendOtp);

router.post('/send-otp-number', logActionMiddleware('Resend OTP Number', 'User'), sendPhoneVerification);
router.post('/verifyPhoneotp', logActionMiddleware('Verify Phone OTP', 'User'), verifyPhoneotp);
router.post('/resend-otp-number', logActionMiddleware('Resend OTP Number', 'User'), resendOtpNumber);

// Signup verification — these operate on PendingRegistration records (no
// account exists yet) and only create the real account once OTP succeeds.
// Kept separate from the routes above, which also serve existing-user 2FA
// login verification and must keep operating on the real Users collection.
router.post('/signup/send-otp-email', logActionMiddleware('Send Signup OTP Email', 'User'), sendSignupEmailOtp);
router.post('/signup/verify-otp-email', logActionMiddleware('Verify Signup OTP Email', 'User'), verifySignupEmailOtp);
router.post('/signup/send-otp-number', logActionMiddleware('Send Signup OTP Number', 'User'), sendSignupPhoneOtp);
router.post('/signup/verify-otp-number', logActionMiddleware('Verify Signup OTP Number', 'User'), verifySignupPhoneOtp);

router.post('/forgotPassword', logActionMiddleware('Forgot Password', 'User'), forgotPassword);
router.patch('/resetPassword', logActionMiddleware('Reset Password', 'User'), resetPassword);

// route to set a password for the account, when no password is there. (maybe user signed up using socials)
router.patch('/createfirstPassword', requireAuth, logActionMiddleware("Create First Password", 'User'), createFirstPassword);

router.post('/delink/google', requireAuth, delinkGoogle);
router.post('/delink/facebook', requireAuth, delinkFacebook);

// router.post('/Subscription', requireAuth, buySubscription);
router.post('/forgetOTP', logActionMiddleware('Verify Forget OTP', 'User'), verifyForgetOtp);

// Debug endpoint to check OAuth configuration
router.get('/debug/oauth-config', (req, res) => {
  res.json({
    status: 'success',
    config: {
      hasClientId: !!process.env.GOOGLE_CLIENT_ID,
      hasClientSecret: !!process.env.GOOGLE_CLIENT_SECRET,
      redirectUri: process.env.GOOGLE_REDIRECT_URI,
      frontendUrl: process.env.FRONTEND_URL,
      nodeEnv: process.env.NODE_ENV,
      port: process.env.PORT,
      clientIdPreview: process.env.GOOGLE_CLIENT_ID ? 
        process.env.GOOGLE_CLIENT_ID.substring(0, 20) + '...' : 'NOT_SET'
    }
  });
});

module.exports = router;
