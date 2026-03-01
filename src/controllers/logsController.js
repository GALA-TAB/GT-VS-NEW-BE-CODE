
const mongoose = require('mongoose');
const Logs = require('../models/Logs');
const APIFeatures = require('../utils/apiFeatures');
const AppError = require('../utils/appError');
const catchAsync = require('../utils/catchAsync');
const User = require('../models/users/User');

/** GET /api/logs/:id  — all logs for a specific user */
const getAllLogs = catchAsync(async (req, res, next) => {
    const { id } = req.params;
    const { page = 1, limit = 10 } = req.query;
    const skip = (page - 1) * limit;
    const query = {
        actorId: id
    };
    const apiFeature = new APIFeatures(Logs.find(query), req.query).paginate().sort();

    const [total, logs] = await Promise.all([
        Logs.countDocuments(query),
        apiFeature.query
            .populate('actorId', ['email', 'profileCompleted', 'lastName', 'firstName', 'profilePicture', 'role', 'adminRole'])
    ]);

    res.status(200).json({
        status: 'success',
        results: logs.length,
        page: Number(page),
        limit: Number(limit),
        logs,
        totalLogs: total
    });
});

/**
 * GET /api/logs  — all logs across all users (admin overview)
 * Query params: page, limit, actorModel (admin|vendor|customer), action, search, startDate, endDate
 */
const getAllLogsForAdmin = catchAsync(async (req, res, next) => {
    const {
        page = 1,
        limit = 20,
        actorModel,
        action,
        search,
        startDate,
        endDate
    } = req.query;

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
    const skip = (pageNum - 1) * limitNum;

    const query = {};

    if (actorModel) query.actorModel = actorModel;
    if (action) query.action = action;

    if (startDate || endDate) {
        query.createdAt = {};
        if (startDate) query.createdAt.$gte = new Date(startDate);
        if (endDate) {
            const end = new Date(endDate);
            end.setHours(23, 59, 59, 999);
            query.createdAt.$lte = end;
        }
    }

    // If search is provided, do a join-style filter via actor name/email
    let actorIds = null;
    if (search && search.trim()) {
        const regex = new RegExp(search.trim(), 'i');
        const matchedUsers = await User.find({
            $or: [
                { firstName: regex },
                { lastName: regex },
                { email: regex },
                { fullName: regex }
            ]
        }).select('_id');
        actorIds = matchedUsers.map(u => u._id);
        query.actorId = { $in: actorIds };
    }

    const [total, logs] = await Promise.all([
        Logs.countDocuments(query),
        Logs.find(query)
            .populate('actorId', ['email', 'firstName', 'lastName', 'profilePicture', 'role', 'adminRole'])
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limitNum)
    ]);

    res.status(200).json({
        status: 'success',
        results: logs.length,
        page: pageNum,
        limit: limitNum,
        totalLogs: total,
        logs
    });
});

module.exports = {
    getAllLogs,
    getAllLogsForAdmin
};

