const SharedCartPayment = require('../models/SharedCartPayment');
const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');

const { STRIPE_SECRET_ACCESS_KEY } = process.env;
const stripe = STRIPE_SECRET_ACCESS_KEY ? require('stripe')(STRIPE_SECRET_ACCESS_KEY) : null;

/**
 * POST /api/shared-cart-payment
 * Create a shared cart payment link
 */
exports.createSharedCartPayment = catchAsync(async (req, res, next) => {
  const { cartItems, itemDiscounts, currency, totalAmount, allowPartialPayment, minimumPartialPercent } = req.body;

  if (!cartItems || !cartItems.length) {
    return next(new AppError('Cart items are required', 400));
  }
  if (!totalAmount || totalAmount <= 0) {
    return next(new AppError('Total amount must be positive', 400));
  }

  const sharedCart = await SharedCartPayment.create({
    createdBy: req.user._id,
    cartItems,
    itemDiscounts: itemDiscounts || {},
    currency: currency || 'USD',
    totalAmount,
    allowPartialPayment: allowPartialPayment !== false,
    minimumPartialPercent: minimumPartialPercent || 25,
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
      allowPartialPayment: sharedCart.allowPartialPayment,
      minimumPartialPercent: sharedCart.minimumPartialPercent,
      paymentStatus: sharedCart.paymentStatus,
      amountPaid: sharedCart.amountPaid,
      remainingAmount: sharedCart.totalAmount - sharedCart.amountPaid,
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
 * List all shared cart links created by the logged-in user
 */
exports.getMySharedCartLinks = catchAsync(async (req, res, next) => {
  const links = await SharedCartPayment.find({ createdBy: req.user._id })
    .sort({ createdAt: -1 })
    .select('token totalAmount currency paymentStatus amountPaid expiresAt isActive createdAt');

  res.status(200).json({
    status: 'success',
    results: links.length,
    data: links,
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
