const SharedCartPayment = require('../models/SharedCartPayment');
const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');

const { STRIPE_SECRET_ACCESS_KEY } = process.env;
const stripe = STRIPE_SECRET_ACCESS_KEY ? require('stripe')(STRIPE_SECRET_ACCESS_KEY) : null;

// Identifies *which booking* a cart is for (service + dates only, ignoring
// add-ons/guests/price which can legitimately change). Used to make sure a
// customer only ever has one active link per booking-in-progress.
const computeBookingIdentity = (cartItems = []) =>
  JSON.stringify(
    [...cartItems]
      .map((item) => ({
        id: String(item.serviceId || item.id),
        checkIn: new Date(item.checkIn).toISOString(),
        checkOut: new Date(item.checkOut).toISOString(),
      }))
      .sort((a, b) => a.id.localeCompare(b.id))
  );

/**
 * POST /api/shared-cart-payment
 * Create a shared cart payment link
 */
exports.createSharedCartPayment = catchAsync(async (req, res, next) => {
  const {
    cartItems,
    itemDiscounts,
    currency,
    totalAmount,
    salesTax,
    allowPartialPayment,
    minimumPartialPercent,
    agreementAccepted,
    signatureImage,
    initialsImage,
    idFrontImage,
    idBackImage,
  } = req.body;

  if (!cartItems || !cartItems.length) {
    return next(new AppError('Cart items are required', 400));
  }
  if (!totalAmount || totalAmount <= 0) {
    return next(new AppError('Total amount must be positive', 400));
  }

  // Enforce a single active link per booking: superseding an unpaid link for
  // the same service+dates instead of leaving duplicates that a cross-device
  // lookup could pick the wrong one out of.
  const identity = computeBookingIdentity(cartItems);
  const existingActive = await SharedCartPayment.find({
    createdBy: req.user._id,
    isActive: true,
    paymentStatus: { $ne: 'paid' },
  }).select('_id cartItems');
  const staleIds = existingActive
    .filter((doc) => computeBookingIdentity(doc.cartItems) === identity)
    .map((doc) => doc._id);
  if (staleIds.length) {
    await SharedCartPayment.updateMany({ _id: { $in: staleIds } }, { isActive: false });
  }

  const sharedCart = await SharedCartPayment.create({
    createdBy: req.user._id,
    cartItems,
    itemDiscounts: itemDiscounts || {},
    currency: currency || 'USD',
    totalAmount,
    salesTax: salesTax || 0,
    allowPartialPayment: allowPartialPayment !== false,
    minimumPartialPercent: minimumPartialPercent || 25,
    agreementAccepted: !!agreementAccepted,
    signatureImage: signatureImage || null,
    initialsImage: initialsImage || null,
    idFrontImage: idFrontImage || null,
    idBackImage: idBackImage || null,
  });

  res.status(201).json({
    status: 'success',
    data: {
      token: sharedCart.token,
      expiresAt: sharedCart.expiresAt,
      totalAmount: sharedCart.totalAmount,
      currency: sharedCart.currency,
    },
  });
});

/**
 * PATCH /api/shared-cart-payment/:token
 * Refresh an existing (unpaid) link's cart snapshot in place, so a link/QR
 * already shared reflects cart edits without needing to be regenerated.
 */
exports.updateSharedCartPayment = catchAsync(async (req, res, next) => {
  const { token } = req.params;
  const { cartItems, itemDiscounts, totalAmount, salesTax } = req.body;

  if (!cartItems || !cartItems.length) {
    return next(new AppError('Cart items are required', 400));
  }
  if (!totalAmount || totalAmount <= 0) {
    return next(new AppError('Total amount must be positive', 400));
  }

  const sharedCart = await SharedCartPayment.findOne({ token, createdBy: req.user._id });
  if (!sharedCart) {
    return next(new AppError('Payment link not found or not authorized', 404));
  }
  if (!sharedCart.isActive) {
    return next(new AppError('This payment link is no longer active', 410));
  }
  if (sharedCart.paymentStatus === 'paid' || sharedCart.amountPaid > 0) {
    return next(new AppError('This link already has a payment in progress and can no longer be edited', 409));
  }

  sharedCart.cartItems = cartItems;
  sharedCart.itemDiscounts = itemDiscounts || {};
  sharedCart.totalAmount = totalAmount;
  sharedCart.salesTax = salesTax || 0;
  await sharedCart.save();

  res.status(200).json({
    status: 'success',
    data: {
      token: sharedCart.token,
      totalAmount: sharedCart.totalAmount,
      salesTax: sharedCart.salesTax,
      currency: sharedCart.currency,
    },
  });
});

/**
 * GET /api/shared-cart-payment/:token
 * Fetch shared cart details by token (public — no auth needed)
 */
exports.getSharedCartByToken = catchAsync(async (req, res, next) => {
  const { token } = req.params;

  const sharedCart = await SharedCartPayment.findOne({ token, isActive: true })
    .populate('createdBy', 'firstName lastName profileImage');

  if (!sharedCart) {
    return next(new AppError('Payment link not found or has expired', 404));
  }

  if (sharedCart.expiresAt < new Date()) {
    return next(new AppError('This payment link has expired', 410));
  }

  // Increment access count
  sharedCart.accessCount += 1;
  await sharedCart.save();

  res.status(200).json({
    status: 'success',
    data: {
      cartItems: sharedCart.cartItems,
      itemDiscounts: sharedCart.itemDiscounts,
      currency: sharedCart.currency,
      totalAmount: sharedCart.totalAmount,
      salesTax: sharedCart.salesTax,
      allowPartialPayment: sharedCart.allowPartialPayment,
      minimumPartialPercent: sharedCart.minimumPartialPercent,
      paymentStatus: sharedCart.paymentStatus,
      amountPaid: sharedCart.amountPaid,
      remainingAmount: sharedCart.totalAmount - sharedCart.amountPaid,
      agreementAccepted: sharedCart.agreementAccepted,
      signatureImage: sharedCart.signatureImage,
      initialsImage: sharedCart.initialsImage,
      idFrontImage: sharedCart.idFrontImage,
      idBackImage: sharedCart.idBackImage,
      createdBy: sharedCart.createdBy,
      expiresAt: sharedCart.expiresAt,
    },
  });
});

/**
 * POST /api/shared-cart-payment/:token/pay
 * Process payment on a shared cart link
 */
exports.processSharedCartPayment = catchAsync(async (req, res, next) => {
  const { token } = req.params;
  const { paymentMethodId, amount, email } = req.body;

  if (!stripe) {
    return next(new AppError('Payment service unavailable', 503));
  }
  if (!paymentMethodId) {
    return next(new AppError('Payment method is required', 400));
  }
  if (!amount || amount <= 0) {
    return next(new AppError('Payment amount must be positive', 400));
  }

  const sharedCart = await SharedCartPayment.findOne({ token, isActive: true });

  if (!sharedCart) {
    return next(new AppError('Payment link not found or has expired', 404));
  }
  if (sharedCart.expiresAt < new Date()) {
    return next(new AppError('This payment link has expired', 410));
  }
  if (sharedCart.paymentStatus === 'paid') {
    return next(new AppError('This cart has already been fully paid', 400));
  }

  const remaining = sharedCart.totalAmount - sharedCart.amountPaid;
  if (amount > remaining) {
    return next(new AppError(`Amount exceeds remaining balance of ${remaining}`, 400));
  }

  // Enforce minimum partial payment
  if (sharedCart.allowPartialPayment && amount < remaining) {
    const minAmount = (sharedCart.totalAmount * sharedCart.minimumPartialPercent) / 100;
    if (amount < minAmount) {
      return next(new AppError(`Minimum partial payment is ${minAmount.toFixed(2)} (${sharedCart.minimumPartialPercent}%)`, 400));
    }
  } else if (!sharedCart.allowPartialPayment && amount < remaining) {
    return next(new AppError('Partial payments are not allowed for this link', 400));
  }

  // Create Stripe PaymentIntent
  const amountInCents = Math.round(amount * 100);
  const paymentIntent = await stripe.paymentIntents.create({
    amount: amountInCents,
    currency: (sharedCart.currency || 'usd').toLowerCase(),
    payment_method: paymentMethodId,
    confirm: true,
    automatic_payment_methods: {
      enabled: true,
      allow_redirects: 'never',
    },
    metadata: {
      sharedCartToken: token,
      payerEmail: email || '',
    },
  });

  if (paymentIntent.status !== 'succeeded') {
    return next(new AppError('Payment failed. Please try again.', 402));
  }

  // Update shared cart
  sharedCart.amountPaid += amount;
  sharedCart.payments.push({
    paymentIntentId: paymentIntent.id,
    amount,
    paidAt: new Date(),
    payerEmail: email || null,
  });
  sharedCart.paymentStatus = sharedCart.amountPaid >= sharedCart.totalAmount ? 'paid' : 'partial';
  await sharedCart.save();

  res.status(200).json({
    status: 'success',
    data: {
      paymentIntentId: paymentIntent.id,
      amountPaid: amount,
      totalPaid: sharedCart.amountPaid,
      remaining: sharedCart.totalAmount - sharedCart.amountPaid,
      paymentStatus: sharedCart.paymentStatus,
    },
  });
});

/**
 * GET /api/shared-cart-payment/my-links
 * List all active shared cart links created by the logged-in user
 */
exports.getMySharedCartLinks = catchAsync(async (req, res, next) => {
  const links = await SharedCartPayment.find({ createdBy: req.user._id, isActive: true })
    .sort({ createdAt: -1 })
    .select('token cartItems totalAmount salesTax currency paymentStatus amountPaid expiresAt isActive createdAt');

  res.status(200).json({
    status: 'success',
    results: links.length,
    data: links.map((l) => ({
      token: l.token,
      cartItems: l.cartItems,
      totalAmount: l.totalAmount,
      salesTax: l.salesTax,
      currency: l.currency,
      paymentStatus: l.paymentStatus,
      amountPaid: l.amountPaid,
      expiresAt: l.expiresAt,
      active: l.isActive,
      createdAt: l.createdAt,
    })),
  });
});

/**
 * PATCH /api/shared-cart-payment/:token/deactivate
 * Deactivate a shared cart payment link
 */
exports.deactivateSharedCartLink = catchAsync(async (req, res, next) => {
  const { token } = req.params;

  const sharedCart = await SharedCartPayment.findOneAndUpdate(
    { token, createdBy: req.user._id },
    { isActive: false },
    { new: true }
  );

  if (!sharedCart) {
    return next(new AppError('Link not found or not authorized', 404));
  }

  res.status(200).json({
    status: 'success',
    message: 'Payment link deactivated',
  });
});
