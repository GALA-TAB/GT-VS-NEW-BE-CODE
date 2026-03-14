const Joi = require('joi');
const moment = require('moment-timezone');
const AppError = require('../utils/appError');
const catchAsync = require('../utils/catchAsync');
const { deleteMedia } = require('../middlewares/aws-v3');
const ServiceListing = require('../models/ServiceListing');
const { serviceupdateSchema } = require('../utils/joi/serviceValidation');
const mongoose = require('mongoose');
const joiError = require('../utils/joiError');
const sendNotification = require('../utils/storeNotification');
const { servicelistingFormat, vendorResponseTimeQuery } = require('../utils/dataformat');
const {
  createStripeOnBoardingLink,
  createStripeExpressAccount,
  receiveAccount
} = require('../utils/stripe-utils/connect-accounts.util');
const Email = require('../utils/email');
const User = require('../models/users/User');
const { normalizeIsDeleted, withSoftDeleteFilter } = require('../utils/softDeleteFilter');
const createLog = require('../utils/createLog');
const { generateTitleForListing } = require('../utils/generateListingTitle');
const { moderateText, detectCompanyName } = require('../utils/mediaModeration');

const getDateRange = (filter) => {
  const now = moment.utc();
  let start;
  let end;

  switch (filter) {
    case 'today':
      start = now.clone().startOf('day');
      end = now.clone().endOf('day');
      break;

    case 'lastWeek':
      start = now.clone().subtract(1, 'weeks').startOf('week');
      end = now.clone().subtract(1, 'weeks').endOf('week');
      break;

    case 'thisWeek':
      start = now.clone().startOf('week');
      end = now.clone().endOf('week');
      break;

    case 'lastMonth':
      start = now.clone().subtract(1, 'months').startOf('month');
      end = now.clone().subtract(1, 'months').endOf('month');
      break;

    case 'nextMonth':
      start = now.clone().add(1, 'months').startOf('month');
      end = now.clone().add(1, 'months').endOf('month');
      break;

    default:
      return null;
  }
  return { start, end };
};

const getfilterquery = (params) => {
  const {
    keyword,
    selectedDate,
    checkOutTime,
    checkInTime,
    guests,
    guestMax,
    serviceTypeId,
    city,
    state,
    country,
    longitude,
    latitude,
    filterIDs,
    filtervalues,
    ids,
    serviceTypeIds,
    isDeleted = false,
    eventTypeId,
    status,
    dateFilter,
    minPrice,
    maxPrice,
    startDate,
    endDate
  } = params;

  const normalizedIsDeleted = normalizeIsDeleted(isDeleted);
  const matchStage = {};

  // Convert ids to ObjectId(s)
  if (ids) {
    if (Array.isArray(ids)) {
      matchStage.venuesAmenities = {
        $in: ids.map((id) => new mongoose.Types.ObjectId(id))
      };
    } else if (ids) {
      matchStage.venuesAmenities = new mongoose.Types.ObjectId(ids);
    }
  }

  if (dateFilter) {
    const range = getDateRange(dateFilter);
    if (range) {
      matchStage.createdAt = { $gte: range.start, $lte: range.end };
    }
  }

  if (filterIDs && filtervalues && Array.isArray(filterIDs) && Array.isArray(filtervalues)) {
    if (filterIDs.length === filtervalues.length) {
      matchStage.$or = filterIDs.map((id, index) => ({
        filters: {
          $elemMatch: {
            filterId: new mongoose.Types.ObjectId(id),
            value: { $gte: Number(filtervalues[index]) } // ← using $gte here
          }
        }
      }));
    } else {
      throw new Error('filterIDs and filtervalues arrays must be the same length');
    }
  } else if (filterIDs && filtervalues) {
    matchStage.filters = {
      $elemMatch: {
        filterId: new mongoose.Types.ObjectId(filterIDs),
        value: { $gte: Number(filtervalues) }
      }
    };
  }

  if (serviceTypeId) {
    matchStage.serviceTypeId = new mongoose.Types.ObjectId(serviceTypeId);
  }
  if (serviceTypeIds && serviceTypeIds?.length) {
    if (Array.isArray(serviceTypeIds)) {
      matchStage.serviceTypeId = {
        $in: serviceTypeIds.map((id) => new mongoose.Types.ObjectId(id))
      };
    } else {
      matchStage.serviceTypeId = new mongoose.Types.ObjectId(serviceTypeIds);
    }
  }
  if (status && status?.length) {
    if (Array.isArray(status)) {
      matchStage.status = { $in: status };
    } else {
      matchStage.status = status;
    }
  }

  if (selectedDate) {
    const start = moment.utc(selectedDate).startOf('day');
    const end = moment.utc(selectedDate).endOf('day');
    matchStage.createdAt = { $gte: start.toDate(), $lte: end.toDate() };
  }

  if (guests) {
    matchStage.maxGuests = { $gte: Number(guests) };
    if (guestMax && Number(guestMax) > Number(guests)) {
      matchStage.maxGuests.$lte = Number(guestMax);
    }
  }

  if (checkInTime && checkOutTime) {
    matchStage.serviceDays = {
      $elemMatch: {
        startTime: { $lte: checkInTime },
        endTime: { $gte: checkOutTime }
      }
    };
  }

  if (minPrice && maxPrice && !startDate && !endDate) {
    matchStage.minServiceDayPrice = { $gte: Number(minPrice), $lte: Number(maxPrice) };
  } else if (minPrice && !startDate && !endDate) {
    matchStage.minServiceDayPrice = { $gte: Number(minPrice) };
  } else if (maxPrice && !startDate && !endDate) {
    matchStage.minServiceDayPrice = { $lte: Number(maxPrice) };
  }

  if (keyword) {
    const regex = new RegExp(keyword, 'i');
    matchStage.$or = [
      { keyword: { $regex: regex } },
      { title: { $regex: regex } },
      { generatedTitle: { $regex: regex } },
      { description: { $regex: regex } },
      { spaceTitle: { $regex: regex } },
      { 'eventTypeData.name': { $regex: regex } },
      { 'serviceTypeData.name': { $regex: regex } },
      { 'location.address': { $regex: regex } },
      { 'location.city': { $regex: regex } },
      { 'location.state': { $regex: regex } },
      { 'location.country': { $regex: regex } },
      { 'location.neighborhood': { $regex: regex } },
      { 'serviceAddress.street': { $regex: regex } },
      { 'serviceAddress.city': { $regex: regex } },
      { 'serviceAddress.state': { $regex: regex } },
      { 'serviceAddress.country': { $regex: regex } },
      { additionalInfo: { $regex: regex } },
      { cancellationPolicy: { $regex: regex } },
      { 'vendordata.firstName': { $regex: regex } },
      { 'vendordata.lastName': { $regex: regex } },
      { 'vendordata.email': { $regex: regex } },
      { 'vendordata.contact': { $regex: regex } },
      { 'vendordata.companyName': { $regex: regex } },
      {
        $expr: {
          $regexMatch: {
            input: {
              $concat: [
                { $ifNull: ['$vendordata.firstName', ''] },
                ' ',
                { $ifNull: ['$vendordata.lastName', ''] }
              ]
            },
            regex: keyword,
            options: 'i'
          }
        }
      }
    ];
  }

  if (city) {
    matchStage['location.city'] = city;
  }

  if (state) {
    matchStage['location.state'] = state;
  }

  if (country) {
    matchStage['location.country'] = country;
  }
  if (eventTypeId) {
    matchStage.eventTypes = {
      $elemMatch: {
        $eq: new mongoose.Types.ObjectId(eventTypeId)
      }
    };
  }

  // Geospatial filter
  const radiusInMeters = 5000;
  const earthRadiusInMeters = 6378137;

  if (longitude && latitude) {
    matchStage.location = {
      $geoWithin: {
        $centerSphere: [
          [parseFloat(longitude), parseFloat(latitude)],
          radiusInMeters / earthRadiusInMeters
        ]
      }
    };
  }

  const finalMatchStage = withSoftDeleteFilter(matchStage, normalizedIsDeleted);

  console.log('matchStage', finalMatchStage);

  return finalMatchStage;
};

const filterForServiceAvailabilities = (params) => {
  const { startDate, endDate, minPrice, maxPrice } = params;
  console.log('filterForServiceAvailabilities', minPrice, maxPrice);
  const query = [];

  if (startDate && endDate) {
    const start = moment.utc(startDate).startOf('day').toDate();
    const end = moment.utc(endDate).endOf('day').toDate();
    const daysDiff = moment.utc(end).diff(moment.utc(start), 'days');

    query.push(
      // 1️⃣ Lookup bookings
      {
        $lookup: {
          from: 'bookings',
          let: { start, end, serviceId: '$_id' },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: ['$service', '$$serviceId'] },
                    { $in: ['$status', ['pending', 'booked']] },
                    { $lt: ['$checkIn', '$$end'] },
                    { $gt: ['$checkOut', '$$start'] }
                  ]
                }
              }
            }
          ],
          as: 'bookings'
        }
      },

      // 2️⃣ Lookup calendars
      {
        $lookup: {
          from: 'calendars',
          let: { start, end, serviceId: '$_id' },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: ['$serviceId', '$$serviceId'] },
                    { $lt: ['$startDate', '$$end'] },
                    { $gt: ['$endDate', '$$start'] }
                  ]
                }
              }
            }
          ],
          as: 'availabilities'
        }
      },

      // 3️⃣ Filter only available (no bookings + no calendar blocks)
      {
        $match: {
          $expr: {
            $and: [
              { $eq: [{ $size: { $ifNull: ['$bookings', []] } }, 0] },
              { $eq: [{ $size: { $ifNull: ['$availabilities', []] } }, 0] }
            ]
          }
        }
      }
    );

    if (minPrice || maxPrice) {
      query.push(
        // 4️⃣ Add start and end dates as fields and generate list of days
        {
          $addFields: {
            startDate: start,
            endDate: end,
            days: {
              $map: {
                input: { $range: [0, { $add: [daysDiff, 1] }, 1] }, // include last day
                as: 'offset',
                in: {
                  $dateAdd: { startDate: start, unit: 'day', amount: '$$offset' }
                }
              }
            }
          }
        },

        // 5️⃣ Calculate priceFromDays (hourly/daily)
        {
          $addFields: {
            priceFromDays: {
              $sum: {
                $map: {
                  input: '$days',
                  as: 'd',
                  in: {
                    $let: {
                      vars: {
                        dayName: {
                          $arrayElemAt: [
                            [
                              'sunday',
                              'monday',
                              'tuesday',
                              'wednesday',
                              'thursday',
                              'friday',
                              'saturday'
                            ],
                            { $subtract: [{ $dayOfWeek: '$$d' }, 1] }
                          ]
                        }
                      },
                      in: {
                        $let: {
                          vars: {
                            matchedDay: {
                              $first: {
                                $filter: {
                                  input: { $ifNull: ['$serviceDays', []] },
                                  cond: { $eq: ['$$this.day', '$$dayName'] }
                                }
                              }
                            }
                          },
                          in: {
                            $cond: [
                              { $not: ['$$matchedDay'] }, // no matching day
                              0,
                              {
                                $cond: [
                                  { $eq: ['$pricingModel', 'hourly'] },
                                  {
                                    $multiply: [
                                      {
                                        $divide: [
                                          {
                                            $dateDiff: {
                                              startDate: {
                                                $dateFromString: {
                                                  dateString: {
                                                    $concat: [
                                                      {
                                                        $dateToString: {
                                                          format: '%Y-%m-%d',
                                                          date: '$$d'
                                                        }
                                                      },
                                                      'T',
                                                      '$$matchedDay.startTime'
                                                    ]
                                                  },
                                                  format: '%Y-%m-%dT%H:%M'
                                                }
                                              },
                                              endDate: {
                                                $dateFromString: {
                                                  dateString: {
                                                    $concat: [
                                                      {
                                                        $dateToString: {
                                                          format: '%Y-%m-%d',
                                                          date: '$$d'
                                                        }
                                                      },
                                                      'T',
                                                      '$$matchedDay.endTime'
                                                    ]
                                                  },
                                                  format: '%Y-%m-%dT%H:%M'
                                                }
                                              },
                                              unit: 'minute'
                                            }
                                          },
                                          60
                                        ]
                                      },
                                      { $toDouble: '$$matchedDay.price' }
                                    ]
                                  },
                                  { $toDouble: '$$matchedDay.price' } // daily
                                ]
                              }
                            ]
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        },

        // 6️⃣ Add addon price
        {
          $addFields: {
            addOnPrice: {
              $sum: {
                $map: {
                  input: { $ifNull: ['$addOnServices', []] },
                  as: 'a',
                  in: { $toDouble: '$$a.price' }
                }
              }
            }
          }
        },

        // 7️⃣ Total price
        {
          $addFields: {
            total: { $add: ['$priceFromDays', '$addOnPrice'] }
          }
        },

        // 8️⃣ Filter by price range
        {
          $match: {
            $expr: {
              $and: [
                minPrice ? { $gte: ['$total', Number(minPrice)] } : { $literal: true },
                maxPrice ? { $lte: ['$total', Number(maxPrice)] } : { $literal: true },
                { $ne: ['$total', 0] }
              ]
            }
          }
        }
      );
    }
  }

  return query;
};

const filterForServiceCreatedAt = (params) => {
  const { startDate, endDate } = params;
  const query = [];

  if (startDate && endDate) {
    const start = moment.utc(startDate).startOf('day').toDate();
    const end = moment.utc(endDate).endOf('day').toDate();

    query.push(
      // Filter by createdAt date range
      {
        $match: {
          createdAt: {
            $gte: start,
            $lte: end
          }
        }
      }
    );
  } else if (startDate) {
    const start = moment.utc(startDate).startOf('day').toDate();
    const end = moment.utc(startDate).endOf('day').toDate();

    query.push({
      $match: {
        createdAt: {
          $gte: start,
          $lte: end
        }
      }
    });
  } else if (endDate) {
    const end = moment.utc(endDate).endOf('day').toDate();

    query.push({
      $match: {
        createdAt: {
          $lte: end
        }
      }
    });
  }

  return query;
};

const createServiceListing = catchAsync(async (req, res, next) => {
  let vendorId = req.user._id;

  const { serviceTypeId, instantBookingCheck, userId } = req.body;
  if (req.user.role === 'admin') {
    if (!userId) {
      return next(
        new AppError('Please provide userId', 400, {
          userId: 'userId is required'
        })
      );
    }
    vendorId = userId;
  } else {
    vendorId = req.user._id;
  }

  // if (!user.stripeAccountId) {
  //   const accountId = await createStripeExpressAccount({
  //     email: user.email,
  //     country: user.countryName || 'US',
  //     userId: user._id
  //   });
  //   user.stripeAccountId = accountId;
  //   await user.save();
  //   const onboardingLink = await createStripeOnBoardingLink({
  //     accountId: user.stripeAccountId
  //   });

  //   const email = new Email(user.email, user.firstName);
  //   const message = `Hello ${user.firstName},<br><br>Your Stripe account is not ready for payouts. Please complete the onboarding process by clicking the link below:<br><br><a href="${onboardingLink}">${onboardingLink}</a><br><br>Thank you!`;
  //   await email.sendHtmlEmail('Stripe Account Onboarding', message, {
  //     link: onboardingLink
  //   });
  //   return next(
  //     new AppError(
  //       'Vendor has no Stripe account linked. Please complete it before creating a Service Listing',
  //       400
  //     )
  //   );
  // }

  // const account = await receiveAccount(user.stripeAccountId);

  // if (!account?.charges_enabled || !account.payouts_enabled) {
  //   const onboardingLink = await createStripeOnBoardingLink({
  //     accountId: user.stripeAccountId
  //   });

  //   const email = new Email(user.email, user.firstName);
  //   const message = `Hello ${user.firstName},<br><br>Your Stripe account is not ready for payouts. Please complete the onboarding process by clicking the link below before creating the booking:<br><br><a href="${onboardingLink}">${onboardingLink}</a><br><br>Thank you!`;
  //   await email.sendHtmlEmail('Stripe Account Onboarding', message, {
  //     link: onboardingLink
  //   });
  //   return next(new AppError('Vendor Stripe account is not ready for payouts.', 404));
  // }

  if (!serviceTypeId) {
    return next(
      new AppError('Please provide serviceTypeId', 400, {
        serviceTypeId: 'serviceTypeId is required'
      })
    );
  }
  const serviceListing = await ServiceListing.create({
    serviceTypeId,
    vendorId,
    instantBookingCheck,
    ...(Array.isArray(req.body.customAmenities) && { customAmenities: req.body.customAmenities })
  });
  res.locals.dataId = serviceListing._id;

  // Log service creation
  createLog({
    actorId: req.user._id,
    actorModel: req.user.role === 'admin' ? 'admin' : 'vendor',
    action: 'CREATE_SERVICE',
    description: `Created new service listing (ID: ${serviceListing._id})`,
    target: 'ServiceListing',
    targetId: serviceListing._id,
    ipAddress: req.ip || req.headers['x-forwarded-for'],
  });

  return res.status(200).json({
    status: 'success',
    data: serviceListing,
    message: 'Service listing created successfully'
  });
});

const updateServiceListing = catchAsync(async (req, res, next) => {
  const currentUserId = req.user._id;
  const serviceListingId = req.params.id;

  if (!serviceListingId) {
    return next(
      new AppError('serviceListingId not found', 400, {
        serviceListingId: 'Service Listing Id not found'
      })
    );
  }

  // Find the listing first so we know the actual vendor who owns it
  const query = {
    _id: new mongoose.Types.ObjectId(serviceListingId)
  };

  if (req.user.role === 'vendor') {
    query.vendorId = currentUserId;
  }

  console.log('query', query);

  const findingServiceListing = await ServiceListing.findOne(query);

  if (!findingServiceListing) {
    return next(new AppError('No service listing found with this ID.', 404));
  }

  // Use the listing's vendorId (not req.user._id) for moderation
  // so that when admin edits, we still check the actual vendor's name
  const actualVendorId = findingServiceListing.vendorId;

  // Look up vendor's names for moderation (companyName + fullName)
  const vendor = await User.findById(actualVendorId)
    .select('companyName firstName lastName email').lean();
  console.log('[updateServiceListing] vendor lookup', actualVendorId,
    '=> companyName:', JSON.stringify(vendor?.companyName),
    'firstName:', JSON.stringify(vendor?.firstName),
    'lastName:', JSON.stringify(vendor?.lastName),
    'email:', JSON.stringify(vendor?.email));
  const companyName = vendor?.companyName || '';
  const vendorFullName = [vendor?.firstName, vendor?.lastName].filter(Boolean).join(' ');
  const vendorNames = [companyName, vendorFullName].filter(Boolean);
  console.log('[updateServiceListing] namesToBlock =', JSON.stringify(vendorNames));

  // ── Text content moderation ──
  const modOpts = { companyName, vendorNames: vendorFullName ? [vendorFullName] : [] };
  const textFields = ['title', 'description', 'additionalInfo', 'spaceTitle', 'keyword', 'cancellationPolicy'];
  for (const field of textFields) {
    if (req.body[field]) {
      const { approved, reasons } = moderateText(req.body[field], modOpts);
      if (!approved) {
        return next(new AppError(
          `The ${field} contains prohibited content: ${reasons[0]}`,
          400,
          { field, reasons, detectedWords: vendorNames }
        ));
      }
    }
  }

  // ── Service Address moderation ──
  // serviceAddress contains real venue/location data — address fields are
  // expected to contain streets, cities, etc. so address-pattern detection
  // is skipped. Only phone/email/social/link/payment checks apply here.
  // (Full moderation still runs on description, title, amenities, etc.)

  // Auto-populate serviceAddress from location if serviceAddress is not explicitly provided
  if (!req.body.serviceAddress && req.body.location) {
    const loc = req.body.location;
    if (loc.address) {
      req.body.serviceAddress = {
        street: loc.address,
        city: loc.city || '',
        state: loc.state || '',
        postalCode: loc.postalCode || '',
        country: loc.country || '',
        formattedAddress: [loc.address, loc.city, loc.state, loc.country, loc.postalCode].filter(Boolean).join(', ')
      };
    }
  }

  // Check custom amenities (array of strings)
  if (Array.isArray(req.body.customAmenities)) {
    for (const amenity of req.body.customAmenities) {
      if (amenity && typeof amenity === 'string') {
        const { approved, reasons } = moderateText(amenity, modOpts);
        if (!approved) {
          return next(new AppError(
            `A custom amenity contains prohibited content: ${reasons[0]}`,
            400,
            { field: 'customAmenities', reasons, detectedWords: vendorNames }
          ));
        }
      }
    }
  }

  // Check add-on services (servicePrice) name and description
  if (Array.isArray(req.body.servicePrice)) {
    for (let i = 0; i < req.body.servicePrice.length; i++) {
      const addon = req.body.servicePrice[i];
      if (addon.name && typeof addon.name === 'string') {
        const { approved, reasons } = moderateText(addon.name, modOpts);
        if (!approved) {
          return next(new AppError(
            `Add-on service #${i + 1} name contains prohibited content: ${reasons[0]}`,
            400,
            { field: `servicePrice[${i}].name`, reasons, detectedWords: vendorNames }
          ));
        }
      }
      if (addon.description && typeof addon.description === 'string') {
        const { approved, reasons } = moderateText(addon.description, modOpts);
        if (!approved) {
          return next(new AppError(
            `Add-on service #${i + 1} description contains prohibited content: ${reasons[0]}`,
            400,
            { field: `servicePrice[${i}].description`, reasons, detectedWords: vendorNames }
          ));
        }
      }
    }
  }

  const { error } = serviceupdateSchema.validate(req.body, {
    allowUnknown: true,
    abortEarly: false
  });

  if (error) {
    const errorFields = joiError(error);

    return next(new AppError('Invalid request', 400, { errorFields }));
  }

  // TITLE LOCK: strip title/generatedTitle from the update body.
  // The model-level pre-hook provides an additional DB-layer guard.
  delete req.body.title;
  delete req.body.generatedTitle;

  const updatedFields = {
    ...JSON.parse(JSON.stringify(findingServiceListing.toObject())),
    ...req.body
  };

  // Ensure title/generatedTitle are absent from the $set payload.
  delete updatedFields.title;
  delete updatedFields.generatedTitle;
  delete updatedFields._id;

  // Note: 'title' is NOT in this list — it is auto-generated from the listing
  // detection template (style descriptor + service type + neighborhood) and must
  // not be required from the vendor.
  const partialSchema = serviceupdateSchema.fork(
    ['serviceDays', 'additionalInfo', 'TimePerHour', 'location', 'media', 'description'],
    (schema) => schema.required()
  );
  const { error: partialError } = partialSchema.validate(updatedFields, {
    allowUnknown: true,
    abortEarly: false
  });
  console.log('partialError', partialError);

  if (!partialError) {
    updatedFields.completed = true;
  }
  const { title, description, media } = req.body;

  if (title || description || media) {
    updatedFields.VerificationStatus = 'pending';
  }
  console.log('[updateServiceListing] req.body.customAmenities:', JSON.stringify(req.body.customAmenities));
  console.log('[updateServiceListing] updatedFields.customAmenities:', JSON.stringify(updatedFields.customAmenities));

  const serviceListing = await ServiceListing.findOneAndUpdate(query, { $set: updatedFields }, {
    new: true,
    runValidators: true
  });
  if (!serviceListing) {
    return next(new AppError('No service listing found with this ID.', 404));
  }

  // Explicitly save customAmenities using direct MongoDB operation (bypasses Mongoose hooks)
  if (Array.isArray(req.body.customAmenities)) {
    await ServiceListing.collection.updateOne(
      { _id: serviceListing._id },
      { $set: { customAmenities: req.body.customAmenities } }
    );
    serviceListing.customAmenities = req.body.customAmenities;
    console.log('[updateServiceListing] Direct-saved customAmenities:', JSON.stringify(req.body.customAmenities));
  }
  console.log('[updateServiceListing] FINAL customAmenities:', JSON.stringify(serviceListing.customAmenities));

  // ── Title: first-time generation only ───────────────────────────
  // Only runs when the listing had NO title before this save.
  // The model pre-hook prevents any future update from changing the title.
  if (
    !findingServiceListing.title &&
    serviceListing.completed &&
    (serviceListing.location?.neighborhood || serviceListing.location?.city)
  ) {
    try {
      const populatedListing = await ServiceListing.findById(serviceListing._id)
        .populate('serviceTypeId', 'name');
      const genTitle = await generateTitleForListing(populatedListing);
      if (genTitle) {
        // The pre-hook allows this because the doc has no title yet.
        await ServiceListing.updateOne(
          { _id: serviceListing._id },
          { $set: { title: genTitle, generatedTitle: genTitle, VerificationStatus: 'pending' } }
        );
        serviceListing.title = genTitle;
        serviceListing.generatedTitle = genTitle;
        serviceListing.VerificationStatus = 'pending';
      }
    } catch (e) {
      console.error('Auto title generation failed:', e.message);
    }
  }

  res.locals.dataId = serviceListing._id;
  return res.status(200).json({
    status: 'success',
    data: serviceListing,
    message: 'Service listing updated ,successfully'
  });
});

const updateServiceDetail = catchAsync(async (req, res, next) => {
  const currentUserId = req.user._id;
  const serviceListingId = req.params.id;

  if (!serviceListingId) {
    return next(
      new AppError('serviceListingId not found', 400, {
        serviceListingId: 'Service Listing Id not found'
      })
    );
  }

  // Find the listing first so we know the actual vendor who owns it
  const detailQuery = { _id: serviceListingId };
  if (req.user.role === 'vendor') {
    detailQuery.vendorId = currentUserId;
  }
  const existingListing = await ServiceListing.findOne(detailQuery).lean();
  if (!existingListing) {
    return next(new AppError('No service listing found with this ID.', 404));
  }

  // TITLE LOCK: strip title/generatedTitle so the main update never touches them.
  // The model-level pre-hook is the DB-layer enforcer for all future saves.
  delete req.body.title;
  delete req.body.generatedTitle;

  // Use the listing's vendorId (not req.user._id) for moderation
  const actualVendorId = existingListing.vendorId;

  const {
    title,
    description,
    serviceTypeId,
    instantBookingCheck,
    spaceTitle,
    media,
    venuesAmenities,
    location,
    additionalInfo,
    checkOutTime,
    checkInTime,
    maxGuests,
    drugsAllowed,
    eventAllowed,
    servicePrice,
    timeOf,
    serviceDays,
    status,
    keyword,
    TimePerHour,
    photography,
    serviceAddress
  } = req.body;

  // ── Text content moderation ──
  const vendorForMod = await User.findById(actualVendorId)
    .select('companyName firstName lastName email').lean();
  console.log('[updateServiceDetail] vendor lookup', actualVendorId,
    '=> companyName:', JSON.stringify(vendorForMod?.companyName),
    'firstName:', JSON.stringify(vendorForMod?.firstName),
    'lastName:', JSON.stringify(vendorForMod?.lastName),
    'email:', JSON.stringify(vendorForMod?.email));
  const vendorCompanyName = vendorForMod?.companyName || '';
  const vendorFullName2 = [vendorForMod?.firstName, vendorForMod?.lastName].filter(Boolean).join(' ');
  const vendorNames2 = [vendorCompanyName, vendorFullName2].filter(Boolean);
  console.log('[updateServiceDetail] namesToBlock =', JSON.stringify(vendorNames2));

  const modOpts2 = { companyName: vendorCompanyName, vendorNames: vendorFullName2 ? [vendorFullName2] : [] };
  const textToCheck = { title, description, spaceTitle, additionalInfo, keyword };
  for (const [field, value] of Object.entries(textToCheck)) {
    if (value) {
      const { approved, reasons } = moderateText(value, modOpts2);
      if (!approved) {
        return next(new AppError(
          `The ${field} contains prohibited content: ${reasons[0]}`,
          400,
          { field, reasons, detectedWords: vendorNames2 }
        ));
      }
    }
  }

  // Check cancellation policy
  if (req.body.cancellationPolicy) {
    const { approved, reasons } = moderateText(req.body.cancellationPolicy, modOpts2);
    if (!approved) {
      return next(new AppError(
        `The cancellation policy contains prohibited content: ${reasons[0]}`,
        400,
        { field: 'cancellationPolicy', reasons, detectedWords: vendorNames2 }
      ));
    }
  }

  // ── Service Address moderation ──
  // serviceAddress contains real venue/location data — address fields are
  // expected to contain streets, cities, etc. so address-pattern detection
  // is skipped here. Full moderation still runs on description, title, etc.

  // Auto-populate serviceAddress from location if not explicitly provided
  if (!req.body.serviceAddress && req.body.location) {
    const loc = req.body.location;
    if (loc.address) {
      req.body.serviceAddress = {
        street: loc.address,
        city: loc.city || '',
        state: loc.state || '',
        postalCode: loc.postalCode || '',
        country: loc.country || '',
        formattedAddress: [loc.address, loc.city, loc.state, loc.country, loc.postalCode].filter(Boolean).join(', ')
      };
    }
  }

  // Check custom amenities (array of strings)
  if (Array.isArray(req.body.customAmenities)) {
    for (const amenity of req.body.customAmenities) {
      if (amenity && typeof amenity === 'string') {
        const { approved, reasons } = moderateText(amenity, modOpts2);
        if (!approved) {
          return next(new AppError(
            `A custom amenity contains prohibited content: ${reasons[0]}`,
            400,
            { field: 'customAmenities', reasons, detectedWords: vendorNames2 }
          ));
        }
      }
    }
  }

  // Check add-on services (servicePrice) name and description
  if (Array.isArray(req.body.servicePrice)) {
    for (let i = 0; i < req.body.servicePrice.length; i++) {
      const addon = req.body.servicePrice[i];
      if (addon.name && typeof addon.name === 'string') {
        const { approved, reasons } = moderateText(addon.name, modOpts2);
        if (!approved) {
          return next(new AppError(
            `Add-on service #${i + 1} name contains prohibited content: ${reasons[0]}`,
            400,
            { field: `servicePrice[${i}].name`, reasons, detectedWords: vendorNames2 }
          ));
        }
      }
      if (addon.description && typeof addon.description === 'string') {
        const { approved, reasons } = moderateText(addon.description, modOpts2);
        if (!approved) {
          return next(new AppError(
            `Add-on service #${i + 1} description contains prohibited content: ${reasons[0]}`,
            400,
            { field: `servicePrice[${i}].description`, reasons, detectedWords: vendorNames2 }
          ));
        }
      }
    }
  }

  let validationSchema = Joi.object().min(1);
  const validationData = {};

  const fieldsToValidate = {
    title,
    description,
    serviceTypeId,
    instantBookingCheck,
    spaceTitle,
    media,
    venuesAmenities,
    location,
    additionalInfo,
    checkOutTime,
    checkInTime,
    maxGuests,
    drugsAllowed,
    eventAllowed,
    servicePrice,
    timeOf,
    serviceDays,
    status,
    TimePerHour,
    keyword,
    photography,
    serviceAddress
  };

  Object.keys(fieldsToValidate).forEach((key) => {
    if (fieldsToValidate[key] !== undefined) {
      validationSchema = validationSchema.concat(
        Joi.object({
          [key]: serviceupdateSchema.extract(key)
        })
      );
      validationData[key] = fieldsToValidate[key];
    }
  });

  const { error } = validationSchema.validate(validationData, {
    allowUnknown: true,
    abortEarly: false
  });

  if (error) {
    const errorFields = joiError(error);
    return next(new AppError('Invalid request', 400, { errorFields }));
  }

  const serviceListing = await ServiceListing.findOneAndUpdate(
    detailQuery,
    { $set: req.body },
    {
      new: true,
      runValidators: true
    }
  );

  if (!serviceListing) {
    return next(new AppError('No service listing found with this ID.', 404));
  }

  // ── Title: first-time generation only ───────────────────────────
  // Only runs when the listing had NO title before this save.
  // The model pre-hook prevents any future update from changing the title.
  if (
    !existingListing.title &&
    (serviceListing.location?.neighborhood || serviceListing.location?.city)
  ) {
    try {
      const populatedListing = await ServiceListing.findById(serviceListing._id)
        .populate('serviceTypeId', 'name');
      const genTitle = await generateTitleForListing(populatedListing);
      if (genTitle) {
        await ServiceListing.updateOne(
          { _id: serviceListing._id },
          { $set: { title: genTitle, generatedTitle: genTitle, VerificationStatus: 'pending' } }
        );
        serviceListing.title = genTitle;
        serviceListing.generatedTitle = genTitle;
        serviceListing.VerificationStatus = 'pending';
      }
    } catch (e) {
      console.error('Auto title generation failed:', e.message);
    }
  }

  res.locals.dataId = serviceListing._id;

  return res.status(200).json({
    status: 'success',
    data: serviceListing,
    message: 'Service listing updated successfully'
  });
});

const deleteServiceListing = catchAsync(async (req, res, next) => {
  if (!req.params.id) {
    return next(new AppError('Please provide service listing id', 400));
  }
  const serviceListing = await ServiceListing.findOneAndUpdate(
    { _id: req.params.id },
    { isDeleted: true },
    { new: true }
  );
  if (!serviceListing) {
    return next(new AppError('No service listing found with this Document ID and User Id', 404));
  }
  serviceListing.media.forEach(async (media) => {
    if (!media?.key) {
      return;
    }
    await deleteMedia(media?.key);
  });
  res.locals.dataId = serviceListing._id;

  // Log service deletion
  createLog({
    actorId: req.user._id,
    actorModel: req.user.role === 'admin' ? 'admin' : 'vendor',
    action: 'DELETE_SERVICE',
    description: `Deleted service listing (ID: ${serviceListing._id}) titled "${serviceListing.title || 'Untitled'}"`,
    target: 'ServiceListing',
    targetId: serviceListing._id,
    ipAddress: req.ip || req.headers['x-forwarded-for'],
  });

  return res.status(200).json({
    status: 'success',
    data: null,
    message: 'Service deleted successfully'
  });
});
const getAllServiceListings = catchAsync(async (req, res) => {
  const vendorId = req.user._id;
  const {
    keyword,
    page = 1,
    limit = 10,
    startDate,
    endDate,
    serviceTypeIds,
    status,
    dateFilter,
    favorite,
    search
  } = req.query;
  const isDeleted = normalizeIsDeleted(req.query.isDeleted);
  const query = { vendorId };
  if (startDate && endDate) {
    const start = moment.utc(startDate).startOf('day');
    const end = moment.utc(endDate).endOf('day');
    query.createdAt = { $gte: start.toDate(), $lte: end.toDate() };
  } else if (startDate) {
    const start = moment.utc(startDate).startOf('day');
    const end = moment.utc(startDate).endOf('day');
    query.createdAt = { $gte: start.toDate(), $lte: end.toDate() };
  } else if (endDate) {
    const start = moment.utc(endDate).startOf('day');
    const end = moment.utc(endDate).endOf('day');
    query.createdAt = { $gte: start.toDate(), $lte: end.toDate() };
  }

  if (favorite) {
    query.likedBy = { $in: [vendorId] };
  }
  if (keyword) {
    query.keyword = keyword;
  }

  if (search) {
    query.$or = [
      { title: { $regex: search, $options: 'i' } },
      { description: { $regex: search, $options: 'i' } }
    ];
  }
  if (serviceTypeIds?.length) {
    if (Array.isArray(serviceTypeIds)) {
      query.serviceTypeId = { $in: serviceTypeIds.map((id) => new mongoose.Types.ObjectId(id)) };
    } else {
      query.serviceTypeId = new mongoose.Types.ObjectId(serviceTypeIds);
    }
  }
  if (dateFilter) {
    const range = getDateRange(dateFilter);
    if (range) {
      query.createdAt = { $gte: range.start, $lte: range.end };
    }
  }
  if (Array.isArray(status) && status.length === 1) {
    query.status = { $in: status };
  } else if (status?.length) {
    query.status = status;
  }

  const finalQuery = withSoftDeleteFilter(query, isDeleted);

  const aggregation = ServiceListing.aggregate([
    { $match: finalQuery },
    ...servicelistingFormat,
    { $sort: { createdAt: -1 } },
    { $skip: (page - 1) * Number(limit) },
    { $limit: Number(limit) }
  ]);

  const serviceListings = await aggregation.exec();

  const totalCount = await ServiceListing.countDocuments(finalQuery);

  return res.status(200).json({
    status: 'success',
    results: serviceListings.length,
    totalCount,
    totalPages: Math.ceil(totalCount / limit),
    currentPage: parseInt(page, 10),
    data: serviceListings
  });
});
const getAllLikedListings = catchAsync(async (req, res) => {
  const vendorId = req.user._id;
  const {
    keyword,
    page = 1,
    limit = 10,
    startDate,
    endDate,
    serviceTypeIds,
    status,
    dateFilter,
    search
  } = req.query;
  const isDeleted = normalizeIsDeleted(req.query.isDeleted);
  const query = {
    likedBy: { $in: [vendorId] },
    status: 'Available',
    VerificationStatus: 'verified',
    completed: true
  };
  if (startDate && endDate) {
    const start = moment.utc(startDate).startOf('day');
    const end = moment.utc(endDate).endOf('day');
    query.createdAt = { $gte: start.toDate(), $lte: end.toDate() };
  } else if (startDate) {
    const start = moment.utc(startDate).startOf('day');
    const end = moment.utc(startDate).endOf('day');
    query.createdAt = { $gte: start.toDate(), $lte: end.toDate() };
  } else if (endDate) {
    const start = moment.utc(endDate).startOf('day');
    const end = moment.utc(endDate).endOf('day');
    query.createdAt = { $gte: start.toDate(), $lte: end.toDate() };
  }
  if (keyword) {
    query.keyword = keyword;
  }

  if (serviceTypeIds?.length) {
    query.serviceTypeId = { $in: serviceTypeIds };
  }

  if (dateFilter) {
    const range = getDateRange(dateFilter);
    if (range) {
      query.createdAt = { $gte: range.start, $lte: range.end };
    }
  }
  if (status?.length) {
    query.status = { $in: status };
  }

  const finalQuery = withSoftDeleteFilter(query, isDeleted);

  const pipeline = [
    { $match: finalQuery },
    {
      $lookup: {
        from: 'users',
        localField: 'vendorId',
        foreignField: '_id',
        as: 'vendordata'
      }
    },
    {
      $unwind: {
        path: '$vendordata'
      }
    },
    {
      $lookup: {
        from: 'eventtypes',
        localField: 'eventTypes',
        foreignField: '_id',
        as: 'eventTypeData'
      }
    },
    {
      $lookup: {
        from: 'servicecategories',
        localField: 'serviceTypeId',
        foreignField: '_id',
        as: 'serviceTypeData'
      }
    },
    { $unwind: { path: '$serviceTypeData', preserveNullAndEmptyArrays: true } }
  ];

  if (search) {
    const searchRegex = new RegExp(search, 'i');
    pipeline.push({
      $match: {
        $or: [
          { keyword: { $regex: searchRegex } },
          { title: { $regex: searchRegex } },
          { description: { $regex: searchRegex } },
          { spaceTitle: { $regex: searchRegex } },
          { 'eventTypeData.name': { $regex: searchRegex } },
          { 'serviceTypeData.name': { $regex: searchRegex } },
          { 'location.address': { $regex: searchRegex } },
          { 'location.city': { $regex: searchRegex } },
          { 'location.state': { $regex: searchRegex } },
          { 'location.country': { $regex: searchRegex } },
          { additionalInfo: { $regex: searchRegex } },
          { 'vendordata.firstName': { $regex: searchRegex } },
          { 'vendordata.email': { $regex: searchRegex } },
          { 'vendordata.contact': { $regex: searchRegex } },
          { 'vendordata.lastName': { $regex: searchRegex } },
          {
            $expr: {
              $regexMatch: {
                input: {
                  $concat: [
                    { $ifNull: ['$vendordata.firstName', ''] },
                    ' ',
                    { $ifNull: ['$vendordata.lastName', ''] }
                  ]
                },
                regex: search,
                options: 'i'
              }
            }
          }
        ]
      }
    });
  }

  pipeline.push(
    ...servicelistingFormat,
    { $sort: { createdAt: -1 } },
    { $skip: (page - 1) * Number(limit) },
    { $limit: Number(limit) }
  );

  const aggregation = ServiceListing.aggregate(pipeline);

  const serviceListings = await aggregation.exec();
  const totalCount = await ServiceListing.countDocuments(query);

  return res.status(200).json({
    status: 'success',
    results: serviceListings.length,
    totalCount,
    totalPages: Math.ceil(totalCount / limit),
    currentPage: parseInt(page, 10),
    data: serviceListings
  });
});
const getServiceListingsforLandingPage = catchAsync(async (req, res) => {
  const { page = 1, limit = 10 } = req.query;
  const query = getfilterquery(req.query);
  console.log('query', query);
  // console.log('query filterForServiceAvailabilities', filterForServiceAvailabilities(req.query));

  const pipeline = [
    {
      $lookup: {
        from: 'users',
        localField: 'vendorId',
        foreignField: '_id',
        as: 'vendordata'
      }
    },
    {
      $unwind: {
        path: '$vendordata'
      }
    },
    {
      $lookup: {
        from: 'eventtypes',
        localField: 'eventTypes',
        foreignField: '_id',
        as: 'eventTypeData'
      }
    },
    {
      $lookup: {
        from: 'servicecategories',
        localField: 'serviceTypeId',
        foreignField: '_id',
        as: 'serviceTypeData'
      }
    },
    {
      $addFields: {
        sumofserviceDayPrice: {
          $sum: {
            $map: {
              input: '$serviceDays',
              as: 'day',
              in: { $toDouble: '$$day.price' }
            }
          }
        },
        minServiceDayPrice: {
          $min: {
            $map: {
              input: '$serviceDays',
              as: 'day',
              in: { $toDouble: '$$day.price' }
            }
          }
        }
      }
    },
    { $unwind: { path: '$serviceTypeData', preserveNullAndEmptyArrays: true } },

    { $match: { ...query, status: 'Available', VerificationStatus: 'verified', completed: true } },
    ...filterForServiceAvailabilities(req.query),
    ...servicelistingFormat
  ];
  const serviceListings = await ServiceListing.aggregate(pipeline)
    .skip((page - 1) * parseInt(limit, 10))
    .limit(parseInt(limit, 10));
  const totalCountPipeline = [
    {
      $lookup: {
        from: 'users',
        localField: 'vendorId',
        foreignField: '_id',
        as: 'vendordata'
      }
    },
    {
      $unwind: {
        path: '$vendordata'
      }
    },
    {
      $lookup: {
        from: 'eventtypes',
        localField: 'eventTypes',
        foreignField: '_id',
        as: 'eventTypeData'
      }
    },
    {
      $lookup: {
        from: 'servicecategories',
        localField: 'serviceTypeId',
        foreignField: '_id',
        as: 'serviceTypeData'
      }
    },
    {
      $addFields: {
        sumofserviceDayPrice: {
          $sum: {
            $map: {
              input: '$serviceDays',
              as: 'day',
              in: { $toDouble: '$$day.price' }
            }
          }
        },
        minServiceDayPrice: {
          $min: {
            $map: {
              input: '$serviceDays',
              as: 'day',
              in: { $toDouble: '$$day.price' }
            }
          }
        }
      }
    },
    { $unwind: { path: '$serviceTypeData', preserveNullAndEmptyArrays: true } },
    { $match: { ...query, status: 'Available', VerificationStatus: 'verified', completed: true } },

    ...filterForServiceAvailabilities(req.query),
    {
      $group: {
        _id: null,
        totalCount: { $sum: 1 },
        minPrice: { $min: '$minServiceDayPrice' },
        maxPrice: { $max: '$minServiceDayPrice' }
      }
    }
  ];

  const totalCountResult = await ServiceListing.aggregate(totalCountPipeline);
  const totalCount = totalCountResult[0]?.totalCount || 0;
  const minPrice = totalCountResult[0]?.minPrice || 0;
  const maxPrice = totalCountResult[0]?.maxPrice || 0;

  return res.status(200).json({
    status: 'success',
    results: serviceListings.length,
    totalCount,
    minPrice: Number(req.query.minPrice) || minPrice,
    maxPrice: Number(req.query.maxPrice) || maxPrice,
    totalPages: Math.ceil(totalCount / limit),
    currentPage: parseInt(page, 10),
    data: serviceListings.map(listing => {
      // Strip private service address from public listing results.
      // serviceAddress is only revealed after booking confirmation.
      const { serviceAddress, ...rest } = listing;
      if (rest.location) {
        delete rest.location.address;
      }
      return rest;
    })
  });
});
const getAllService = catchAsync(async (req, res) => {
  const { page = 1, limit = 10 } = req.query;
  const query = getfilterquery(req.query);
  const pipeline = [
    {
      $lookup: {
        from: 'users',
        localField: 'vendorId',
        foreignField: '_id',
        as: 'vendordata'
      }
    },
    {
      $unwind: {
        path: '$vendordata'
      }
    },
    {
      $lookup: {
        from: 'eventtypes',
        localField: 'eventTypes',
        foreignField: '_id',
        as: 'eventTypeData'
      }
    },
    {
      $lookup: {
        from: 'servicecategories',
        localField: 'serviceTypeId',
        foreignField: '_id',
        as: 'serviceTypeData'
      }
    },
    { $unwind: { path: '$serviceTypeData', preserveNullAndEmptyArrays: true } },
    { $match: { ...query } },
    ...filterForServiceCreatedAt(req.query),
    ...servicelistingFormat
  ];
  const serviceListings = await ServiceListing.aggregate(pipeline)
    .skip((page - 1) * parseInt(limit, 10))
    .limit(parseInt(limit, 10));

  const totalCountPipeline = [
    {
      $lookup: {
        from: 'users',
        localField: 'vendorId',
        foreignField: '_id',
        as: 'vendordata'
      }
    },
    {
      $unwind: {
        path: '$vendordata'
      }
    },
    {
      $lookup: {
        from: 'eventtypes',
        localField: 'eventTypes',
        foreignField: '_id',
        as: 'eventTypeData'
      }
    },
    {
      $lookup: {
        from: 'servicecategories',
        localField: 'serviceTypeId',
        foreignField: '_id',
        as: 'serviceTypeData'
      }
    },
    { $unwind: { path: '$serviceTypeData', preserveNullAndEmptyArrays: true } },
    { $match: { ...query } },
    ...filterForServiceCreatedAt(req.query),
    { $count: 'totalCount' }
  ];

  const totalCountResult = await ServiceListing.aggregate(totalCountPipeline);
  const totalCount = totalCountResult[0]?.totalCount || 0;

  return res.status(200).json({
    status: 'success',
    results: serviceListings.length,
    totalCount,
    totalPages: Math.ceil(totalCount / limit),
    currentPage: parseInt(page, 10),
    data: serviceListings
  });
});

const getoverallServiceListings = catchAsync(async (req, res) => {
  const pipeline = [
    {
      $lookup: {
        from: 'users',
        localField: 'vendorId',
        foreignField: '_id',
        as: 'vendordata'
      }
    },
    {
      $unwind: {
        path: '$vendordata'
      }
    },
    {
      $lookup: {
        from: 'eventtypes',
        localField: 'eventTypes',
        foreignField: '_id',
        as: 'eventTypeData'
      }
    },
    {
      $lookup: {
        from: 'servicecategories',
        localField: 'serviceTypeId',
        foreignField: '_id',
        as: 'serviceTypeData'
      }
    },
    {
      $addFields: {
        sumofserviceDayPrice: {
          $sum: {
            $map: {
              input: '$serviceDays',
              as: 'day',
              in: { $toDouble: '$$day.price' }
            }
          }
        }
      }
    },
    { $unwind: { path: '$serviceTypeData', preserveNullAndEmptyArrays: true } },
    { $match: { status: 'Available', VerificationStatus: 'verified', completed: true } },
    ...filterForServiceAvailabilities(req.query),
    { $match: getfilterquery(req.query) },
    {
      $addFields: {
        totalPrice: {
          $sum: [
            {
              $map: {
                input: '$servicePrice',
                as: 'service',
                in: '$$service.price'
              }
            }
          ]
        }
      }
    },
    {
      $project: {
        title: 1,
        location: 1,
        media: 1,
        servicePrice: 1,
        totalPrice: 1,
        maxGuests: 1,
        serviceTypeData: {
          name: 1,
          typevalue: 1
        }
      }
    }
    
  ];
  const serviceListings = await ServiceListing.aggregate(pipeline);
  // Compute overall min/max (based on sumofserviceDayPrice) respecting the same filters
  const statsPipeline = [
    {
      $lookup: {
        from: 'users',
        localField: 'vendorId',
        foreignField: '_id',
        as: 'vendordata'
      }
    },
    { $unwind: { path: '$vendordata' } },
    {
      $lookup: {
        from: 'eventtypes',
        localField: 'eventTypes',
        foreignField: '_id',
        as: 'eventTypeData'
      }
    },
    {
      $lookup: {
        from: 'servicecategories',
        localField: 'serviceTypeId',
        foreignField: '_id',
        as: 'serviceTypeData'
      }
    },
    {
      $addFields: {
        sumofserviceDayPrice: {
          $sum: {
            $map: {
              input: '$serviceDays',
              as: 'day',
              in: { $toDouble: '$$day.price' }
            }
          }
        }
      }
    },
    { $unwind: { path: '$serviceTypeData', preserveNullAndEmptyArrays: true } },
    { $match: { status: 'Available', VerificationStatus: 'verified', completed: true } },
    ...filterForServiceAvailabilities(req.query),
    { $match: getfilterquery(req.query) },
    {
      $group: {
        _id: null,
        totalCount: { $sum: 1 },
        minPrice: { $min: '$sumofserviceDayPrice' },
        maxPrice: { $max: '$sumofserviceDayPrice' }
      }
    }
  ];

  const statsResult = await ServiceListing.aggregate(statsPipeline);
  const overallTotal = statsResult[0]?.totalCount || 0;
  const overallMin = statsResult[0]?.minPrice || 0;
  const overallMax = statsResult[0]?.maxPrice || 0;

  return res.status(200).json({
    status: 'success',
    data: serviceListings.map(listing => {
      const { serviceAddress, ...rest } = listing;
      if (rest.location) {
        delete rest.location.address;
      }
      return rest;
    }),
    totalCount: overallTotal,
    minPrice: Number(req.query.minPrice) || overallMin,
    maxPrice: Number(req.query.maxPrice) || overallMax
  });
});

const deleteServicemedia = catchAsync(async (req, res, next) => {
  const { mediaId } = req.params;
  const id = req.user._id;

  if (!mediaId) {
    return next(new AppError('Please provide media Id', 400));
  }

  const serviceListing = await ServiceListing.findOne({ vendorId: id, 'media._id': mediaId });

  if (!serviceListing) {
    return next(new AppError('No media found with this Document ID and User Id', 404));
  }
  const mediaToDelete = serviceListing.media.find((media) => media._id.toString() === mediaId);

  if (!mediaToDelete) {
    return next(new AppError('No media found with this id', 404));
  }
  const Key = mediaToDelete?.key;

  try {
    await deleteMedia(Key);
  } catch (err) {
    return next(new AppError('Error deleting media from aws', 500));
  }

  serviceListing.media = serviceListing.media.filter((media) => media._id.toString() !== mediaId);
  res.locals.dataId = serviceListing._id;
  await serviceListing.save();

  return res.status(200).json({
    status: 'success',
    data: serviceListing,
    message: 'Media deleted successfully'
  });
});

const getServiceListing = catchAsync(async (req, res, next) => {
  const { id } = req.params;

  if (!id) {
    return next(new AppError('Please provide service listing id', 400));
  }

  const serviceListing = await ServiceListing.aggregate([
    {
      $match: {
        _id: new mongoose.Types.ObjectId(id)
      }
    },
    {
      $lookup: {
        from: 'servicecategories',
        localField: 'serviceTypeId',
        foreignField: '_id',
        as: 'serviceTypeData',
        pipeline: [
          {
            $project: {
              name: 1,
              typevalue: 1
            }
          }
        ]
      }
    },
    {
      $unwind: { path: '$serviceTypeData', preserveNullAndEmptyArrays: true }
    },
    // Lookup vendor profile info
    {
      $lookup: {
        from: 'users',
        localField: 'vendorId',
        foreignField: '_id',
        as: 'vendorProfile',
        pipeline: [
          {
            $project: {
              firstName: 1,
              lastName: 1,
              companyName: 1,
              email: 1,
              contact: 1,
              countryCode: 1,
              officeContact: 1,
              officeCountryCode: 1,
              profilePicture: 1,
              country: 1,
              state: 1,
              city: 1,
              address: 1,
            }
          }
        ]
      }
    },
    {
      $unwind: { path: '$vendorProfile', preserveNullAndEmptyArrays: true }
    },
    // Resolve vendor's country ObjectId to country name
    {
      $lookup: {
        from: 'countries',
        localField: 'vendorProfile.country',
        foreignField: '_id',
        as: 'vendorCountryData',
        pipeline: [
          { $project: { country: 1 } }
        ]
      }
    },
    {
      $unwind: { path: '$vendorCountryData', preserveNullAndEmptyArrays: true }
    },
    {
      $addFields: {
        'vendorProfile.country': {
          $ifNull: ['$vendorCountryData.country', '$vendorProfile.country']
        }
      }
    },
    {
      $project: {
        vendorCountryData: 0
      }
    }
  ]);

  if (!serviceListing || serviceListing.length === 0) {
    return next(new AppError('No service listing found with this ID', 404));
  }

  const result = serviceListing[0];

  // Strip private serviceAddress from public responses.
  // Only the listing's vendor or an admin can see the full service address.
  const isOwnerOrAdmin = req.user && (
    req.user.role === 'admin' ||
    result.vendorId?.toString() === req.user._id?.toString()
  );

  if (!isOwnerOrAdmin) {
    delete result.serviceAddress;
    if (result.location) {
      delete result.location.address;
    }
  }

  return res.status(200).json({
    status: 'success',
    data: result,
    message: 'Service listing found successfully'
  });
});

const getServiceListingTitle = catchAsync(async (req, res, next) => {
  const serviceListings = await ServiceListing.find(
    { vendorId: req.user._id, completed: true, isDeleted: false },
    { title: 1, _id: 1 }
  ).lean();

  return res.status(200).json({
    status: 'success',
    data: serviceListings,
    message: 'Service listing found successfully'
  });
});

const getServiceListingLanding = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  if (!id) {
    return next(new AppError('Please provide service listing id', 400));
  }
  const serviceListing = await ServiceListing.findById(id)
    .populate('serviceTypeId')
    .populate('filters.filterId')
    // .populate({
    //   path: 'venuesAmenities', // Populate the Amenities documents
    //   model: 'Category' // The model is Amenities
    // })
    .populate('vendorId', { profilePicture: 1, email: 1, lastName: 1, firstName: 1 })
    .populate('faqs')
    .populate('eventTypes');
  const responseTime = await ServiceListing.aggregate([
    {
      $match: {
        _id: new mongoose.Types.ObjectId(id)
      }
    },
    ...vendorResponseTimeQuery
  ]);
  console.log(responseTime[0], 'well bro');
  if (!serviceListing) {
    return next(new AppError('No service listing found with this ID', 404));
  }

  // Strip private service address from public listing response.
  // serviceAddress is only revealed after booking confirmation — separate from vendor profile address.
  const listingObj = serviceListing.toObject();
  delete listingObj.serviceAddress;
  if (listingObj.location) {
    delete listingObj.location.address;
  }

  return res.status(200).json({
    status: 'success',
    data: {
      ...listingObj,
      vendorId: {
        ...serviceListing.vendorId.toObject(),
        BookingResponseTimeMinutes: responseTime[0]?.avgResponseTimeMinutes || 'N/A',
        avgChatResponseTimeMinutes: responseTime[0]?.avgChatResponseTimeMinutes || 'N/A'
      }
    },
    message: 'Service listing found successfully'
  });
});

const likeServiceListing = catchAsync(async (req, res, next) => {
  const { serviceId } = req.body;

  if (!serviceId) {
    return next(new AppError('Please provide serviceId', 400));
  }

  const serviceListing = await ServiceListing.findOneAndUpdate(
    { _id: serviceId },
    [
      {
        $set: {
          likedBy: {
            $cond: {
              if: { $in: [req.user._id, '$likedBy'] },
              then: {
                $filter: {
                  input: '$likedBy',
                  as: 'id',
                  cond: { $ne: ['$$id', req.user._id] }
                }
              },
              else: { $concatArrays: ['$likedBy', [req.user._id]] }
            }
          }
        }
      }
    ],
    { new: true }
  );
  if (!serviceListing) {
    return next(new AppError('No service listing found with this ID', 404));
  }
  res.locals.dataId = serviceListing._id;
  sendNotification({
    userId: serviceListing.vendorId,
    title: serviceListing?.likedBy?.includes(req.user._id?.toString())
      ? 'Service liked'
      : 'Service unliked',
    message: serviceListing?.likedBy?.includes(req.user._id?.toString())
      ? `A user liked your service ${serviceListing.title}`
      : `A user unliked your service listing ${serviceListing.title}`,
    type: 'serviceListing',
    fortype: 'service_like',
    permission: 'serviceManagement',
    linkUrl:"/vendor-dashboard/service-listing"
  });
  return res.status(200).json({
    status: 'success',
    data: serviceListing,
    message: serviceListing?.likedBy?.includes(req.user._id?.toString())
      ? 'Service listing liked successfully'
      : 'Service listing unliked successfully'
  });
});

const VerifyServiceListing = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const { VerificationStatus } = req.body;
  if (!VerificationStatus) {
    return next(
      new AppError('VerificationStatus is required', 400, {
        VerificationStatus: 'VerificationStatus is required'
      })
    );
  }
  const serviceListing = await ServiceListing.findByIdAndUpdate(
    id,
    { VerificationStatus },
    { new: true }
  );
  if (!serviceListing) {
    return next(new AppError('No service listing found with that ID', 404));
  }
  res.locals.dataId = serviceListing._id;
  res.status(200).json({
    status: 'success',
    data: serviceListing,
    message: 'Service listing updated successfully'
  });
});

module.exports = {
  getAllServiceListings,
  createServiceListing,
  deleteServiceListing,
  updateServiceListing,
  deleteServicemedia,
  updateServiceDetail,
  getServiceListing,
  getServiceListingsforLandingPage,
  getServiceListingLanding,
  likeServiceListing,
  getAllLikedListings,
  getServiceListingTitle,
  getoverallServiceListings,
  getAllService,
  VerifyServiceListing
};
