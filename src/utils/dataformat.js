const servicelistingFormat = [
  {
    $lookup: {
      from: 'users',
      localField: 'vendorId',
      foreignField: '_id',
      as: 'vendorId'
    }
  },
  {
    $unwind: {
      path: '$vendorId'
    }
  },
  {
    $lookup: {
      from: 'countries',
      localField: 'vendorId.country',
      foreignField: '_id',
      as: 'vendorCountry'
    }
  },
  {
    $unwind: {
      path: '$vendorCountry',
      preserveNullAndEmptyArrays: true
    }
  },
  {
    $lookup: {
      from: 'kycdocuments',
      localField: 'vendorId._id',
      foreignField: 'userId',
      as: 'kycDocument'
    }
  },
  {
    $unwind: {
      path: '$kycDocument',
      preserveNullAndEmptyArrays: true
    }
  },
  {
    $lookup: {
      from: 'servicecategories',
      localField: 'serviceTypeId',
      foreignField: '_id',
      as: 'serviceTypeId'
    }
  },
  {
    $lookup: {
      from: 'bookings',
      localField: '_id',
      foreignField: 'service',
      as: 'bookings'
    }
  },
  {
    $addFields: {
      bookingIds: {
        $map: {
          input: '$bookings',
          as: 'booking',
          in: '$$booking._id'
        }
      }
    }
  },
  {
    $addFields: {
      totalBookings: {
        $size: {
          $filter: {
            input: '$bookings',
            as: 'booking',
            cond: {
              $and: [{ $eq: ['$$booking.status', 'completed'] }]
            }
          }
        }
      }
    }
  },
  {
    $addFields: {
      bookingIds: {
        $map: {
          input: '$bookings',
          as: 'booking',
          in: '$$booking._id'
        }
      }
    }
  },
  {
    $lookup: {
      from: 'reviews',
      let: { vendorId: '$vendorId._id', bookingIds: '$bookingIds' },
      pipeline: [
        {
          $match: {
            $expr: {
              $and: [
                { $ne: ['$reviewer', '$$vendorId'] },
                { $in: ['$reviewOn', '$$bookingIds'] },
                { $eq: ['$isDeleted', false] },    
                { $eq: ['$hide', false] }
              ]
            }
          }
        }
      ],
      as: 'reviews'
    }
  },
  {
    $lookup: {
      from: 'bookings',
      let: { vendorId: '$vendorId._id' },
      pipeline: [
        {
          $lookup: {
            from: 'servicelistings',
            localField: 'service',
            foreignField: '_id',
            as: 'serviceInfo'
          }
        },
        {
          $unwind: '$serviceInfo'
        },
        {
          $match: {
            $expr: {
              $and: [
                { $eq: ['$serviceInfo.vendorId', '$$vendorId'] },
                { $ne: ['$bookingResponseTime', null] },
                { $ne: ['$status', 'pending'] }
              ]
            }
          }
        },
        {
          $addFields: {
            responseTimeMinutes: {
              $divide: [{ $subtract: ['$bookingResponseTime', '$createdAt'] }, 1000 * 60]
            }
          }
        }
      ],
      as: 'vendorAllBookings'
    }
  },
  {
    $lookup: {
      from: 'chats',
      let: { vendorId: '$vendorId._id' },
      pipeline: [
        {
          $match: {
            $expr: {
              $in: ['$$vendorId', '$participants']
            }
          }
        },
        {
          $lookup: {
            from: 'messages',
            localField: '_id',
            foreignField: 'chat',
            as: 'messages'
          }
        },
        {
          $unwind: '$messages'
        },
        {
          $sort: { 'messages.createdAt': 1 }
        },
        {
          $group: {
            _id: '$_id',
            participants: { $first: '$participants' },
            messages: { $push: '$messages' }
          }
        },
        {
          $addFields: {
            chatResponseTimes: {
              $reduce: {
                input: { $range: [1, { $size: '$messages' }] },
                initialValue: [],
                in: {
                  $let: {
                    vars: {
                      currentMsg: { $arrayElemAt: ['$messages', '$$this'] },
                      prevMsg: { $arrayElemAt: ['$messages', { $subtract: ['$$this', 1] }] }
                    },
                    in: {
                      $cond: [
                        {
                          $and: [
                            { $eq: ['$$currentMsg.sender', '$$vendorId'] },
                            { $ne: ['$$prevMsg.sender', '$$vendorId'] }
                          ]
                        },
                        {
                          $concatArrays: [
                            '$$value',
                            [
                              {
                                responseTimeMinutes: {
                                  $divide: [
                                    {
                                      $subtract: ['$$currentMsg.createdAt', '$$prevMsg.createdAt']
                                    },
                                    1000 * 60
                                  ]
                                }
                              }
                            ]
                          ]
                        },
                        '$$value'
                      ]
                    }
                  }
                }
              }
            }
          }
        }
      ],
      as: 'vendorChats'
    }
  },
  {
    $addFields: {
      rating: {
        $avg: {
          $map: {
            input: '$reviews',
            as: 'review',
            in: { $ifNull: ['$$review.rating', 0] }
          }
        }
      },
      avgResponseTimeMinutes: {
        $cond: [
          { $gt: [{ $size: '$vendorAllBookings' }, 0] },
          { $avg: '$vendorAllBookings.responseTimeMinutes' },
          null
        ]
      },
      avgChatResponseTimeMinutes: {
        $let: {
          vars: {
            allChatResponseTimes: {
              $reduce: {
                input: '$vendorChats',
                initialValue: [],
                in: {
                  $concatArrays: ['$$value', '$$this.chatResponseTimes']
                }
              }
            }
          },
          in: {
            $cond: [
              { $gt: [{ $size: '$$allChatResponseTimes' }, 0] },
              {
                $avg: {
                  $map: {
                    input: '$$allChatResponseTimes',
                    as: 'response',
                    in: '$$response.responseTimeMinutes'
                  }
                }
              },
              null
            ]
          }
        }
      }
    }
  },

  {
    $addFields: {
      totalPrice: {
        $sum: {
          $map: {
            input: '$servicePrice',
            as: 'service',
            in: '$$service.price'
          }
        }
      }
    }
  },
  {
    $unwind: {
      path: '$serviceTypeId',
      preserveNullAndEmptyArrays: true
    }
  },
  {
    $lookup: {
      from: 'eventtypes',
      localField: 'eventTypes',
      foreignField: '_id',
      as: 'eventTypes'
    }
  },
  {
    $lookup: {
      from: 'payouts',
      localField: '_id',
      foreignField: 'bookingId',
      as: 'payout',
      pipeline: [
        {
          $match: { status: 'Refunded' }
        }
      ]
    }
  },
  {
    $unwind: {
      path: '$payout',
      preserveNullAndEmptyArrays: true
    }
  },
  { $sort: { createdAt: -1 } },
  {
    $project: {
      title: 1,
      location: 1,
      media: 1,
      totalPrice: 1,
      serviceDays: 1,
      maxGuests: 1,
      payout: 1,
      vendorId: {
        _id: '$vendorId._id',
        firstName: '$vendorId.firstName',
        lastName: '$vendorId.lastName',
        companyName: '$vendorId.companyName',
        profilePicture: '$vendorId.profilePicture',
        email: '$vendorId.email',
        contact: '$vendorId.contact',
        countryCode: '$vendorId.countryCode',
        officeContact: '$vendorId.officeContact',
        country: { $ifNull: ['$vendorCountry.country', ''] },
        state: '$vendorId.state',
        city: '$vendorId.city',
        mailingAddress: '$vendorId.address.mailingAddress',
        textForumStatus: '$vendorId.textForumStatus',
        badgeStatus: {
          $cond: [
            {
              $and: [
                { $eq: ['$vendorId.emailVerified', true] }, 
                { $eq: ['$vendorId.contactVerified', true] },
                { $eq: ['$kycDocument.status', 'approved'] },
                { $eq: ['$vendorId.textForumStatus', 'approved'] }
              ]
            },
            'approved', // ✅ all checks passed
            null // ❌ otherwise
          ]
        }
      },
      serviceTypeId: {
        _id: '$serviceTypeId._id',
        name: '$serviceTypeId.name',
        
      },
      likedBy: 1,
      status: 1,
      completed: 1,
      rating: { $ifNull: ['$rating', 0] },
      avgResponseTimeMinutes: { $ifNull: ['$avgResponseTimeMinutes', null] },
      avgChatResponseTimeMinutes: { $ifNull: ['$avgChatResponseTimeMinutes', null] },
      isDeleted: 1,
      VerificationStatus: 1,
      totalBookings: { $ifNull: ['$totalBookings', 0] },
      createdAt: 1,
      filters: 1,
      total: 1,
      addOnServices: 1,
      eventTypes: 1,
      sumofserviceDayPrice: 1,
      minServiceDayPrice: 1,
      bufferTimeUnit: 1,
      bufferTime: 1
    }
  }
];

const bookingformat = [
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
      from: 'users',
      localField: 'user',
      foreignField: '_id',
      as: 'user'
    }
  },
  { $unwind: { path: '$user', preserveNullAndEmptyArrays: true } },
  {
    $lookup: {
      from: 'reviews',
      let: { reviewOn: '$_id', vendorId: '$vendor._id' },
      pipeline: [
        {
          $match: {
            $expr: {
              $and: [
                { $eq: ['$reviewer', '$$vendorId'] },
                { $eq: ['$reviewOn', '$$reviewOn'] },
                { $eq: ['$isDeleted', false] }
              ]
            }
          }
        }
      ],
      as: 'reviewByVendor'
    }
  },
  { $unwind: { path: '$reviewByVendor', preserveNullAndEmptyArrays: true } },
  {
    $lookup: {
      from: 'reviews',
      let: { reviewOn: '$_id', userId: '$user._id' },
      pipeline: [
        {
          $match: {
            $expr: {
              $and: [
                { $eq: ['$reviewer', '$$userId'] },
                { $eq: ['$reviewOn', '$$reviewOn'] },
                { $eq: ['$isDeleted', false] }
              ]
            }
          }
        }
      ],
      as: 'reviewByUser'
    }
  },
  { $unwind: { path: '$reviewByUser', preserveNullAndEmptyArrays: true } },
  {
    $lookup: {
      from: 'payouts',
      localField: '_id',
      foreignField: 'bookingId',
      as: 'payout',
      pipeline: [
        { $match: { status: 'Refunded' } },
        {
          $project: { _id: 0, status: 1, totalAmount: 1, refundType: 1 }
        }
      ]
    }
  },
  { $unwind: { path: '$payout', preserveNullAndEmptyArrays: true } },
  {
    $lookup: {
      from: 'bookings',
      localField: 'service._id',
      foreignField: 'service',
      as: 'allbookings'
    }
  },
  {
    $lookup: {
      from: 'reviews',
      let: {
        refs: '$allbookings', // array of booking objects
        vendorId: '$user._id' // vendorId from parent
      },
      pipeline: [
        {
          $match: {
            $expr: {
              $and: [
                {
                  $in: [
                    '$reviewOn', // this is the booking ID in Review schema
                    {
                      $map: {
                        input: '$$refs',
                        as: 'r',
                        in: '$$r._id'
                      }
                    }
                  ]
                },
                { $eq: ['$reviewer', '$$vendorId'] },
                { $eq: ['$isDeleted', false] } // match the vendor ID
              ]
            }
          }
        }
      ],
      as: 'bookingsDetails'
    }
  },
  {
    $lookup: {
      from: 'extensionbookings',
      localField: '_id',
      foreignField: 'bookingId',
      as: 'extensionrequest',
      pipeline: [{ $match: { request: 'pending' } }]
    }
  },
  {
    $unwind: { path: '$extensionrequest', preserveNullAndEmptyArrays: true }
  },
  {
    $addFields: {
      averageRating: {
        $avg: { $map: { input: '$bookingsDetails', as: 'booking', in: '$$booking.rating' } }
      },
      reviewCount: { $size: { $ifNull: ['$bookingsDetails', []] } }
    }
  },
  {
    $project: {
      'service._id': 1,
      'service.title': 1,
      'service.media': 1,
      'service.description': 1,
      'service.vendorId': 1,
      'service.serviceTypeId': 1,
      'service.location': 1,
      'vendor.profilePicture': 1,
      'vendor.email': 1,
      'vendor.firstName': 1,
      'vendor.lastName': 1,
      'vendor.fullName': {
        $concat: [
          { $ifNull: ['$vendor.firstName', ''] },
          ' ',
          { $ifNull: ['$vendor.lastName', ''] }
        ]
      },
      'vendor._id': 1,
      'user.email': 1,
      'user.profilePicture': 1,
      'user._id': 1,
      'user.fullName': {
        $concat: [{ $ifNull: ['$user.firstName', ''] }, ' ', { $ifNull: ['$user.lastName', ''] }]
      },

      checkIn: 1,
      checkOut: 1,
      guests: 1,
      totalPrice: 1,
      status: 1,
      message: 1,
      paymentStatus: 1,
      averageRating: 1,
      reviewCount: 1,
      reviewByUser: 1,
      reviewByVendor: 1,
      cancellationPolicy: 1,
      payout: 1,
      cancelRequest: 1,
      cancelReason: 1,
      extensionrequest: 1,
      addOnServices: '$servicePrice'
    }
  }
];
const vendorResponseTimeQuery = [
  {
    $lookup: {
      from: 'users',
      localField: 'vendorId',
      foreignField: '_id',
      as: 'vendor'
    }
  },
  { $unwind: { path: '$vendor', preserveNullAndEmptyArrays: true } },

  // 📌 Booking response time
  {
    $lookup: {
      from: 'bookings',
      let: { vendorId: '$vendor._id' },
      pipeline: [
        {
          $lookup: {
            from: 'servicelistings',
            localField: 'service',
            foreignField: '_id',
            as: 'serviceInfo'
          }
        },
        { $unwind: { path: '$serviceInfo', preserveNullAndEmptyArrays: true } },
        {
          $match: {
            $expr: {
              $and: [
                { $eq: ['$serviceInfo.vendorId', '$$vendorId'] },
                { $ne: ['$bookingResponseTime', null] },
                { $ne: ['$status', 'pending'] }
              ]
            }
          }
        },
        {
          $addFields: {
            responseTimeMinutes: {
              $divide: [{ $subtract: ['$bookingResponseTime', '$createdAt'] }, 1000 * 60]
            }
          }
        }
      ],
      as: 'vendorAllBookings'
    }
  },

  // 📌 Chat response time
  {
    $lookup: {
      from: 'chats',
      let: { vendorId: '$vendor._id' },
      pipeline: [
        {
          $match: {
            $expr: { $in: ['$$vendorId', '$participants'] }
          }
        },
        {
          $lookup: {
            from: 'messages',
            localField: '_id',
            foreignField: 'chat',
            as: 'messages'
          }
        },
        { $unwind: '$messages' },
        { $sort: { 'messages.createdAt': 1 } },
        {
          $group: {
            _id: '$_id',
            messages: { $push: '$messages' }
          }
        },
        {
          $addFields: {
            chatResponseTimes: {
              $reduce: {
                input: { $range: [1, { $size: '$messages' }] },
                initialValue: [],
                in: {
                  $let: {
                    vars: {
                      currentMsg: { $arrayElemAt: ['$messages', '$$this'] },
                      prevMsg: { $arrayElemAt: ['$messages', { $subtract: ['$$this', 1] }] }
                    },
                    in: {
                      $cond: [
                        {
                          $and: [
                            { $eq: ['$$currentMsg.sender', '$$vendorId'] },
                            { $ne: ['$$prevMsg.sender', '$$vendorId'] }
                          ]
                        },
                        {
                          $concatArrays: [
                            '$$value',
                            [
                              {
                                responseTimeMinutes: {
                                  $divide: [
                                    {
                                      $subtract: ['$$currentMsg.createdAt', '$$prevMsg.createdAt']
                                    },
                                    1000 * 60
                                  ]
                                }
                              }
                            ]
                          ]
                        },
                        '$$value'
                      ]
                    }
                  }
                }
              }
            }
          }
        }
      ],
      as: 'vendorChats'
    }
  },

  // 📌 Final averages
  {
    $addFields: {
      avgResponseTimeMinutes: {
        $cond: [
          { $gt: [{ $size: '$vendorAllBookings' }, 0] },
          { $avg: '$vendorAllBookings.responseTimeMinutes' },
          null
        ]
      },
      avgChatResponseTimeMinutes: {
        $let: {
          vars: {
            allChatResponseTimes: {
              $reduce: {
                input: '$vendorChats',
                initialValue: [],
                in: { $concatArrays: ['$$value', '$$this.chatResponseTimes'] }
              }
            }
          },
          in: {
            $cond: [
              { $gt: [{ $size: '$$allChatResponseTimes' }, 0] },
              {
                $avg: {
                  $map: {
                    input: '$$allChatResponseTimes',
                    as: 'response',
                    in: '$$response.responseTimeMinutes'
                  }
                }
              },
              null
            ]
          }
        }
      }
    }
  },

  // 📌 Only return what you need
  {
    $project: {
      _id: 1,
      title: 1,
      vendor: {
        _id: 1,
        firstName: 1,
        lastName: 1,
        email: 1
      },
      avgResponseTimeMinutes: 1,
      avgChatResponseTimeMinutes: 1
    }
  }
];

module.exports = {
  servicelistingFormat,
  bookingformat,
  vendorResponseTimeQuery
};
