

const { default: mongoose } = require('mongoose');
const Bookings = require('../models/Bookings');
const Payments = require('../models/Payment');
const User = require('../models/users/User');
const APIFeatures = require('../utils/apiFeatures');
const AppError = require('../utils/appError');
const catchAsync = require('../utils/catchAsync');
const Email = require('../utils/email');
const { createStripeOnBoardingLink, createStripeExpressAccount, receiveAccount } = require('../utils/stripe-utils/connect-accounts.util');
const { maintoConnect } = require('../utils/stripe-utils/stripe-transfer.util');
const getAllpaymentsforVendor = catchAsync(async (req, res, next) => {

    const query = {
        vendorId: req.user._id
    };
    if (req.query.status) {
        query.status = req.query.status;
    }
    const apiFeature = new APIFeatures(Payments.find(query), req.query).paginate().sort();

    const [total, payments] = await Promise.all([
        Payments.countDocuments(query),
        apiFeature.query.populate("vendorId", ["email", "profileCompleted", "lastName", "firstName"]).populate({ path: "booking", populate: { path: "service", select: "title totalPrice" } })
    ]);

    const totalEarnings = await Payments.aggregate([
        { $match: { vendorId: req.user._id, status: 'completed' } },
        {
            $group: {
                _id: null,
                totalEarnings: { $sum: '$amount' }  // Sum the amount field
            }
        }
    ]);
    const totalEarningsValue = totalEarnings.length > 0 ? totalEarnings[0].totalEarnings : 0; // Get the total earnings value

    res.status(200).json({
        status: "success",
        data: payments,
        results: payments.length,
        totalPayments: total,
        totalEarnings: totalEarningsValue
    });
});
const getAllPayments = catchAsync(async (req, res, next) => {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;

    const pipeline = [
        // ── 1. Vendor lookup ────────────────────────────────────────────
        {
            $lookup: {
                from: 'users',
                localField: 'vendorId',
                foreignField: '_id',
                as: 'vendor'
            }
        },
        { $unwind: { path: '$vendor', preserveNullAndEmptyArrays: true } },
        {
            $addFields: {
                'vendor.fullName': {
                    $concat: [
                        { $ifNull: ['$vendor.firstName', ''] },
                        ' ',
                        { $ifNull: ['$vendor.lastName', ''] }
                    ]
                }
            }
        },
        {
            $match: {
                'vendor.role': { $ne: 'admin' }
            }
        },
        // ── 2. Booking lookup (booking field stored as string → convert to ObjectId) ──
        {
            $addFields: {
                bookingObjId: {
                    $cond: {
                        if: { $eq: [{ $type: '$booking' }, 'string'] },
                        then: { $toObjectId: '$booking' },
                        else: '$booking'
                    }
                }
            }
        },
        {
            $lookup: {
                from: 'bookings',
                localField: 'bookingObjId',
                foreignField: '_id',
                as: 'bookingDoc'
            }
        },
        { $unwind: { path: '$bookingDoc', preserveNullAndEmptyArrays: true } },
        // ── 3. Customer lookup ──────────────────────────────────────────
        {
            $lookup: {
                from: 'users',
                localField: 'bookingDoc.user',
                foreignField: '_id',
                as: 'customerDoc'
            }
        },
        { $unwind: { path: '$customerDoc', preserveNullAndEmptyArrays: true } },
        // ── 4. Service lookup ───────────────────────────────────────────
        {
            $lookup: {
                from: 'servicelistings',
                localField: 'bookingDoc.service',
                foreignField: '_id',
                as: 'serviceDoc'
            }
        },
        { $unwind: { path: '$serviceDoc', preserveNullAndEmptyArrays: true } },
        // ── 5. Merge lookups into clean shape ───────────────────────────
        {
            $addFields: {
                'bookingDoc.user': {
                    _id: '$customerDoc._id',
                    firstName: '$customerDoc.firstName',
                    lastName: '$customerDoc.lastName',
                    name: { $concat: [{ $ifNull: ['$customerDoc.firstName', ''] }, ' ', { $ifNull: ['$customerDoc.lastName', ''] }] },
                    email: '$customerDoc.email',
                    profileImg: '$customerDoc.profileImg'
                },
                'bookingDoc.service': {
                    _id: '$serviceDoc._id',
                    title: '$serviceDoc.title'
                }
            }
        },
        {
            $project: {
                bookingObjId: 0,
                customerDoc: 0,
                serviceDoc: 0
            }
        }
    ];

    // ── Search filter ────────────────────────────────────────────────────
    if (req.query.search) {
        const searchRegex = new RegExp(req.query.search, 'i');
        pipeline.push({
            $match: {
                $or: [
                    { 'vendor.fullName': searchRegex },
                    { 'vendor.email': searchRegex },
                    { 'bookingDoc.service.title': searchRegex },
                    { 'bookingDoc.user.name': searchRegex },
                    { 'bookingDoc.user.email': searchRegex }
                ]
            }
        });
    }

    // ── escrowStatus filter (new) ────────────────────────────────────────
    if (req.query.escrowStatus) {
        pipeline.push({ $match: { escrowStatus: req.query.escrowStatus } });
    }

    // ── Legacy status filter ─────────────────────────────────────────────
    if (req.query.status) {
        pipeline.push({ $match: { status: req.query.status } });
    }

    // ── Total count ──────────────────────────────────────────────────────
    const totalResult = await Payments.aggregate([...pipeline, { $count: 'total' }]);
    const total = totalResult[0]?.total || 0;

    // ── Paginated results ────────────────────────────────────────────────
    const payments = await Payments.aggregate([
        ...pipeline,
        { $sort: { createdAt: -1 } },
        { $skip: skip },
        { $limit: limit }
    ]);

    res.status(200).json({
        status: 'success',
        results: payments.length,
        totalPayments: total,
        data: payments
    });
});

////////////////////////////////payout to vendor from stripe main account to vendor connected account/////////////
const vendorPayout = catchAsync(async (req, res, next) => {

    const { amount, paymentId } = req.body; // amount in dollars

    const payment = await Payments.findOne({ _id: paymentId, status: 'pending' });
    if (!payment) {
        return next(new AppError('No payment found', 404));
    }

    const vendor = await User.findById(payment.vendorId);
    if (!vendor) {
        return next(new AppError('No vendor found with that ID', 404));
    }

    const findbooking = await Bookings.findOne({ _id: paymentId })

    if (!findbooking) {
        return next(new AppError('No booking found for this payment', 404));
    }

    if (amount && amount > findbooking.totalPrice) {
        return next(new AppError('Amount is greater than the total price of the booking', 400));
    }

    if (!vendor.stripeAccountId) {
        const accountId = await createStripeExpressAccount({
            email: vendor.email,
            country: vendor.countryName || 'US',
            userId: vendor._id
        });

        vendor.stripeAccountId = accountId;
        await vendor.save();

        const onboardingLink = await createStripeOnBoardingLink({
            accountId: vendor.stripeAccountId
        });

        const email = new Email(vendor.email, vendor.firstName);
        const message = `Hello ${vendor.firstName},<br><br>Your Stripe account is not ready for payouts. Please complete the onboarding process by clicking the link below:<br><br><a href="${onboardingLink}">${onboardingLink}</a><br><br>Thank you!`;
        await email.sendHtmlEmail('Stripe Account Onboarding', message, {
            link: onboardingLink
        });
        return next(new AppError('Vendor has no Stripe account linked.', 400));
    }

    const account = await receiveAccount(vendor.stripeAccountId);

    if (!account?.charges_enabled || !account.payouts_enabled) {
        const onboardingLink = await createStripeOnBoardingLink({
            accountId: vendor.stripeAccountId
        });

        const email = new Email(vendor.email, vendor.firstName);
        const message = `Hello ${vendor.firstName},<br><br>Your Stripe account is not ready for payouts. Please complete the onboarding process by clicking the link below:<br><br><a href="${onboardingLink}">${onboardingLink}</a><br><br>Thank you!`;
        await email.sendHtmlEmail('Stripe Account Onboarding', message, {
            link: onboardingLink
        });
        return next(new AppError('Vendor Stripe account is not ready for payouts.', 404));

    }


    let amountInCents = 0;
    let systemFee = 0;
    if (amount) {
        systemFee = findbooking.totalPrice - amount;
        amountInCents = Math.round(amount * 100);

    } else
        systemFee = findbooking.totalPrice - amount;
    amountInCents = Math.round(payment.amount * 100);

    try {
        const transfer = await maintoConnect({
            vendor: vendor,
            amountInCents: amountInCents
        });

        // Update payment status
        payment.amount = amountInCents / 100; // Store the amount in dollars
        payment.status = 'completed';
        payment.systemFee = systemFee;
        await payment.save();

        res.status(200).json({
            status: "success",
            data: transfer
        });
    } catch (error) {
        console.error('Stripe transfer error:', error);
        return next(new AppError('Failed to complete payout. Please try again.', 500));
    }
});

const getsinglecompletedbooking = catchAsync(async (req, res, next) => {

    const { bookingId } = req.params;
    const booking = await Bookings.aggregate([
        {
            $match: {
                _id: new mongoose.Types.ObjectId(bookingId),
                status: 'completed'

            }
        },
        {
            $lookup: {
                from: 'users',
                localField: 'user',
                foreignField: '_id',
                as: 'customer'
            }
        },
        { $unwind: { path: '$customer', preserveNullAndEmptyArrays: true } },
        {
            $lookup: {
                from: 'servicelistings',
                localField: 'service',
                foreignField: '_id',
                as: 'service'
            }
        },
        { $unwind: { path: '$service', preserveNullAndEmptyArrays: true } },
        {
            $lookup: {
                from: 'users',
                localField: 'service.vendorId',
                foreignField: '_id',
                as: 'vendor'
            }
        },
        { $unwind: { path: '$vendor', preserveNullAndEmptyArrays: true } },
        {
            $lookup: {
                from: 'payments',
                localField: '_id',
                foreignField: 'booking',
                as: 'payment'
            }
        },
        { $unwind: { path: '$payment', preserveNullAndEmptyArrays: true } },

    ]);


    if (booking.length === 0) {
        return next(new AppError('No booking found with that ID', 404));
    }

    res.status(200).json({
        status: 'success',
        data: booking[0] // Return the first booking object
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// ESCROW & DISPUTE ENDPOINTS
// ═════════════════════════════════════════════════════════════════════════════

// GET /api/payment/escrow/:bookingId
// Returns the escrow + dispute status for a booking.
const getEscrowStatus = catchAsync(async (req, res, next) => {
  const { bookingId } = req.params;

  const booking = await Bookings.findById(bookingId);
  if (!booking) return next(new AppError('Booking not found', 404));

  const payment = await Payments.findOne({ booking: bookingId });

  res.status(200).json({
    status: 'success',
    data: {
      bookingId,
      bookingStatus: booking.status,
      escrowReleaseAt: booking.escrowReleaseAt,
      inDispute: booking.inDispute,
      disputeReason: booking.disputeReason,
      disputeFiledAt: booking.disputeFiledAt,
      disputeResolvedAt: booking.disputeResolvedAt,
      disputeResolution: booking.disputeResolution,
      payment: payment
        ? {
            escrowStatus: payment.escrowStatus,
            amount: payment.amount,
            systemFee: payment.systemFee,
            stripeTransferId: payment.stripeTransferId,
            stripeRefundId: payment.stripeRefundId
          }
        : null
    }
  });
});

// POST /api/payment/dispute/:bookingId
// Customer files a dispute within 72 hours of the booking date (checkIn).
// Body: { reason: string }
const fileDispute = catchAsync(async (req, res, next) => {
  const { bookingId } = req.params;
  const { reason } = req.body;

  if (!reason || reason.trim().length === 0) {
    return next(new AppError('Dispute reason is required.', 400));
  }

  const booking = await Bookings.findById(bookingId);
  if (!booking) return next(new AppError('Booking not found', 404));

  // Only the customer who made the booking can file a dispute
  if (booking.user.toString() !== req.user._id.toString()) {
    return next(new AppError('You are not authorised to dispute this booking.', 403));
  }

  if (booking.status !== 'completed') {
    return next(new AppError('Disputes can only be filed for completed bookings.', 400));
  }

  if (booking.inDispute) {
    return next(new AppError('A dispute has already been filed for this booking.', 400));
  }

  // Enforce 72-hour dispute window (window opens at checkIn / booking date)
  if (booking.escrowReleaseAt && new Date() > booking.escrowReleaseAt) {
    return next(new AppError('The 72-hour dispute window for this booking has closed. Disputes must be filed within 72 hours of the booking date.', 400));
  }

  booking.inDispute = true;
  booking.disputeReason = reason.trim();
  booking.disputeFiledAt = new Date();
  await booking.save();

  const payment = await Payments.findOne({ booking: bookingId });
  if (payment) {
    payment.escrowStatus = 'disputed';
    await payment.save();
  }

  // Notify admin
  const admins = await User.find({ role: 'admin' });
  for (const admin of admins) {
    await new Email(admin).sendDisputeAlert({
      bookingId,
      reason: reason.trim(),
      userId: req.user._id,
      amount: payment?.amount
    }).catch(() => {}); // non-blocking
  }

  res.status(200).json({
    status: 'success',
    message: 'Dispute filed successfully. Our team will review it within 1-2 business days.'
  });
});

// POST /api/payment/dispute/:bookingId/resolve   (admin only)
// Admin resolves a dispute.
// Body: { resolution: 'refunded' | 'partial_refund' | 'released', refundAmount?: number }
const resolveDispute = catchAsync(async (req, res, next) => {
  const { bookingId } = req.params;
  const { resolution, refundAmount } = req.body;

  const allowedResolutions = ['refunded', 'partial_refund', 'released'];
  if (!allowedResolutions.includes(resolution)) {
    return next(new AppError('resolution must be refunded, partial_refund, or released', 400));
  }

  const booking = await Bookings.findById(bookingId).populate({
    path: 'service',
    select: 'vendorId',
    populate: { path: 'vendorId', model: 'User' }
  });
  if (!booking) return next(new AppError('Booking not found', 404));
  if (!booking.inDispute) return next(new AppError('This booking is not in dispute.', 400));

  const payment = await Payments.findOne({ booking: bookingId });
  if (!payment) return next(new AppError('No payment record found for this booking.', 404));

  const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

  if (resolution === 'released') {
    // Release funds to vendor anyway
    const vendor = booking.service.vendorId;
    if (vendor?.stripeAccountId) {
      const account = await receiveAccount(vendor.stripeAccountId);
      if (account?.charges_enabled || account?.payouts_enabled) {
        const amountInCents = Math.round(payment.amount * 100);
        const transfer = await maintoConnect({ vendor, amountInCents });
        if (transfer) {
          payment.stripeTransferId = transfer.id;
        }
      }
    }
    payment.escrowStatus = 'released';
    payment.status = 'completed';
    booking.paymentStatus = true;
  } else {
    // Refund to customer (full or partial)
    const chargeId = payment.stripeChargeId;
    if (chargeId) {
      const refundParams = { charge: chargeId };
      if (resolution === 'partial_refund' && refundAmount) {
        refundParams.amount = Math.round(Number(refundAmount) * 100);
      }
      try {
        const refund = await stripe.refunds.create(refundParams);
        payment.stripeRefundId = refund.id;
      } catch (stripeErr) {
        console.error('[resolveDispute] Stripe refund error:', stripeErr);
        return next(new AppError('Stripe refund failed: ' + stripeErr.message, 500));
      }
    }
    payment.escrowStatus = resolution === 'partial_refund' ? 'partial_refund' : 'refunded';
    payment.status = 'completed';
  }

  booking.inDispute = false;
  booking.disputeResolvedAt = new Date();
  booking.disputeResolution = resolution;
  await booking.save();
  await payment.save();

  res.status(200).json({
    status: 'success',
    message: 'Dispute resolved successfully.',
    data: { resolution, bookingId }
  });
});

// POST /api/payment/escrow/:bookingId/release   (admin only)
// Admin manually releases escrow early (e.g. for trust vendors).
const adminReleaseEscrow = catchAsync(async (req, res, next) => {
  const { bookingId } = req.params;

  const booking = await Bookings.findById(bookingId).populate({
    path: 'service',
    select: 'vendorId',
    populate: { path: 'vendorId', model: 'User' }
  });
  if (!booking) return next(new AppError('Booking not found', 404));
  if (booking.inDispute) return next(new AppError('Cannot release delayed payout while booking is in dispute.', 400));

  const payment = await Payments.findOne({ booking: bookingId });
  if (!payment) return next(new AppError('No payment record found.', 404));
  if (payment.escrowStatus !== 'held') {
    return next(new AppError('Delayed payout is not currently held for this booking.', 400));
  }

  const vendor = booking.service.vendorId;
  if (!vendor?.stripeAccountId) {
    return next(new AppError('Vendor does not have a connected Stripe account.', 400));
  }

  const account = await receiveAccount(vendor.stripeAccountId);
  if (!account?.charges_enabled && !account?.payouts_enabled) {
    return next(new AppError('Vendor Stripe account is not enabled for transfers.', 400));
  }

  const amountInCents = Math.round(payment.amount * 100);
  const transfer = await maintoConnect({ vendor, amountInCents });

  if (!transfer) return next(new AppError('Stripe transfer failed.', 500));

  payment.escrowStatus = 'released';
  payment.stripeTransferId = transfer.id;
  payment.status = 'completed';
  await payment.save();

  booking.paymentStatus = true;
  await booking.save();

  res.status(200).json({
    status: 'success',
    message: 'Delayed payout released to vendor.',
    data: { bookingId, transferId: transfer.id, amount: payment.amount }
  });
});

module.exports = {
    getAllpaymentsforVendor,
    getAllPayments,
    vendorPayout,
    getsinglecompletedbooking,
    getEscrowStatus,
    fileDispute,
    resolveDispute,
    adminReleaseEscrow
};
