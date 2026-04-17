const Wallet = require('../models/Wallet');
const User = require('../models/users/User');
const APIFeatures = require('../utils/apiFeatures');
const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');

const { STRIPE_SECRET_ACCESS_KEY } = process.env;
const stripe = STRIPE_SECRET_ACCESS_KEY ? require('stripe')(STRIPE_SECRET_ACCESS_KEY) : null;

// ─── Helper: get or create wallet ────────────────────────────────────
const getOrCreateWallet = async (userId) => {
  let wallet = await Wallet.findOne({ user: userId });
  if (!wallet) {
    wallet = await Wallet.create({ user: userId });
  }
  return wallet;
};

// ─────────────────────────────────────────────────────────────────────
// GET /api/wallet
// Get the current user's wallet (balance + transactions)
// ─────────────────────────────────────────────────────────────────────
exports.getWallet = catchAsync(async (req, res) => {
  const wallet = await getOrCreateWallet(req.user._id);

  res.status(200).json({
    status: 'success',
    data: {
      balance: wallet.balance,
      currency: wallet.currency,
      transactions: wallet.transactions.sort((a, b) => b.createdAt - a.createdAt),
      fundMeLinks: wallet.fundMeLinks,
    },
  });
});

// ─────────────────────────────────────────────────────────────────────
// POST /api/wallet/add-funds
// Add funds via credit/debit card (Stripe PaymentIntent)
// ─────────────────────────────────────────────────────────────────────
exports.addFunds = catchAsync(async (req, res, next) => {
  const { paymentMethodId, amount } = req.body;

  if (!stripe) {
    return next(new AppError('Payment processing unavailable', 503));
  }
  if (!paymentMethodId) {
    return next(new AppError('Payment method is required', 400));
  }
  if (!amount || amount < 1) {
    return next(new AppError('Amount must be at least $1.00', 400));
  }

  // Create and confirm a PaymentIntent
  const paymentIntent = await stripe.paymentIntents.create({
    amount: Math.round(amount * 100), // cents
    currency: 'usd',
    payment_method: paymentMethodId,
    confirm: true,
    automatic_payment_methods: {
      enabled: true,
      allow_redirects: 'never',
    },
    metadata: {
      userId: req.user._id.toString(),
      type: 'wallet_deposit',
    },
  });

  if (paymentIntent.status !== 'succeeded') {
    return next(new AppError('Payment failed. Please try again.', 400));
  }

  // Credit the wallet
  const wallet = await getOrCreateWallet(req.user._id);
  wallet.balance += amount;
  wallet.transactions.push({
    type: 'deposit',
    amount,
    description: `Added funds via card`,
    stripePaymentIntentId: paymentIntent.id,
  });
  await wallet.save();

  res.status(200).json({
    status: 'success',
    data: {
      balance: wallet.balance,
      transactionId: paymentIntent.id,
    },
  });
});

// ─────────────────────────────────────────────────────────────────────
// POST /api/wallet/pay-from-wallet
// Use wallet balance to pay for a booking
// ─────────────────────────────────────────────────────────────────────
exports.payFromWallet = catchAsync(async (req, res, next) => {
  const { amount, bookingId, description } = req.body;

  if (!amount || amount <= 0) {
    return next(new AppError('Amount must be positive', 400));
  }

  const wallet = await getOrCreateWallet(req.user._id);

  if (wallet.balance < amount) {
    return next(new AppError('Insufficient wallet balance', 400));
  }

  wallet.balance -= amount;
  wallet.transactions.push({
    type: 'payment',
    amount: -amount,
    description: description || 'Event payment from wallet',
    bookingId: bookingId || null,
  });
  await wallet.save();

  res.status(200).json({
    status: 'success',
    data: {
      balance: wallet.balance,
    },
  });
});

// ─────────────────────────────────────────────────────────────────────
// POST /api/wallet/create-fundme
// Create a FundMe link for an event (tied to cart items)
// ─────────────────────────────────────────────────────────────────────
exports.createFundMeLink = catchAsync(async (req, res, next) => {
  const { title, description, targetAmount, cartItems } = req.body;

  if (!title) {
    return next(new AppError('Title is required', 400));
  }
  if (!targetAmount || targetAmount <= 0) {
    return next(new AppError('Target amount must be positive', 400));
  }

  const wallet = await getOrCreateWallet(req.user._id);

  wallet.fundMeLinks.push({
    title,
    description: description || '',
    targetAmount,
    cartItems: cartItems || [],
  });
  await wallet.save();

  const link = wallet.fundMeLinks[wallet.fundMeLinks.length - 1];

  res.status(201).json({
    status: 'success',
    data: {
      token: link.token,
      title: link.title,
      targetAmount: link.targetAmount,
      expiresAt: link.expiresAt,
    },
  });
});

// ─────────────────────────────────────────────────────────────────────
// GET /api/wallet/fundme/:token
// Get FundMe page details (PUBLIC — no auth)
// ─────────────────────────────────────────────────────────────────────
exports.getFundMeLink = catchAsync(async (req, res, next) => {
  const { token } = req.params;

  const wallet = await Wallet.findOne({ 'fundMeLinks.token': token })
    .populate('user', 'firstName lastName profileImage');

  if (!wallet) {
    return next(new AppError('Fund link not found', 404));
  }

  const link = wallet.fundMeLinks.find((l) => l.token === token);

  if (!link || !link.isActive) {
    return next(new AppError('This fund link is no longer active', 404));
  }
  if (link.expiresAt < new Date()) {
    return next(new AppError('This fund link has expired', 410));
  }

  res.status(200).json({
    status: 'success',
    data: {
      title: link.title,
      description: link.description,
      targetAmount: link.targetAmount,
      amountRaised: link.amountRaised,
      remainingAmount: link.targetAmount - link.amountRaised,
      cartItems: link.cartItems,
      contributions: link.contributions.map((c) => ({
        name: c.name,
        amount: c.amount,
        message: c.message,
        paidAt: c.paidAt,
      })),
      createdBy: {
        firstName: wallet.user?.firstName,
        lastName: wallet.user?.lastName,
        profileImage: wallet.user?.profileImage,
      },
      expiresAt: link.expiresAt,
    },
  });
});

// ─────────────────────────────────────────────────────────────────────
// POST /api/wallet/fundme/:token/contribute
// Contribute to a FundMe link (PUBLIC — no auth, Stripe payment)
// ─────────────────────────────────────────────────────────────────────
exports.contributeFundMe = catchAsync(async (req, res, next) => {
  const { token } = req.params;
  const { paymentMethodId, amount, name, email, message } = req.body;

  if (!stripe) {
    return next(new AppError('Payment processing unavailable', 503));
  }
  if (!paymentMethodId) {
    return next(new AppError('Payment method is required', 400));
  }
  if (!amount || amount < 1) {
    return next(new AppError('Contribution must be at least $1.00', 400));
  }
  if (!name) {
    return next(new AppError('Name is required', 400));
  }

  const wallet = await Wallet.findOne({ 'fundMeLinks.token': token });
  if (!wallet) {
    return next(new AppError('Fund link not found', 404));
  }

  const link = wallet.fundMeLinks.find((l) => l.token === token);
  if (!link || !link.isActive) {
    return next(new AppError('This fund link is no longer active', 404));
  }
  if (link.expiresAt < new Date()) {
    return next(new AppError('This fund link has expired', 410));
  }

  // Process payment
  const paymentIntent = await stripe.paymentIntents.create({
    amount: Math.round(amount * 100),
    currency: 'usd',
    payment_method: paymentMethodId,
    confirm: true,
    automatic_payment_methods: {
      enabled: true,
      allow_redirects: 'never',
    },
    metadata: {
      type: 'fundme_contribution',
      fundMeToken: token,
      contributorName: name,
    },
  });

  if (paymentIntent.status !== 'succeeded') {
    return next(new AppError('Payment failed. Please try again.', 400));
  }

  // Credit contribution to the link + wallet balance
  link.amountRaised += amount;
  link.contributions.push({
    name,
    email: email || null,
    amount,
    message: message || '',
    stripePaymentIntentId: paymentIntent.id,
  });

  wallet.balance += amount;
  wallet.transactions.push({
    type: 'fundme_contribution',
    amount,
    description: `Contribution from ${name}`,
    stripePaymentIntentId: paymentIntent.id,
    contributorName: name,
    contributorEmail: email || null,
  });

  await wallet.save();

  res.status(200).json({
    status: 'success',
    data: {
      amountRaised: link.amountRaised,
      remainingAmount: link.targetAmount - link.amountRaised,
    },
  });
});

// ─────────────────────────────────────────────────────────────────────
// PATCH /api/wallet/fundme/:token/deactivate
// Deactivate a FundMe link (auth required, owner only)
// ─────────────────────────────────────────────────────────────────────
exports.deactivateFundMeLink = catchAsync(async (req, res, next) => {
  const { token } = req.params;

  const wallet = await Wallet.findOne({ user: req.user._id });
  if (!wallet) {
    return next(new AppError('Wallet not found', 404));
  }

  const link = wallet.fundMeLinks.find((l) => l.token === token);
  if (!link) {
    return next(new AppError('Fund link not found', 404));
  }

  link.isActive = false;
  await wallet.save();

  res.status(200).json({
    status: 'success',
    message: 'Fund link deactivated',
  });
});

// ─────────────────────────────────────────────────────────────────────
// GET /api/wallet/admin/all
// Admin: list all user wallets with balances (paginated, searchable)
// ─────────────────────────────────────────────────────────────────────
exports.getAllWallets = catchAsync(async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 10;
  const skip = (page - 1) * limit;
  const search = req.query.search || '';
  const role = req.query.role || '';

  // Build user match filter
  const userMatch = {};
  if (search) {
    userMatch.$or = [
      { firstName: { $regex: search, $options: 'i' } },
      { lastName: { $regex: search, $options: 'i' } },
      { email: { $regex: search, $options: 'i' } },
    ];
  }
  if (role) {
    userMatch.role = role;
  }

  const pipeline = [
    {
      $lookup: {
        from: 'users',
        localField: 'user',
        foreignField: '_id',
        as: 'userDoc',
      },
    },
    { $unwind: { path: '$userDoc', preserveNullAndEmptyArrays: false } },
    ...(Object.keys(userMatch).length > 0 ? [{ $match: { 'userDoc': userMatch } }] : []),
    {
      $addFields: {
        transactionCount: { $size: '$transactions' },
        lastTransaction: { $arrayElemAt: [{ $sortArray: { input: '$transactions', sortBy: { createdAt: -1 } } }, 0] },
      },
    },
    {
      $project: {
        _id: 1,
        balance: 1,
        currency: 1,
        transactionCount: 1,
        'lastTransaction.type': 1,
        'lastTransaction.amount': 1,
        'lastTransaction.createdAt': 1,
        'userDoc._id': 1,
        'userDoc.firstName': 1,
        'userDoc.lastName': 1,
        'userDoc.email': 1,
        'userDoc.role': 1,
        'userDoc.profileImage': 1,
        createdAt: 1,
        updatedAt: 1,
      },
    },
    { $sort: { balance: -1 } },
  ];

  const countPipeline = [...pipeline, { $count: 'total' }];
  const dataPipeline = [...pipeline, { $skip: skip }, { $limit: limit }];

  const [countResult, wallets] = await Promise.all([
    Wallet.aggregate(countPipeline),
    Wallet.aggregate(dataPipeline),
  ]);

  const total = countResult.length > 0 ? countResult[0].total : 0;

  // Aggregate totals
  const totalsPipeline = [
    {
      $group: {
        _id: null,
        totalBalance: { $sum: '$balance' },
        totalWallets: { $sum: 1 },
      },
    },
  ];
  const totalsResult = await Wallet.aggregate(totalsPipeline);

  res.status(200).json({
    status: 'success',
    data: wallets,
    results: wallets.length,
    total,
    totalBalance: totalsResult.length > 0 ? totalsResult[0].totalBalance : 0,
    totalWallets: totalsResult.length > 0 ? totalsResult[0].totalWallets : 0,
  });
});

// ─────────────────────────────────────────────────────────────────────
// GET /api/wallet/admin/:userId
// Admin: view a specific user's wallet details
// ─────────────────────────────────────────────────────────────────────
exports.getWalletByUserId = catchAsync(async (req, res, next) => {
  const { userId } = req.params;

  const wallet = await Wallet.findOne({ user: userId })
    .populate('user', 'firstName lastName email role profileImage');

  if (!wallet) {
    return next(new AppError('No wallet found for this user', 404));
  }

  res.status(200).json({
    status: 'success',
    data: {
      _id: wallet._id,
      user: wallet.user,
      balance: wallet.balance,
      currency: wallet.currency,
      transactions: wallet.transactions.sort((a, b) => b.createdAt - a.createdAt),
      fundMeLinks: wallet.fundMeLinks,
    },
  });
});

// ─────────────────────────────────────────────────────────────────────
// POST /api/wallet/admin/:userId/credit
// Admin: credit (add) or debit (subtract) a user's wallet
// ─────────────────────────────────────────────────────────────────────
exports.adminAdjustWallet = catchAsync(async (req, res, next) => {
  const { userId } = req.params;
  const { amount, description, type } = req.body;

  if (!amount || amount <= 0) {
    return next(new AppError('Amount must be positive', 400));
  }
  if (!type || !['credit', 'debit'].includes(type)) {
    return next(new AppError('Type must be "credit" or "debit"', 400));
  }

  const user = await User.findById(userId);
  if (!user) {
    return next(new AppError('User not found', 404));
  }

  const wallet = await getOrCreateWallet(userId);

  if (type === 'debit' && wallet.balance < amount) {
    return next(new AppError('Insufficient wallet balance for debit', 400));
  }

  if (type === 'credit') {
    wallet.balance += amount;
  } else {
    wallet.balance -= amount;
  }

  wallet.transactions.push({
    type: type === 'credit' ? 'deposit' : 'payment',
    amount: type === 'credit' ? amount : -amount,
    description: description || `Admin ${type} adjustment`,
  });
  await wallet.save();

  res.status(200).json({
    status: 'success',
    data: {
      balance: wallet.balance,
      userId,
    },
  });
});

// ─────────────────────────────────────────────────────────────────────
// POST /api/wallet/vendor/credit-earnings
// System: credit vendor wallet when escrow is released
// (called internally from payout cron or admin release)
// ─────────────────────────────────────────────────────────────────────
exports.creditVendorWallet = async (vendorId, amount, bookingId, description) => {
  const wallet = await getOrCreateWallet(vendorId);
  wallet.balance += amount;
  wallet.transactions.push({
    type: 'deposit',
    amount,
    description: description || 'Payout from completed booking',
    bookingId: bookingId || null,
  });
  await wallet.save();
  return wallet;
};
