const express = require('express');
const {
  authRoute,
  vendorRoute,
  planRoute,
  uploadRoute,
  subcriptionRoute,
  listingRoute,
  amenityRoute,
  gadgetRoute,
  categoryRoute,
  kycRoute,
  faqRoute,
  userRoute,
  requestRoute,
  disputeRoute,
  accountRoute,
  textForumRoute,
  reviewRoute,
  reportReviewRoute,
  advertisementRoute,
  templeteRoute,
  subAdminRoute,
  cityRoute,
  countryRoute,
  logsRoute,
  discountRoute,
  settingRoute,
  payoutRoute,
  topicRoute,
  calendarRoute,
  paymentRoute,
  reportRoute,
  staffRoute,
  newsLetterRoute,
  filterRoute,
  messageRoute,
  supportRoute,
  eventTypeRoute,
  clientReviewRoute,
  alertRoute,
  suspensionRoute,
  chatViolationRoute,
  adminNoteRoute
} = require('../routes');

const otherRoutes = require('./otherRoutes');
const { stripeWebhook } = require('../controllers/webhookController');

module.exports = (app) => {
  app.post('/webhook', express.raw({ type: 'application/json' }), stripeWebhook);
  app.use(express.json({ limit: '30mb' }));

  // Root + health check + test-db — registered after CORS so all origins get the headers
  app.get('/', (req, res) => res.status(200).json({ status: 'success', message: 'Gala Tab API is running' }));
  app.get('/api/health', (req, res) => res.status(200).json({ status: 'ok' }));
  app.get('/api/test-db', async (req, res) => {
    try {
      const mongoose = require('mongoose');
      const connectionState = mongoose.connection.readyState;
      const states = ['disconnected', 'connected', 'connecting', 'disconnecting'];
      if (connectionState !== 1) await require('../config/connectDb').connectDB();
      const Admin = require('../models/users/Admin');
      const adminCount = await Admin.countDocuments({});
      res.status(200).json({ status: 'success', connection: states[connectionState], adminCount });
    } catch (error) {
      res.status(500).json({ status: 'fail', error: error.message });
    }
  });

  app.use('/api/auth', authRoute);
  app.use("/api/message", messageRoute);
  app.use('/api/user', userRoute);
  app.use('/api/vendor', vendorRoute);
  app.use('/api/upload', uploadRoute);  
  app.use('/api/kycRoute', kycRoute);
  app.use('/api/plan', planRoute);
  app.use('/api/subscription', subcriptionRoute);
  app.use('/api/servicelisting', listingRoute);
  app.use('/api/amenity', amenityRoute);
  app.use('/api/gadget', gadgetRoute);
  app.use('/api/serviceCategory', categoryRoute);
  app.use('/api/Faq', faqRoute);
  app.use('/api/request-booking', requestRoute);
  app.use('/api/dispute',disputeRoute)
  app.use('/api/account',accountRoute)
  app.use('/api/taxForum', textForumRoute);
  app.use('/api/review', reviewRoute);
  app.use('/api/report-review', reportReviewRoute);
  app.use('/api/advertisement', advertisementRoute);
  app.use('/api/templete', templeteRoute);
  app.use('/api/subAdmin', subAdminRoute);
  app.use('/api/city', cityRoute);
  app.use('/api/country', countryRoute);
  app.use('/api/logs', logsRoute);
  app.use('/api/discount', discountRoute);
  app.use('/api/setting', settingRoute);
  app.use('/api/payout', payoutRoute);
  app.use('/api/topic', topicRoute);
  app.use('/api/calendar', calendarRoute);
  app.use('/api/payment', paymentRoute);
  app.use('/api/report', reportRoute);
  app.use('/api/subscription', subcriptionRoute);
  app.use('/api/staff', staffRoute);
  app.use('/api/newsletter', newsLetterRoute);
  app.use("/api/filter",filterRoute)
  app.use('/api/support', supportRoute);
  app.use('/api/event-type', eventTypeRoute);
  app.use('/api/client-review', clientReviewRoute);
  app.use('/api/alert', alertRoute);
  app.use('/api/suspension', suspensionRoute);
  app.use('/api/chat-violation', chatViolationRoute);
  app.use('/api/admin-note', adminNoteRoute);
  otherRoutes(app);
};
                                                                                      