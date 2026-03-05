const ClientReview = require('../models/ClienReview');
const AppError = require('../utils/appError');
const catchAsync = require('../utils/catchAsync');
const APIFeatures = require('../utils/apiFeatures');
const { ClientReviewValidation } = require('../utils/joi/clientReviewValidation');
const joiError = require('../utils/joiError');
const { normalizeIsDeleted, withSoftDeleteFilter } = require('../utils/softDeleteFilter');
const { moderateText } = require('../utils/mediaModeration');

// Create a new client review
const createClientReview = catchAsync(async (req, res, next) => {
    const { rating, description, clientName, imageKey, imageUrl } = req.body;

    // Joi Validation
    const schema = ClientReviewValidation.fork(['rating', 'description', 'clientName'], (field) => field.required());
    const { error } = schema.validate(req.body, {
        abortEarly: false
    });

    if (error) {
        const errorFields = joiError(error);
        return next(new AppError('Validation failed', 400, { errorFields }));
    }

    // Text content moderation
    if (description) {
        const { approved, reasons } = moderateText(description);
        if (!approved) {
            return next(new AppError(
                `Review contains prohibited content: ${reasons[0]}`,
                400,
                { field: 'description', reasons }
            ));
        }
    }

    // Create the client review
    const clientReview = await ClientReview.create({
        rating,
        description,
        clientName,
        imageKey: imageKey || '',
        imageUrl: imageUrl || ''
    });

    res.locals.dataId = clientReview._id;

    res.status(201).json({
        status: 'success',
        message: 'Client review created successfully',
        data: {
            clientReview
        }
    });
});

// Get all client reviews
const getAllClientReviews = catchAsync(async (req, res, next) => {
    const {
        page = 1,
        limit = 10,
        rating,
        isActive,
        search,
        sort = '-createdAt'
    } = req.query;
    const isDeleted = normalizeIsDeleted(req.query.isDeleted);

    const skip = (page - 1) * limit;
    const matchStage = {};

    // Filter by rating
    if (rating) {
        matchStage.rating = Number(rating);
    }

    // Filter by active status
    if (isActive !== undefined) {
        matchStage.isActive = isActive === 'true';
    }

    // Search by client name or description
    if (search) {
        matchStage.$or = [
            { clientName: { $regex: search, $options: 'i' } },
            { description: { $regex: search, $options: 'i' } }
        ];
    }

    const finalMatchStage = withSoftDeleteFilter(matchStage, isDeleted);

    // Get reviews with pagination
    const clientReviews = await ClientReview.find(finalMatchStage)
        .sort(sort)
        .skip(skip)
        .limit(parseInt(limit));

    const total = await ClientReview.countDocuments(finalMatchStage);

    res.status(200).json({
        status: 'success',
        results: clientReviews.length,
        total,
        page: parseInt(page),
        totalPages: Math.ceil(total / limit),
        data: {
            clientReviews
        }
    });
});

// Get single client review by ID
const getClientReviewById = catchAsync(async (req, res, next) => {
    const { id } = req.params;

    const clientReview = await ClientReview.findById(id);

    if (!clientReview) {
        return next(new AppError('Client review not found', 404));
    }

    res.status(200).json({
        status: 'success',
        data: {
            clientReview
        }
    });
});

// Update client review
const updateClientReview = catchAsync(async (req, res, next) => {
    const { id } = req.params;
    const { rating, description, clientName, imageKey, imageUrl, isActive } = req.body;

    // Joi Validation for update (all fields optional)
    const { error } = ClientReviewValidation.validate(req.body, {
        abortEarly: false
    });

    if (error) {
        const errorFields = joiError(error);
        return next(new AppError('Validation failed', 400, { errorFields }));
    }

    const clientReview = await ClientReview.findById(id);

    if (!clientReview) {
        return next(new AppError('Client review not found', 404));
    }

    if (clientReview.isDeleted) {
        return next(new AppError('Cannot update a deleted client review', 400));
    }

    // Update rating if provided
    if (rating !== undefined) {
        clientReview.rating = rating;
    }

    // Update fields if provided
    if (description !== undefined) clientReview.description = description;
    if (clientName !== undefined) clientReview.clientName = clientName;
    if (imageKey !== undefined) clientReview.imageKey = imageKey;
    if (imageUrl !== undefined) clientReview.imageUrl = imageUrl;
    if (isActive !== undefined) clientReview.isActive = isActive;

    await clientReview.save();

    res.locals.dataId = clientReview._id;

    res.status(200).json({
        status: 'success',
        message: 'Client review updated successfully',
        data: {
            clientReview
        }
    });
});

// Delete client review (hard delete)
const deleteClientReview = catchAsync(async (req, res, next) => {
    const { id } = req.params;

    const clientReview = await ClientReview.findByIdAndDelete(id);

    if (!clientReview) {
        return next(new AppError('Client review not found', 404));
    }

    res.locals.dataId = id;

    res.status(200).json({
        status: 'success',
        message: 'Client review deleted successfully',
        data: null
    });
});

// Get all client reviews for landing page (no pagination, only active)
const getLandingPageReviews = catchAsync(async (req, res, next) => {
    // Get all active reviews for landing page display
    const clientReviews = await ClientReview.find({ 
        isDeleted: false, 
        isActive: true 
    })
        .select('rating description clientName imageKey imageUrl createdAt')
        .sort('-createdAt')
        .lean();

    // Calculate average rating
    const totalReviews = clientReviews.length;
    const averageRating = totalReviews > 0 
        ? (clientReviews.reduce((sum, review) => sum + review.rating, 0) / totalReviews).toFixed(1)
        : 0;

    res.status(200).json({
        status: 'success',
        results: clientReviews.length,
        averageRating: parseFloat(averageRating),
        data: {
            clientReviews
        }
    });
});

module.exports = {
    createClientReview,
    getAllClientReviews,
    getClientReviewById,
    updateClientReview,
    deleteClientReview,
    getLandingPageReviews
};
