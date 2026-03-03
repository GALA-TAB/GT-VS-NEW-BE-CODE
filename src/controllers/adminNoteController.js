const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const AdminNote = require('../models/AdminNote');

/**
 * POST /api/admin-note
 * Admin only — create a permanent note on a user / vendor.
 */
exports.createNote = catchAsync(async (req, res, next) => {
  const { targetUserId, targetName, targetRole, type, note } = req.body;

  if (!note || !String(note).trim()) {
    return next(new AppError('note text is required.', 400));
  }
  if (!targetName || !String(targetName).trim()) {
    return next(new AppError('targetName is required.', 400));
  }

  const adminFirstName = req.user.firstName || '';
  const adminLastName  = req.user.lastName  || '';
  const adminFullName  =
    `${adminFirstName} ${adminLastName}`.trim() ||
    req.user.name ||
    req.user.fullName ||
    'Admin';

  const saved = await AdminNote.create({
    targetUserId:
      targetUserId ||
      `uid_${String(targetName).replace(/\s+/g, '_').toLowerCase()}`,
    targetName:    String(targetName).trim(),
    targetRole:    targetRole || 'vendor',
    type:          type       || 'protection',
    note:          String(note).trim().slice(0, 2000),
    addedByAdminId:   req.user._id,
    addedByAdminName: adminFullName,
  });

  res.status(201).json({ status: 'success', data: saved });
});

/**
 * GET /api/admin-note
 * Admin only — fetch all notes, newest first.
 *
 * Query params (all optional):
 *   ?targetUserId=<id>   filter to one user's notes
 *   ?type=protection|financial|general
 *   ?search=<text>       searches targetName + note body
 */
exports.getNotes = catchAsync(async (req, res, next) => {
  const filter = {};

  if (req.query.targetUserId) {
    filter.targetUserId = req.query.targetUserId;
  }
  if (req.query.type && ['protection', 'financial', 'general'].includes(req.query.type)) {
    filter.type = req.query.type;
  }
  if (req.query.search) {
    const rx = new RegExp(req.query.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$or = [
      { targetName: rx },
      { note: rx },
      { addedByAdminName: rx },
    ];
  }

  const notes = await AdminNote.find(filter)
    .sort({ createdAt: -1 })
    .lean();

  res.status(200).json({ status: 'success', count: notes.length, data: notes });
});
