const QRCode = require('qrcode');
const catchAsync = require('../utils/catchAsync');
const KYCSesssion = require('../models/KYCSesson');
const { generateOTP } = require('./authController');
const KYCDocument = require('../models/KYCDocument');
const BusinessCertificate = require('../models/BusinessCertificate');
const TaxForum = require('../models/TaxForum');
const AppError = require('../utils/appError');
const { kycUploadSchema, approveRejectDocValidation } = require('../utils/joi/KYCValidation');
const { uploadVeriff } = require('../utils/veriff');
const Vendor = require('../models/users/Vendor');
const sendNotification = require('../utils/storeNotification');

// Helper: check if all 3 doc types are approved and auto-verify vendor
const checkAndAutoVerifyVendor = async (vendorId) => {
  const [kyc, cert, ein] = await Promise.all([
    KYCDocument.findOne({ userId: vendorId }),
    BusinessCertificate.findOne({ vendorId, isDeleted: false }),
    TaxForum.findOne({ vendorId, isDeleted: false })
  ]);
  const allApproved = kyc?.status === 'approved' && cert?.status === 'approved' && ein?.status === 'approved';
  if (allApproved) {
    await Vendor.findByIdAndUpdate(vendorId, { isVerified: true });
    await sendNotification({
      userId: vendorId,
      title: 'Verification Complete',
      message: 'Congratulations! All your documents have been verified. Your account is now fully verified.',
      type: 'alert',
    });
  } else {
    await Vendor.findByIdAndUpdate(vendorId, { isVerified: false });
  }
};

const initiateKyc = catchAsync(async (req, res, next) => {
  try {
    const userId = req.user._id;

    const { expires, hash: sessionToken } = generateOTP(6, 30); // Generate unique session token with 30 minute expiry

    // Saving session in DB
    await KYCSesssion.create({
      userId,
      sessionToken,
      expiresAt: expires
    });

    const qrCodeURL = `${process.env.FRONTEND_URL}/vendor-dashboard/verify-stepper?session=${sessionToken}`;
    const qrCodeImage = await QRCode.toDataURL(qrCodeURL); // Generate QR code

    return res.status(200).json({ success: true, sessionToken, qrCode: qrCodeImage, Url: qrCodeURL });
  } catch (error) {
    return next(new AppError('Session initiation error', 400, { error: error.message }));
  }
});

const uploadKyc = catchAsync(async (req, res, next) => {
  try {
    const { sessionToken, documentType, frontImage, backImage, selfieImage, country } = req.body;

    const { error } = kycUploadSchema.validate(req.body, {
      abortEarly: false
    });

    if (error) {
      const errorFields = error.details.reduce((acc, err) => {
        acc[err.context.key] = err.message.replace(/['"]/g, '');
        return acc;
      }, {});
      return next(new AppError('Validation failed', 400, { errorFields }));
    }

    // Validate the session token
    const session = await KYCSesssion.findOne({ sessionToken });
    if (!session) {
      return next(
        new AppError('Invalid or expired session token', 400, {
          session: 'Invalid or expired session token'
        })
      );
    }

    // Update or create KYC document
    const kyc = await KYCDocument.findOneAndUpdate(
      { userId: session.userId },
      {
        userId: session.userId,
        sessionToken,
        documentType,
        frontImageUrl: frontImage,
        backImageUrl: backImage,
        selfieImageUrl: selfieImage,
        country,
        status: 'inprogress'
      },
      { new: true, upsert: true, runValidators: true }
    );

    // Proceed with Veriff upload
    await uploadVeriff({
      ...req.body,
      kycId: kyc._id,
      ...req?.user?.toObject()
    });

    // Mark session as completed
    await KYCSesssion.deleteOne({ sessionToken });

    res.locals.dataId = kyc._id; // Store the KYC document ID for logging
    return res.status(200).json({ success: true, message: 'Documents uploaded successfully' });

  } catch (error) {
    return next(new AppError('Uploading docs failed', 400, { docs: error.message }));
  }
});

const getallPendingKYC = catchAsync(async (req, res, next) => {
  try {
    const pendingDocs = await KYCDocument.find({ status: 'pending' }).populate(
      'userId',
      'firstName lastName email'
    );
    return res.status(200).json({ success: true, data: pendingDocs });
  } catch (error) {
    return next(
      new AppError('Error fetching pending KYC requests', 400, {
        error: error.message
      })
    );
  }
});

const getallvendor = catchAsync(async (req, res) => {
  const page = req.query.page * 1 || 1;
  const limit = req.query.limit * 1 || 10;
  const skip = (page - 1) * limit;
  const search = req.query.search?.trim() || '';

  const searchRegex = new RegExp(search, 'i');

  const matchStage = {
    "user.role": "vendor"
  };

  // Date range filter
  const { startDate, endDate } = req.query;
  if (startDate || endDate) {
    matchStage.createdAt = {};
    if (startDate) matchStage.createdAt.$gte = new Date(startDate);
    if (endDate) {
      const end = new Date(endDate);
      end.setHours(23, 59, 59, 999);
      matchStage.createdAt.$lte = end;
    }
  }

  if (search) {
    matchStage.$or = [
      { "user.fullName": searchRegex }, // search on the virtual fullName
      { "user.email": searchRegex },
      { "user.companyName": searchRegex },
      { "user.contact": searchRegex },
      { "user.country": searchRegex }
    ];
  }

  const basePipeline = [
    {
      $lookup: {
        from: "users",
        localField: "userId",
        foreignField: "_id",
        as: "user"
      }
    },
    { $unwind: "$user" },
    {
      $addFields: {
        "user.fullName": {
          $concat: [
            { $ifNull: ["$user.firstName", ""] },
            " ",
            { $ifNull: ["$user.lastName", ""] }
          ]
        }
      }
    },
    { $match: matchStage },
    {
      $project: {
        sessionToken: 1,
        documentType: 1,
        frontImageUrl: 1,
        backImageUrl: 1,
        selfieImageUrl: 1,
        status: 1,
        rejectionReason: 1,
        country: 1,
        uploadedAt: 1,
        user: {
          _id: 1,
          firstName: 1,
          lastName: 1,
          fullName: 1,
          email: 1,
          status: 1,
          address: 1,
          city: 1,
          country: 1,
          contactVerified: 1,
          emailVerified: 1,
          role: 1,
          profilePicture: 1,
          emergencyCountryCode: 1,
          officeCountryCode: 1,
          countryCode: 1,
          companyName: 1,
          contact: 1,
          emergencyContact: 1,
          officeContact: 1
        }
      }
    }
  ];

  const sortOrder = req.query.sortOrder === 'desc' ? -1 : 1;

  const vendorKYCDocuments = await KYCDocument.aggregate([
    ...basePipeline,
    { $sort: { uploadedAt: sortOrder } },
    { $skip: skip },
    { $limit: limit }
  ]);

  const totalVendorKYCDocuments = await KYCDocument.aggregate([
    ...basePipeline,
    { $count: "total" }
  ]);

  const total = totalVendorKYCDocuments[0]?.total ?? 0;
  const totalPages = Math.ceil(total / limit);

  return res.status(200).json({
    status: 'success',
    data: vendorKYCDocuments,
    totalVendorKYCDocuments: total,
    totalPages,
    currentPage: page
  });
});


const approveRejectDocs = catchAsync(async (req, res, next) => {
  const { documentId, status, rejectionReason } = req.body;

  const { error } = approveRejectDocValidation.validate(req.body, {
    abortEarly: false
  });

  if (error) {
    const errorFields = error.details.reduce((acc, err) => {
      acc[err.context.key] = err.message.replace(/['"]/g, '');
      return acc;
    }, {});

    return next(new AppError('Validation failed', 400, { errorFields }));
  }

  try {
    const kycDoc = await KYCDocument.findById(documentId);
    if (!kycDoc) {
      return next(
        new AppError('KYC Document not found', 400, {
          doc: 'KYC Document not found'
        })
      );
    }

    kycDoc.status = status;
    if (status === 'rejected') {
      kycDoc.rejectionReason = rejectionReason || 'No reason provided';
    }
    if (status === 'approved') {
      kycDoc.approvedBy = req.user._id;
      kycDoc.approvedAt = new Date();
    }
  const updatedVendor = await Vendor.findByIdAndUpdate(kycDoc?.userId,{
            kycStatus:status,
            kycCompleted:status==="approved"?true:false
        },{new:true})
        console.log("updatedVendor",updatedVendor);

    await kycDoc.save();
    await checkAndAutoVerifyVendor(kycDoc.userId);

    // Send notification + email to vendor
    const notifTitle = status === 'approved' ? 'Identification Approved' : 'Identification Rejected';
    const notifMessage = status === 'approved'
      ? 'Your Identification document has been approved by Gala Tab.'
      : `Your Identification document has been rejected by Gala Tab. Reason: ${kycDoc.rejectionReason}`;
    await sendNotification({
      userId: kycDoc.userId,
      title: notifTitle,
      message: notifMessage,
      type: 'alert',
    });

    return res.status(200).json({ success: true, message: `KYC ${status} successfully` });
  } catch (err) {
    return next(
      new AppError('Error updating KYC status', 400, {
        error: err.message
      })
    );
  }
});

const updateKycStatus = catchAsync(async (req, res, next) => {
  const { status, rejectionReason } = req.body;
  const { documentId } = req.params;

  if (!status) {
    return next(new AppError('Status is required', 400, { status: 'Status is required' }));
  }
  const kycDoc = await KYCDocument.findById(documentId);
  if (!kycDoc) {
    return next(
      new AppError('KYC Document not found', 400, {
        doc: 'KYC Document not found'
      })
    );
  }

  kycDoc.status = status;
  if (status === 'abandoned' && rejectionReason) {
    kycDoc.rejectionReason = rejectionReason;
  }
  if (status === 'approved') {
    kycDoc.approvedBy = req.user._id;
    kycDoc.approvedAt = new Date();
  }
   const updatedVendor = await Vendor.findByIdAndUpdate(kycDoc?.userId,{
            kycStatus:status,
            kycCompleted:status==="approved"?true:false
        },{new:true})
  console.log("updatedVendor",updatedVendor);

  res.locals.dataId = kycDoc._id;

  await kycDoc.save();
  await checkAndAutoVerifyVendor(kycDoc.userId);
  return res.status(200).json({ success: true, message: `KYC ${status} successfully` });

});

const directUploadKyc = catchAsync(async (req, res, next) => {
  const { frontImage, backImage, selfieImage } = req.body;
  const userId = req.user._id;

  if (!frontImage) {
    return next(new AppError('Front image is required', 400, { frontImage: 'Front image is required' }));
  }
  if (!backImage) {
    return next(new AppError('Back image is required', 400, { backImage: 'Back image is required' }));
  }
  if (!selfieImage) {
    return next(new AppError('Selfie image is required', 400, { selfieImage: 'Selfie image is required' }));
  }

  // Check if vendor already has a KYC document - archive old one
  const existing = await KYCDocument.findOne({ userId });

  if (existing) {
    existing.archivedDocuments.push({
      frontImageUrl: existing.frontImageUrl,
      backImageUrl: existing.backImageUrl,
      selfieImageUrl: existing.selfieImageUrl,
      documentType: existing.documentType,
      status: existing.status,
      archivedAt: new Date()
    });
    existing.frontImageUrl = frontImage;
    existing.backImageUrl = backImage;
    existing.selfieImageUrl = selfieImage;
    existing.documentType = 'national_id';
    existing.status = 'pending';
    await existing.save();

    res.locals.dataId = existing._id;
    return res.status(200).json({
      status: 'success',
      data: existing,
      message: 'Identification resubmitted successfully. Previous documents have been archived.'
    });
  }

  const kyc = await KYCDocument.create({
    userId,
    documentType: 'national_id',
    frontImageUrl: frontImage,
    backImageUrl: backImage,
    selfieImageUrl: selfieImage,
    status: 'pending'
  });

  res.locals.dataId = kyc._id;
  return res.status(200).json({
    status: 'success',
    data: kyc,
    message: 'Identification submitted successfully'
  });
});

const getVendorVerificationStatus = catchAsync(async (req, res, next) => {
  const userId = req.user._id;

  const [kycDoc, businessCert, taxForum] = await Promise.all([
    KYCDocument.findOne({ userId }).select('status frontImageUrl backImageUrl selfieImageUrl rejectionReason uploadedAt approvedBy approvedAt'),
    BusinessCertificate.findOne({ vendorId: userId, isDeleted: false }).select('status documentUrl rejectionNote createdAt approvedBy approvedAt'),
    TaxForum.findOne({ vendorId: userId, isDeleted: false }).select('status taxDocument rejectionNote createdAt approvedBy approvedAt')
  ]);

  return res.status(200).json({
    status: 'success',
    data: {
      identification: kycDoc ? {
        status: kycDoc.status,
        frontImageUrl: kycDoc.frontImageUrl,
        backImageUrl: kycDoc.backImageUrl,
        selfieImageUrl: kycDoc.selfieImageUrl,
        rejectionReason: kycDoc.rejectionReason,
        uploadedAt: kycDoc.uploadedAt
      } : null,
      businessCertificate: businessCert ? {
        status: businessCert.status,
        documentUrl: businessCert.documentUrl,
        rejectionNote: businessCert.rejectionNote,
        createdAt: businessCert.createdAt
      } : null,
      einConfirmation: taxForum ? {
        status: taxForum.status,
        taxDocument: taxForum.taxDocument,
        rejectionNote: taxForum.rejectionNote,
        createdAt: taxForum.createdAt
      } : null
    }
  });
});

// Admin endpoint: get all documents for a specific vendor
const getVendorAllDocuments = catchAsync(async (req, res, next) => {
  const { vendorId } = req.params;

  const [kycDoc, businessCert, taxForum, vendor] = await Promise.all([
    KYCDocument.findOne({ userId: vendorId }).populate('approvedBy', 'firstName lastName email'),
    BusinessCertificate.findOne({ vendorId, isDeleted: false }).populate('approvedBy', 'firstName lastName email'),
    TaxForum.findOne({ vendorId, isDeleted: false }).populate('approvedBy', 'firstName lastName email'),
    Vendor.findById(vendorId).select('firstName lastName email contact profilePicture isVerified kycStatus businessCertificateStatus textForumStatus')
  ]);

  if (!vendor) {
    return next(new AppError('Vendor not found', 404));
  }

  return res.status(200).json({
    status: 'success',
    data: {
      vendor,
      identification: kycDoc || null,
      businessCertificate: businessCert || null,
      einConfirmation: taxForum || null
    }
  });
});

// Admin endpoint: get all vendors with any pending document (for New Requests tab)
const getPendingDocumentRequests = catchAsync(async (req, res, next) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 10;
  const search = req.query.search || '';

  // Find all pending documents across 3 collections
  const [pendingKyc, pendingBizCert, pendingTax] = await Promise.all([
    KYCDocument.find({ status: 'pending' })
      .populate('userId', 'firstName lastName email contact profilePicture')
      .select('userId status uploadedAt')
      .lean(),
    BusinessCertificate.find({ status: 'pending', isDeleted: false })
      .populate('vendorId', 'firstName lastName email contact profilePicture')
      .select('vendorId status createdAt')
      .lean(),
    TaxForum.find({ status: 'pending', isDeleted: false })
      .populate('vendorId', 'firstName lastName email contact profilePicture')
      .select('vendorId status createdAt')
      .lean()
  ]);

  // Build a map: vendorId -> { vendor, pendingDocs[], earliestDate }
  const vendorMap = {};

  const addToMap = (docs, docType, vendorField, dateField) => {
    for (const doc of docs) {
      const vendor = doc[vendorField];
      if (!vendor) continue;
      const vid = vendor._id.toString();
      if (!vendorMap[vid]) {
        vendorMap[vid] = { vendor, pendingDocs: [], earliestDate: null };
      }
      vendorMap[vid].pendingDocs.push(docType);
      const docDate = doc[dateField] || doc.createdAt;
      if (!vendorMap[vid].earliestDate || docDate < vendorMap[vid].earliestDate) {
        vendorMap[vid].earliestDate = docDate;
      }
    }
  };

  addToMap(pendingKyc, 'Identification', 'userId', 'uploadedAt');
  addToMap(pendingBizCert, 'Business Certificate', 'vendorId', 'createdAt');
  addToMap(pendingTax, 'EIN Confirmation', 'vendorId', 'createdAt');

  // Convert to array and sort oldest first
  let results = Object.values(vendorMap).sort(
    (a, b) => new Date(a.earliestDate) - new Date(b.earliestDate)
  );

  // Apply search filter
  if (search) {
    const s = search.toLowerCase();
    results = results.filter((r) => {
      const name = `${r.vendor.firstName || ''} ${r.vendor.lastName || ''}`.toLowerCase();
      const email = (r.vendor.email || '').toLowerCase();
      return name.includes(s) || email.includes(s);
    });
  }

  const total = results.length;
  const paginated = results.slice((page - 1) * limit, page * limit);

  return res.status(200).json({
    status: 'success',
    data: paginated,
    total,
    page,
    limit
  });
});

module.exports = {
  initiateKyc,
  uploadKyc,
  getallPendingKYC,
  approveRejectDocs,
  getallvendor,
  updateKycStatus,
  directUploadKyc,
  getVendorVerificationStatus,
  getVendorAllDocuments,
  checkAndAutoVerifyVendor,
  getPendingDocumentRequests
};


