const Suspension = require('../models/Suspension');
const User = require('../models/users/User');
const AppError = require('../utils/appError');
const catchAsync = require('../utils/catchAsync');
const dayjs = require('dayjs');
const createLog = require('../utils/createLog');

// Calculate suspension end date
const calculateSuspensionEndDate = (duration, unit) => {
  if (!duration || !unit) return null;
  
  let endDate = dayjs();
  
  switch(unit) {
    case 'hours':
      endDate = endDate.add(duration, 'hour');
      break;
    case 'days':
      endDate = endDate.add(duration, 'day');
      break;
    case 'weeks':
      endDate = endDate.add(duration, 'week');
      break;
    case 'months':
      endDate = endDate.add(duration, 'month');
      break;
    default:
      return null;
  }
  
  return endDate.toDate();
};

// Get all suspensions
const getAllSuspensions = catchAsync(async (req, res, next) => {
  const { page = 1, limit = 10, search, status, userRole } = req.query;
  
  const query = {};
  
  if (search) {
    query.$or = [
      { userName: { $regex: search, $options: 'i' } },
      { userEmail: { $regex: search, $options: 'i' } },
      { reason: { $regex: search, $options: 'i' } }
    ];
  }
  
  if (status) {
    query.status = status;
  }
  
  if (userRole) {
    query.userRole = userRole;
  }
  
  const skip = (page - 1) * limit;
  
  const suspensions = await Suspension.find(query)
    .populate('userId', 'firstName lastName email profilePicture')
    .populate('suspendedBy', 'firstName lastName email')
    .populate('liftedBy', 'firstName lastName email')
    .sort({ suspendedAt: -1 })
    .skip(skip)
    .limit(parseInt(limit));
  
  const total = await Suspension.countDocuments(query);
  
  res.status(200).json({
    success: true,
    data: suspensions,
    pagination: {
      total,
      page: parseInt(page),
      limit: parseInt(limit),
      pages: Math.ceil(total / limit)
    }
  });
});

// Create suspension
const createSuspension = catchAsync(async (req, res, next) => {
  const { userId, userRole, reason, suspensionType, duration, durationUnit } = req.body;
  
  // Validate user exists
  const user = await User.findById(userId);
  if (!user) {
    return next(new AppError('User not found', 404));
  }
  
  // Check if already suspended
  const existingSuspension = await Suspension.findOne({
    userId,
    status: 'active'
  });
  
  if (existingSuspension) {
    return next(new AppError('User is already suspended', 400));
  }
  
  // Calculate end date
  let suspensionEndDate = null;
  if (suspensionType === 'temporary') {
    suspensionEndDate = calculateSuspensionEndDate(duration, durationUnit);
    if (!suspensionEndDate) {
      return next(new AppError('Invalid duration or unit', 400));
    }
  }
  
  // Create suspension record
  const suspension = await Suspension.create({
    userId,
    userRole,
    userName: `${user.firstName} ${user.lastName}`,
    userEmail: user.email,
    reason,
    suspensionType,
    duration: suspensionType === 'temporary' ? duration : null,
    durationUnit: suspensionType === 'temporary' ? durationUnit : null,
    suspensionEndDate,
    suspendedBy: req.user._id,
    suspendedByName: `${req.user.firstName} ${req.user.lastName}`
  });
  
  // Update user status to "Suspend"
  await User.findByIdAndUpdate(userId, { status: 'Suspend' });

  // Activity log
  createLog({
    actorId: req.user._id,
    actorModel: 'admin',
    action: 'SUSPEND_USER',
    description: `Suspended ${user.email} — Reason: ${reason || 'No reason provided'}`,
    target: 'User',
    targetId: userId,
    ipAddress: req.ip || req.headers['x-forwarded-for'],
  });

  res.status(201).json({
    success: true,
    message: 'User suspended successfully',
    data: suspension
  });
});

// Lift suspension
const liftSuspension = catchAsync(async (req, res, next) => {
  const { suspensionId } = req.params;
  const { reason } = req.body;
  
  const suspension = await Suspension.findById(suspensionId);
  if (!suspension) {
    return next(new AppError('Suspension not found', 404));
  }
  
  if (suspension.status !== 'active') {
    return next(new AppError('This suspension is not active', 400));
  }
  
  // Update suspension
  suspension.status = 'lifted';
  suspension.liftedAt = new Date();
  suspension.liftedBy = req.user._id;
  suspension.liftReason = reason;
  await suspension.save();
  
  // Update user status back to "Active"
  await User.findByIdAndUpdate(suspension.userId, { status: 'Active' });

  // Activity log
  createLog({
    actorId: req.user._id,
    actorModel: 'admin',
    action: 'LIFT_SUSPENSION',
    description: `Lifted suspension for user ${suspension.userEmail} — Reason: ${reason || 'No reason provided'}`,
    target: 'User',
    targetId: suspension.userId,
    ipAddress: req.ip || req.headers['x-forwarded-for'],
  });

  res.status(200).json({
    success: true,
    message: 'Suspension lifted successfully',
    data: suspension
  });
});

// Get user suspension history
const getUserSuspensionHistory = catchAsync(async (req, res, next) => {
  const { userId } = req.params;
  const { page = 1, limit = 10 } = req.query;
  
  // Validate user exists
  const user = await User.findById(userId);
  if (!user) {
    return next(new AppError('User not found', 404));
  }
  
  const skip = (page - 1) * limit;
  
  const suspensions = await Suspension.find({ userId })
    .populate('suspendedBy', 'firstName lastName email')
    .populate('liftedBy', 'firstName lastName email')
    .sort({ suspendedAt: -1 })
    .skip(skip)
    .limit(parseInt(limit));
  
  const total = await Suspension.countDocuments({ userId });
  
  res.status(200).json({
    success: true,
    data: suspensions,
    pagination: {
      total,
      page: parseInt(page),
      limit: parseInt(limit),
      pages: Math.ceil(total / limit)
    }
  });
});

// Get single suspension
const getSuspension = catchAsync(async (req, res, next) => {
  const { suspensionId } = req.params;
  
  const suspension = await Suspension.findById(suspensionId)
    .populate('userId', 'firstName lastName email profilePicture')
    .populate('suspendedBy', 'firstName lastName email')
    .populate('liftedBy', 'firstName lastName email');
  
  if (!suspension) {
    return next(new AppError('Suspension not found', 404));
  }
  
  res.status(200).json({
    success: true,
    data: suspension
  });
});

// Update suspension (for appeals, notes, etc.)
const updateSuspension = catchAsync(async (req, res, next) => {
  const { suspensionId } = req.params;
  const { notes, appealReason, appealStatus } = req.body;
  
  const suspension = await Suspension.findById(suspensionId);
  if (!suspension) {
    return next(new AppError('Suspension not found', 404));
  }
  
  if (notes !== undefined) suspension.notes = notes;
  if (appealReason !== undefined) suspension.appealReason = appealReason;
  if (appealStatus !== undefined) suspension.appealStatus = appealStatus;
  
  if (appealStatus === 'approved') {
    suspension.status = 'lifted';
    suspension.liftedAt = new Date();
    suspension.liftedBy = req.user._id;
    suspension.liftReason = `Appeal approved: ${appealReason}`;
    
    // Update user status back to "Active"
    await User.findByIdAndUpdate(suspension.userId, { status: 'Active' });
  }
  
  await suspension.save();
  
  res.status(200).json({
    success: true,
    message: 'Suspension updated successfully',
    data: suspension
  });
});

// Delete suspension (admin action)
const deleteSuspension = catchAsync(async (req, res, next) => {
  const { suspensionId } = req.params;
  
  const suspension = await Suspension.findByIdAndDelete(suspensionId);
  if (!suspension) {
    return next(new AppError('Suspension not found', 404));
  }
  
  res.status(200).json({
    success: true,
    message: 'Suspension deleted successfully'
  });
});

// Auto-expire temporary suspensions (cron job)
const expireActiveSuspensions = catchAsync(async (req, res, next) => {
  const now = new Date();
  
  const expiredSuspensions = await Suspension.find({
    suspensionType: 'temporary',
    status: 'active',
    suspensionEndDate: { $lt: now }
  });
  
  for (const suspension of expiredSuspensions) {
    suspension.status = 'expired';
    await suspension.save();
    
    // Auto-lift the suspension and restore user status
    await User.findByIdAndUpdate(suspension.userId, { status: 'Active' });
  }
  
  res.status(200).json({
    success: true,
    message: `${expiredSuspensions.length} suspensions expired and lifted`,
    data: expiredSuspensions
  });
});

module.exports = {
  getAllSuspensions,
  createSuspension,
  liftSuspension,
  getUserSuspensionHistory,
  getSuspension,
  updateSuspension,
  deleteSuspension,
  expireActiveSuspensions
};
