const BookingAgreement = require('../models/BookingAgreement');
const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const createLog = require('../utils/createLog');

const idOf = (value) => String(value?._id || value || '');

// GET /api/booking-agreements — Admin: list all agreements (paginated)
const getAllAgreements = catchAsync(async (req, res) => {
  const {
    page = 1,
    limit = 20,
    search,
    bookingId,
    userId,
    vendorId,
    startDate,
    endDate,
  } = req.query;

  const filter = {};

  if (bookingId) filter.booking = bookingId;
  if (userId) filter.user = userId;
  if (vendorId) filter.vendor = vendorId;

  if (startDate || endDate) {
    filter.signedAt = {};
    if (startDate) filter.signedAt.$gte = new Date(startDate);
    if (endDate) filter.signedAt.$lte = new Date(endDate);
  }

  const skip = (parseInt(page) - 1) * parseInt(limit);

  let query = BookingAgreement.find(filter)
    .populate('user', 'firstName lastName fullName email profilePicture')
    .populate('vendor', 'firstName lastName fullName email')
    .populate('booking', 'checkIn checkOut totalPrice status createdAt')
    .populate('service', 'title generatedTitle')
    .sort({ signedAt: -1 })
    .skip(skip)
    .limit(parseInt(limit));

  // If search is provided, do a secondary filter on populated fields
  const [agreements, total] = await Promise.all([
    query.lean(),
    BookingAgreement.countDocuments(filter),
  ]);

  // If search keyword provided, filter results by name/service
  let filtered = agreements;
  if (search) {
    const s = search.toLowerCase();
    filtered = agreements.filter(
      (a) =>
        a.user?.fullName?.toLowerCase().includes(s) ||
        a.user?.email?.toLowerCase().includes(s) ||
        a.vendor?.fullName?.toLowerCase().includes(s) ||
        a.service?.title?.toLowerCase().includes(s) ||
        a.agreementSnapshot?.serviceName?.toLowerCase().includes(s)
    );
  }

  res.status(200).json({
    status: 'success',
    results: filtered.length,
    total,
    page: parseInt(page),
    totalPages: Math.ceil(total / parseInt(limit)),
    data: filtered,
  });
});

// GET /api/booking-agreements/:id — Admin: view single agreement with full detail
const getAgreementById = catchAsync(async (req, res, next) => {
  const agreement = await BookingAgreement.findById(req.params.id)
    .populate('user', 'firstName lastName fullName email phone profilePicture')
    .populate('vendor', 'firstName lastName fullName email phone')
    .populate('booking', 'checkIn checkOut totalPrice status paymentIntentId createdAt')
    .populate('service', 'title generatedTitle');

  if (!agreement) {
    return next(new AppError('Agreement not found', 404));
  }

  res.status(200).json({
    status: 'success',
    data: agreement,
  });
});

// GET /api/booking-agreements/booking/:bookingId — Get agreement for a specific booking
// Admins see everything. The customer who signed sees their own agreement. The
// vendor on the booking sees the agreement but never the customer's ID images.
const getAgreementByBooking = catchAsync(async (req, res, next) => {
  const agreement = await BookingAgreement.findOne({ booking: req.params.bookingId })
    .populate('user', 'firstName lastName fullName email phone profilePicture')
    .populate('vendor', 'firstName lastName fullName email')
    .populate('booking', 'checkIn checkOut totalPrice status createdAt')
    .populate('service', 'title generatedTitle');

  if (!agreement) {
    return next(new AppError('No agreement found for this booking', 404));
  }

  const role = req.user.role;
  const userId = idOf(req.user);
  const isAdmin = role === 'admin';
  const isOwnerCustomer = role === 'customer' && idOf(agreement.user) === userId;
  // Vendor staff act on behalf of the vendor they belong to.
  const isBookingVendor =
    role === 'vendor' &&
    [userId, idOf(req.user.staffOf)].filter(Boolean).includes(idOf(agreement.vendor));

  if (!isAdmin && !isOwnerCustomer && !isBookingVendor) {
    return next(new AppError('You do not have permission to view this agreement', 403));
  }

  const data = agreement.toObject();
  if (isBookingVendor) {
    delete data.idFrontImage;
    delete data.idBackImage;
  }

  if (isAdmin) {
    // Government ID images are sensitive: leave an audit trail of who viewed them.
    createLog({
      actorId: req.user._id,
      actorModel: 'admin',
      action: 'VIEW_BOOKING_AGREEMENT',
      description: `Admin viewed booking agreement and ID for booking ${req.params.bookingId}`,
      target: 'BookingAgreement',
      targetId: agreement._id,
      ipAddress: req.ip || req.headers['x-forwarded-for'],
    });
  }

  res.status(200).json({
    status: 'success',
    data,
  });
});

module.exports = {
  getAllAgreements,
  getAgreementById,
  getAgreementByBooking,
};
