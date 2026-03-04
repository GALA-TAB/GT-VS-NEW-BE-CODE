const mongoose = require('mongoose');

const mediaSchema = new mongoose.Schema({
  url: { type: String, required: true },
  type: { type: String, enum: ['image', 'video'], required: true },
  key: { type: String, required: true },
  thumbnail: { type: String, trim: true },
  cover: {
    type: Boolean,
    default: false
  }
});

const ServiceListingSchema = new mongoose.Schema(
  {
    serviceTypeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ServiceCategory'
    },
    vendorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },
    eventTypes: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'EventType'
      }
    ],
    instantBookingCheck: {
      type: Boolean,
      default: false
      
    },
    title: {
      type: String,

      trim: true
    },
    generatedTitle: {
      type: String,
      trim: true
    },
    description: {
      type: String,

      minlength: 3,
      maxlength: 500,
      trim: true
    },
    spaceTitle: {
      type: String,
      trim: true
    },
    media: [mediaSchema],
    venuesAmenities: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Category'
      }
    ],
    location: {
      type: {
        type: String,
        enum: ['Point'],
        default: 'Point'
      },
      coordinates: {
        type: [Number], // [longitude, latitude]
        default: [0, 0] // <-- Set your default coordinates here
      },
      address: {
        type: String,

        trim: true
      },
      city: {
        type: String,
        trim: true
      },
      country: {
        type: String,
        trim: true
      },
      state: {
        type: String,
        trim: true
      },
      neighborhood: {
        type: String,
        trim: true
      },
      postalCode: {
        type: String,
        trim: true
      },
      longitude: {
        type: Number
      },
      latitude: {
        type: Number
      },
      radius: {
        type: Number,
        default: 10 // Default radius in kilometers
      }
    },
    eventAllowed: {
      type: Boolean,
      default: false
    },
    drugsAllowed: {
      type: Boolean,
      default: false
    },
    photography: {
      type: Boolean,
      default: false
    },
    checkInTime: {
      type: String,
      trim: true
    },
    checkOutTime: {
      type: String,
      trim: true
    },
    maxGuests: {
      type: Number,
      min: 1
    },
    additionalInfo: {
      type: String,
      trim: true
    },
    serviceDays: [
      {
        day: {
          type: String,
          enum: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'],
          trim: true
        },
        startTime: {
          type: String,
          trim: true
        },
        endTime: {
          type: String,
          trim: true
        },
        price: {
          type: Number
        }
      }
    ],
    pricingModel: {
      type: String,
      enum: ['hourly', 'daily'],
      trim: true
    },
    offDayPricing: {
      type: Boolean,
      default: false
    },
    timeOf: {
      type: String,
      enum: ['AM', 'PM'],
      trim: true
    },
    servicePrice: [
      {
        name: {
          type: String
        },
        price: {
          type: Number,
          required: true
        },
        description:{
           type: String, 
          trim: true
        }
      }
    ],
    TimePerHour: {
      type: Boolean,
      default: false
    },
    keyword: {
      type: String,
      trim: true
    },
    VerificationStatus: {
      type: String,
      trim: true,
      enum: ['verified', 'notVerified', 'pending'],
      default: 'pending'
    },
    isDeleted: {
      type: Boolean,
      default: false
    },
    status: {
      type: String,
      trim: true,
      enum: ['Available', 'Booked', 'InProgress', 'Active', 'Inactive'],
      default: 'Available'
    },
    cancellationPolicy: {
      type: String,
      trim: true
    },
    completed: {
      type: Boolean,
      default: false
    },
    likedBy: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
      }
    ],
    durationUnit: {
      type: String,
      enum: ['days', 'minutes', 'hours'],
      default: 'hours'
    },
    minimumDuration: {
      type: Number
    },
    filters: [
      {
        filterId: {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'Filter'
        },
        value: {
          type: Number,
          default: 0
        }
      }
    ],
    bufferTime: {
      type: Number,
      default: 0 // in minutes
    },
    bufferTimeUnit: {
      type: String,
      enum: ['minutes', 'hours'],
      default: 'minutes'
    }
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
    virtuals: true
  }
);
ServiceListingSchema.pre('findOneAndUpdate', function (next) {
  const update = this.getUpdate();

  // Handle location updates with coordinate conversion
  if (update?.location) {
    console.log('Update location data:', update.location);
    
    let lat, lng, radius;
    
    // Handle case where latitude and longitude are provided
    if (update.location.latitude !== undefined && update.location.longitude !== undefined) {
      lat = parseFloat(update.location.latitude);
      lng = parseFloat(update.location.longitude);
      radius = parseFloat(update.location.radius) || 0;
    }
    // Handle case where coordinates array is provided but might contain strings
    else if (update.location.coordinates && Array.isArray(update.location.coordinates)) {
      lng = parseFloat(update.location.coordinates[0]);
      lat = parseFloat(update.location.coordinates[1]);
      radius = parseFloat(update.location.radius) || 0;
    }

    // If we have valid coordinates, ensure they are properly formatted
    if (!isNaN(lat) && !isNaN(lng)) {
      // Ensure coordinates are valid numbers
      if (isFinite(lat) && isFinite(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) {
        update.location = {
          ...update.location,
          type: 'Point',
          coordinates: [lng, lat], // GeoJSON requires [lng, lat] as numbers
          longitude: lng,
          latitude: lat,
          radius: radius
        };
        console.log('Converted coordinates:', update.location.coordinates);
      } else {
        console.error('Invalid coordinates detected:', { lat, lng });
        return next(new Error('Invalid coordinates provided'));
      }
    }
  }

  next();
});

ServiceListingSchema.pre('save', function (next) {
  // Handle location coordinates conversion for save operations
  if (this.location) {
    let lat, lng, radius;
    
    // Handle case where latitude and longitude are provided
    if (this.location.latitude !== undefined && this.location.longitude !== undefined) {
      lat = parseFloat(this.location.latitude);
      lng = parseFloat(this.location.longitude);
      radius = parseFloat(this.location.radius) || 0;
    }
    // Handle case where coordinates array is provided but might contain strings
    else if (this.location.coordinates && Array.isArray(this.location.coordinates)) {
      lng = parseFloat(this.location.coordinates[0]);
      lat = parseFloat(this.location.coordinates[1]);
      radius = parseFloat(this.location.radius) || 0;
    }

    // If we have valid coordinates, ensure they are properly formatted
    if (!isNaN(lat) && !isNaN(lng)) {
      // Ensure coordinates are valid numbers
      if (isFinite(lat) && isFinite(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) {
        this.location = {
          ...this.location,
          type: 'Point',
          coordinates: [lng, lat], // GeoJSON requires [lng, lat] as numbers
          longitude: lng,
          latitude: lat,
          radius: radius
        };
      } else {
        console.error('Invalid coordinates detected:', { lat, lng });
        return next(new Error('Invalid coordinates provided'));
      }
    }
  }

  next();
});

// Handle other update operations
ServiceListingSchema.pre(['updateOne', 'updateMany'], function (next) {
  const update = this.getUpdate();

  if (update?.location) {
    let lat, lng, radius;
    
    if (update.location.latitude !== undefined && update.location.longitude !== undefined) {
      lat = parseFloat(update.location.latitude);
      lng = parseFloat(update.location.longitude);
      radius = parseFloat(update.location.radius) || 0;
    } else if (update.location.coordinates && Array.isArray(update.location.coordinates)) {
      lng = parseFloat(update.location.coordinates[0]);
      lat = parseFloat(update.location.coordinates[1]);
      radius = parseFloat(update.location.radius) || 0;
    }

    if (!isNaN(lat) && !isNaN(lng) && isFinite(lat) && isFinite(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) {
      update.location = {
        ...update.location,
        type: 'Point',
        coordinates: [lng, lat],
        longitude: lng,
        latitude: lat,
        radius: radius
      };
    }
  }

  next();
});

// Static method to fix corrupted location data
ServiceListingSchema.statics.fixLocationData = async function() {
  try {
    const documents = await this.find({
      'location.coordinates': { $exists: true }
    });

    console.log(`Found ${documents.length} documents with location data`);
    
    for (const doc of documents) {
      if (doc.location && doc.location.coordinates) {
        const lng = parseFloat(doc.location.coordinates[0]);
        const lat = parseFloat(doc.location.coordinates[1]);
        
        if (!isNaN(lat) && !isNaN(lng) && isFinite(lat) && isFinite(lng)) {
          // Update without triggering middleware to avoid recursion
          await this.updateOne(
            { _id: doc._id },
            {
              $set: {
                'location.coordinates': [lng, lat],
                'location.longitude': lng,
                'location.latitude': lat,
                'location.type': 'Point'
              }
            },
            { strict: false }
          );
          console.log(`Fixed coordinates for document ${doc._id}`);
        }
      }
    }
    console.log('Location data fix completed');
  } catch (error) {
    console.error('Error fixing location data:', error);
  }
};

ServiceListingSchema.index({ location: '2dsphere' });
ServiceListingSchema.virtual('totalPrice').get(function () {
  if (!Array.isArray(this.servicePrice)) return 0;
  return this.servicePrice.reduce((sum, item) => sum + (item.price || 0), 0);
});
ServiceListingSchema.virtual('faqs', {
  ref: 'Faq', // The model to use
  localField: '_id', // Find FAQs where `serviceId` === `ServiceListing._id`
  foreignField: 'serviceId' // The field in the Faq model
});
module.exports = mongoose.model('ServiceListing', ServiceListingSchema);
