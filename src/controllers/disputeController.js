
const Dispute = require('../models/Dispute');
const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const { disputeValidation } = require('../utils/joi/disputeValidation');
const ServiceListing = require('../models/ServiceListing');
const mongoose = require('mongoose');
const User = require('../models/users/User');
const Booking = require('../models/Bookings');
const sendNotification = require('../utils/storeNotification');
const { normalizeIsDeleted, withSoftDeleteFilter } = require('../utils/softDeleteFilter');

const createDispute = catchAsync(async (req, res, next) => {
    const { description, property, status } = req.body;

    const partialSchema = disputeValidation.fork(["description", "property"], (schema) => schema.required());
    const { error } = partialSchema.validate(req.body, {
        abortEarly: false,
        allowUnknown: true
    });

    if (error) {
        const errorFields = error.details.reduce((acc, err) => {
            acc[err.context.key] = err.message.replace(/['"]/g, '');
            return acc;
        }, {});

        return next(new AppError('Validation failed', 400, { errorFields }));
    }

    const dispute = await Dispute.create({
        description, property, status,
        disputeBy: req.user?._id,
        disputeRole: req.user?.role
    });

    // Get booking details to get service information
    const booking = await Booking.findById(property).populate('service', 'title');
    const serviceName = booking?.service?.title || 'a service';

    // Find admin to send notification
    const admin = await User.findOne({ role: 'admin' });

    if (admin) {
        // Send notification to admin about new dispute
        await sendNotification({
            userId: admin._id,
            title: 'New Dispute Created',
            message: `${req.user.firstName} ${req.user.lastName} (${req.user.role}) has created a dispute for ${serviceName}`,
            type: 'booking',
            fortype: 'venue_cancellation',
            permission: 'disputes',
            linkUrl: `/admin-dashboard/dispute-details?disputeId=${dispute._id}`
        });
    }

    res.locals.dataId = dispute._id; // Store the ID of the created dispute in res.locals
    return res.status(200).json({
        dispute,
        status: 'success',
        message: "Dispute created Successfully"
    });

});

const updateDispute = catchAsync(async (req, res, next) => {
    const { id } = req.params
    const { error } = disputeValidation.validate(req.body, {
        partial: true,
        abortEarly: false
    });

    if (error) {
        const errorFields = error.details.reduce((acc, err) => {
            acc[err.context.key] = err.message.replace(/['"]/g, '');
            return acc;
        }, {});

        return next(new AppError('Validation failed', 400, { errorFields }));
    }

    const dispute = await Dispute.findByIdAndUpdate(id, req.body, { new: true, runValidators: true })
    if (!dispute) {
        return next(new AppError(`Dispute not found by ${id}`, 404));
    }
    res.locals.dataId = dispute._id; // Store the ID of the created dispute in res.locals
    return res.status(200).json({
        dispute,
        status: 'success',
        message: "Dispute updated Successfully"
    })

})
const updateStatus = catchAsync(async (req, res, next) => {
    const { id } = req.params;
    const { status } = req.body;

    if (!status) {
        return next(new AppError(`Validation data`, 404, {
            status: "status is required"
        }));
    }

    // Populate dispute details before updating
    const oldDispute = await Dispute.findById(id).populate('disputeBy', 'firstName lastName email role').populate('property');
    
    if (!oldDispute) {
        return next(new AppError(`Dispute not found by ${id}`, 404));
    }

    // Update the dispute status
    const dispute = await Dispute.findByIdAndUpdate(id, { status }, { new: true, runValidators: true });

    // Get booking details for service information
    const booking = await Booking.findById(oldDispute.property).populate('service', 'title');
    const serviceName = booking?.service?.title || 'the service';

    // Send notification to dispute creator (customer or vendor)
    if (oldDispute.disputeBy) {
        let statusMessage = '';
        let notificationType = 'booking';
        
        switch (status) {
            case 'Review':
                statusMessage = `Your dispute for ${serviceName} is now under review by admin`;
                break;
            case 'Accept':
                statusMessage = `Your dispute for ${serviceName} has been accepted by admin`;
                break;
            case 'Reject':
                statusMessage = `Your dispute for ${serviceName} has been rejected by admin`;
                break;
            default:
                statusMessage = `Your dispute status for ${serviceName} has been updated to ${status}`;
        }

        await sendNotification({
            userId: oldDispute.disputeBy._id,
            title: `Dispute ${status}`,
            message: statusMessage,
            type: notificationType,
            fortype: 'venue_cancellation',
            permission: 'disputes',
            linkUrl: oldDispute?.disputeBy?.role === "vendor" ? `/vendor-dashboard/dispute-details?disputeId=${oldDispute._id}` : `/user-dashboard/dispute-details?disputeId=${oldDispute._id}`
        });
    }

    res.locals.dataId = dispute._id; // Store the ID of the created dispute in res.locals
    return res.status(200).json({
        dispute,
        status: 'success',
        message: "Status update Successfully"
    });

});
const getAllDisputeForAdmin = catchAsync(async (req, res) => {
    // Parse query parameters, including search (for property title)
    const {
        page = 1,
        limit = 10,
        sortBy = 'createdAt',
        sortOrder = 'desc',
        userRole,
        search
    } = req.query;
    const isDeleted = normalizeIsDeleted(req.query.isDeleted);
    const skip = (page - 1) * parseInt(limit, 10);
    const sortOptions = { [sortBy]: sortOrder === 'asc' ? 1 : -1 };
    const baseMatch = withSoftDeleteFilter({}, isDeleted);
    if (userRole) {
        baseMatch.disputeRole = userRole;
    }

    // Date range filter
    const { startDate, endDate } = req.query;
    if (startDate || endDate) {
        baseMatch.createdAt = {};
        if (startDate) baseMatch.createdAt.$gte = new Date(startDate);
        if (endDate) {
            const end = new Date(endDate);
            end.setHours(23, 59, 59, 999);
            baseMatch.createdAt.$lte = end;
        }
    }

    const pipeline = [
        { $match: baseMatch },
        {
            $lookup: {
                from: 'bookings',
                localField: 'property',
                foreignField: '_id',
                as: 'booking'
            }
        },
        { $unwind: '$booking' },
        {
            $lookup: {
                from: 'servicelistings',
                localField: 'booking.service',
                foreignField: '_id',
                as: 'property'
            }
        },
        { $unwind: { path: '$property', preserveNullAndEmptyArrays: true } }, // Use preserveNullAndEmptyArrays to keep disputes without a property
        {
            $lookup: {
                from: 'users',
                localField: 'disputeBy',
                foreignField: '_id',
                as: 'userDetails'
            }
        },
        { $unwind: { path: '$userDetails', preserveNullAndEmptyArrays: true } },
        {
            $lookup: {
                from: 'users',
                localField: 'property.vendorId',
                foreignField: '_id',
                as: 'vendor'
            }
        },
        { $unwind: { path: '$vendor', preserveNullAndEmptyArrays: true } }
        // optional: if you expect only one user detail
    ];


    // 6. If a search query is provided, filter based on the property title (case-insensitive).
    if (search) {
        pipeline.push({
            $match: {
                'property.title': { $regex: search, $options: 'i' }
            }
        });
    }

    // 7. Define a results pipeline that will sort, skip, and limit the paginated results.
    const resultsPipeline = [
        { $sort: sortOptions },
        { $skip: skip },
        { $limit: parseInt(limit, 10) }
    ];

    // 8. Use a facet to get both the paginated results and the total count in a single query.
    const aggregatePipeline = [
        ...pipeline,
        {
            $facet: {
                paginatedResults: resultsPipeline,
                totalCount: [{ $count: 'count' }]
            }
        }
    ];

    // Run the aggregation pipeline.
    const aggregateResult = await Dispute.aggregate(aggregatePipeline);

    console.log(aggregateResult, "how this is  possible")

    // Extract the paginated results and total count from the facet result.
    const { paginatedResults } = aggregateResult[0];
    const totalCount =
        aggregateResult[0].totalCount.length > 0
            ? aggregateResult[0].totalCount[0].count
            : 0;

    return res.status(200).json({
        status: 'success',
        results: paginatedResults.length,
        totalDisputes: totalCount,
        data: paginatedResults
    });
});

const getAllDisputeOfUser = catchAsync(async (req, res) => {
    const {
        page = 1,
        limit = 10,
        sortBy = 'createdAt',
        sortOrder = 'desc',
        status,
        search = '',
    } = req.query;
    const isDeleted = normalizeIsDeleted(req.query.isDeleted);
    const skip = (page - 1) * parseInt(limit, 10);

    // Base match for disputes of the logged-in user (and status if provided)
    const baseMatch = withSoftDeleteFilter({ disputeBy: req.user?._id }, isDeleted);
    if (status) {
        baseMatch.status = status;
    }

    // Build aggregation pipeline:
    const pipeline = [
        // Match disputes by current user (and status, if provided)
        { $match: baseMatch },

        {
            $lookup: {
                from: 'bookings',
                localField: 'property',
                foreignField: '_id',
                as: 'booking'
            }
        },
        { $unwind: '$booking' },
        {
            $lookup: {
                from: 'servicelistings',
                localField: 'booking.service',
                foreignField: '_id',
                as: 'property'
            }
        },
        { $unwind: '$property' },
        {
            $lookup: {
                from: 'users',
                localField: 'property.vendorId',
                foreignField: '_id',
                as: 'vendor'
            }
        },
        { $unwind: '$vendor' }
    ];

    // If a search query is provided, match disputes where property.title matches.
    if (search) {
        pipeline.push({
            $match: {
                'property.title': { $regex: search, $options: 'i' }
            }
        });
    }

    // Create a facet to perform a total count and pagination in one query.
    const resultsPipeline = [
        { $sort: { [sortBy]: sortOrder === 'asc' ? 1 : -1 } },
        { $skip: skip },
        { $limit: parseInt(limit, 10) }
    ];

    // We run two pipelines:
    // 1. One to get the paginated data.
    // 2. One to count the total matched documents.
    const aggregatePipeline = [
        ...pipeline,
        {
            $facet: {
                paginatedResults: resultsPipeline,
                totalCount: [{ $count: 'count' }]
            }
        }
    ];

    const aggregateResult = await Dispute.aggregate(aggregatePipeline);

    // Retrieve results from facet
    const { paginatedResults } = aggregateResult[0];
    const totalCount =
        aggregateResult[0].totalCount.length > 0
            ? aggregateResult[0].totalCount[0].count
            : 0;

    return res.status(200).json({
        status: 'success',
        results: paginatedResults.length,
        totalDisputes: totalCount,
        data: paginatedResults
    });
});

const deleteDispute = catchAsync(async (req, res, next) => {
    const { id } = req.params
    if (!id) {
        return next(new AppError('Please provide Dispute id', 400));
    }

    const deletedDispute = await Dispute.findOneAndUpdate({ _id: id, disputeBy: req.user?._id }, { isDeleted: true }, { new: true })

    if (!deletedDispute) {
        return next(new AppError(`Dispute not found by ${id}`, 404));
    }
    res.locals.dataId = deletedDispute._id; // Store the ID of the created dispute in res.locals
    return res.status(200).json({
        status: 'success',
        data: null,
        message: "Dispute deleted Successfully"
    })

})
const getSingleDisputeById = catchAsync(async (req, res, next) => {
    const { id } = req.params;
    const dispute = await Dispute.findById(id)
        .populate({
            path: 'property',
            populate: {
                path: 'service',
                model: 'ServiceListing',
                select: 'title vendorId description'

            }
        }).populate("disputeBy");

    if (!dispute) {
        return next(new AppError(`Dispute not found by ${id}`, 404));
    }

    return res.status(200).json({
        status: 'success',
        data: dispute
    });
});
const getSingleDisputeForuser = catchAsync(async (req, res, next) => {
    const { id } = req.params;
    const dispute = await Dispute.aggregate([
        { $match: { _id:new mongoose.Types.ObjectId(id), disputeBy: req.user._id } },
        {
            $lookup: {
                from: 'users',
                foreignField: '_id',
                localField: 'disputeBy',
                as: 'disputeBy',
               
            }
        },
        {
            $lookup: {
                from: 'bookings',
                foreignField: '_id',
                localField: 'property',
                as: 'booking',
             
            }
        },
        { $unwind: { path: '$property', preserveNullAndEmptyArrays: true } },
        {
            $lookup: {
                from: 'servicelistings',
                foreignField: '_id',
                localField: 'booking.service',
                as: 'property',
            
            }
        },
        { $unwind: { path: '$property', preserveNullAndEmptyArrays: true } },
        {
            $lookup: {
                from: 'users',
                foreignField: '_id',
                localField: 'property.vendorId',
                as: 'property.vendorId',
             
            }
        },
        { $unwind: { path: '$property.vendor', preserveNullAndEmptyArrays: true } },
        { $unwind: { path: '$disputeBy', preserveNullAndEmptyArrays: true } }
    ]);

    if (!dispute.length) {
        return next(new AppError(`Dispute not found by dispute ${id} and user ${req.user._id}`, 404));
    }
    return res.status(200).json({
        status: 'success',
        data: dispute[0]
    });
});

const getProperties = catchAsync(async (req, res) => {
    const {
        page = 1,
        limit = 10,
        search
    } = req.query;

    const query = {};
    if (search) {
        query.title = { $regex: new RegExp(search, 'i') };
    }

    const totalCount = await ServiceListing.countDocuments(query);
    const serviceListings = await ServiceListing.find(query, { title: 1, _id: 1 })
        .sort({ createdAt: 1 })
        .skip((page - 1) * parseInt(limit, 10))
        .limit(parseInt(limit, 10));

    return res.status(200).json({
        status: "success",
        results: serviceListings.length,
        totalCount,
        totalPages: Math.ceil(totalCount / limit),
        currentPage: parseInt(page, 10),
        data: serviceListings
    });
});

module.exports = {
    createDispute,
    updateDispute,
    updateStatus,
    getAllDisputeForAdmin,
    getAllDisputeOfUser,
    deleteDispute,
    getProperties,
    getSingleDisputeById,
    getSingleDisputeForuser

};

