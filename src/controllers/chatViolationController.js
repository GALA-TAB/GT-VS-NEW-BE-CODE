const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const ChatViolation = require('../models/ChatViolation');

/* ── Label → detectionType mapper (mirrors the frontend VIOLATION_RULES labels) ── */
const LABEL_TO_TYPE = {
  'Phone Number': 'phone',
  'Email Address': 'email',
  'Physical Address': 'address',
  'Social Handle': 'social',
  'Off-Platform Payment': 'off_platform',
  'External Contact': 'off_platform',
  'Profanity': 'profanity',
};

/**
 * POST /api/chat-violation
 * Called by the frontend immediately when a message is blocked.
 * Auth required (the blocked sender must be logged in).
 */
exports.reportViolation = catchAsync(async (req, res, next) => {
  const {
    chatId,
    messageExcerpt,
    detectionLabel,
    recipientId,
    recipientName,
    recipientRole,
  } = req.body;

  if (!messageExcerpt || !detectionLabel) {
    return next(new AppError('messageExcerpt and detectionLabel are required.', 400));
  }

  const detectionType = LABEL_TO_TYPE[detectionLabel] || 'other';

  const violation = await ChatViolation.create({
    senderId: req.user._id,
    senderName: req.user.name || req.user.fullName || '',
    senderEmail: req.user.email || '',
    senderRole: req.user.role || 'customer',
    recipientId: recipientId || null,
    recipientName: recipientName || '',
    recipientRole: recipientRole || '',
    chatId: chatId || '',
    messageExcerpt: String(messageExcerpt).slice(0, 300),
    detectionType,
    detectionLabel,
    status: 'blocked',
    actionTaken: 'Message blocked',
  });

  res.status(201).json({ status: 'success', data: violation });
});

/**
 * GET /api/chat-violation
 * Admin only — returns all violations, newest first.
 * Query params:
 *   ?type=phone|email|...   — filter by detectionType
 *   ?status=blocked|...     — filter by status
 *   ?limit=50               — max results (default 200)
 */
exports.getViolations = catchAsync(async (req, res, next) => {
  const filter = {};
  if (req.query.type)   filter.detectionType = req.query.type;
  if (req.query.status) filter.status = req.query.status;

  const limit = Math.min(parseInt(req.query.limit) || 200, 500);

  const violations = await ChatViolation.find(filter)
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();

  res.status(200).json({ status: 'success', count: violations.length, data: violations });
});

/**
 * PATCH /api/chat-violation/:id
 * Admin only — update status / actionTaken / adminNote.
 */
exports.updateViolation = catchAsync(async (req, res, next) => {
  const { status, actionTaken, adminNote } = req.body;

  const update = {};
  if (status)      update.status = status;
  if (actionTaken) update.actionTaken = actionTaken;
  if (adminNote !== undefined) update.adminNote = adminNote;
  update.reviewedBy = req.user._id;
  update.reviewedAt = new Date();

  const violation = await ChatViolation.findByIdAndUpdate(
    req.params.id,
    update,
    { new: true, runValidators: true }
  );

  if (!violation) return next(new AppError('Violation not found.', 404));

  res.status(200).json({ status: 'success', data: violation });
});

/**
 * DELETE /api/chat-violation/:id
 * Admin only — remove a single violation record.
 */
exports.deleteViolation = catchAsync(async (req, res, next) => {
  const violation = await ChatViolation.findByIdAndDelete(req.params.id);
  if (!violation) return next(new AppError('Violation not found.', 404));
  res.status(200).json({ status: 'success', message: 'Violation removed.' });
});

/**
 * GET /api/chat-violation/stats
 * Admin only — summary counts by type and status.
 */
exports.getViolationStats = catchAsync(async (req, res, next) => {
  const [byType, byStatus, total] = await Promise.all([
    ChatViolation.aggregate([{ $group: { _id: '$detectionType', count: { $sum: 1 } } }]),
    ChatViolation.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
    ChatViolation.countDocuments(),
  ]);

  res.status(200).json({ status: 'success', data: { total, byType, byStatus } });
});
