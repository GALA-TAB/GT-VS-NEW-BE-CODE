const Joi = require('joi');

const serviceAddressSchema = Joi.object({
    street: Joi.string().trim().messages({
        'string.base': 'Street address must be a string.',
        'any.required': 'Street address is required.'
    }),
    city: Joi.string().trim().messages({
        'string.base': 'City must be a string.',
        'any.required': 'City is required.'
    }),
    state: Joi.string().trim().messages({
        'string.base': 'State must be a string.',
        'any.required': 'State is required.'
    }),
    postalCode: Joi.string().trim().messages({
        'string.base': 'ZIP code must be a string.',
        'any.required': 'ZIP code is required.'
    }),
    country: Joi.string().trim().messages({
        'string.base': 'Country must be a string.',
        'any.required': 'Country is required.'
    }),
    formattedAddress: Joi.string().trim().optional().messages({
        'string.base': 'Formatted address must be a string.'
    })
});

const locationSchema = Joi.object({
    address: Joi.string().trim().messages({
        'any.required': 'Address is required.',
        'string.base': 'Address must be a string.'
    }),
    city: Joi.string().trim().messages({
        'string.base': 'city must be a string.'
    }),
    country: Joi.string().trim().messages({

        'string.base': 'country must be a string.'
    }),
    state: Joi.string().trim().messages({

        'string.base': 'state must be a string.'
    }),
    neighborhood: Joi.string().trim().optional().allow('').messages({
        'string.base': 'neighborhood must be a string.'
    }),
    postalCode: Joi.string().trim().optional().messages({

        'string.base': 'state must be a string.'
    }),
    longitude: Joi.number().messages({
        'any.required': 'Longitude is required.',
        'number.base': 'Longitude must be a number.'
    }),
    latitude: Joi.number().messages({
        'any.required': 'Latitude is required.',
        'number.base': 'Latitude must be a number.'
    })
});

const serviceupdateSchema = Joi.object({
    serviceTypeId: Joi.string().trim().messages({
        "string.pattern.base": "serviceTypeId must be a valid MongoDB ObjectId.",
        "any.required": "serviceTypeId is required."
    }),
    instantBookingCheck: Joi.boolean().messages({
        "boolean.base": "instantBookingCheck must be a boolean."
    }),
    title: Joi.string().trim().min(3).max(50).messages({
        "any.required": "Title is required.",
        "string.min": "Title must be at least 3 characters long.",
        "string.max": "Title must be at most 50 characters long."
    }),
    description: Joi.string().trim().min(3).max(500).messages({
        "any.required": "Description is required.",
        "string.base": "Description must be a string.",
        "string.min": "Description must be at least 3 characters long.",
        "string.max": "Description must be at most 500 characters long."
    }),
    filters: Joi.array().min(1).items(
        Joi.object({
            filterId: Joi.string().trim().pattern(/^[0-9a-fA-F]{24}$/).messages({
                "string.pattern.base": "Filter ID must be a valid MongoDB ObjectId."
            }),
            value: Joi.number().messages({
                "number.base": "Filter value must be a number."
            })
        })
    ),
    media: Joi.array().min(1).items(
        Joi.object({
            url: Joi.string().trim().messages({
                "any.required": "Media URL is required."
            }),
            key: Joi.string().trim().messages({
                "any.required": "key is required.",
                "string.base": "key must be a string."
            }),
            type: Joi.string().valid("image", "video").messages({
                "any.only": "Invalid media type.",
                "any.required": "Media type is required.",
                "string.base": "type must be a string"
            }),
            thumbnail: Joi.string().optional(),
            cover: Joi.boolean().messages({
                "boolean.base": "cover must be a boolean."
            })
        })
    ).messages({
        "array.min": "At least one media is required."
    }),
    location: locationSchema,
    eventAllowed: Joi.boolean().messages({
        "boolean.base": "eventAllowed must be a boolean.",
        "any.required": "Event allowed is required."
    }),
    drugsAllowed: Joi.boolean().messages({
        "boolean.base": "eventAllowed must be a boolean.",
        "any.required": "Event allowed is required."
    }),
    photography: Joi.boolean().messages({
        "boolean.base": "photography must be a boolean.",
        "any.required": "photography is required."
    }),
    TimePerHour: Joi.boolean().messages({
        "boolean.base": "TimePerHour must be a boolean.",
        "any.required": "TimePerHour is required."
    }),
    maxGuests: Joi.number().integer().min(1).messages({
        "any.required": "Event allowed is required.",
        "number.integer": "Max guests must be an integer.",
        "number.min": "Max guests must be at least 1."
    }),
    additionalInfo: Joi.string().trim().messages({
        "string.base": "Check-in time must be a string.",
        "any.required": "Event allowed is required."
    }),
    keyword: Joi.string().trim().messages({
        "string.base": "Check-in time must be a string.",
        "any.required": "Event allowed is required."
    }),
    serviceDays: Joi.array().min(1).items(
        Joi.object({
            day: Joi.string().valid("monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday").trim().messages({
                "string.valid": "Day must be one of the following: monday, tuesday, wednesday, thursday, friday, saturday, sunday.",
                "any.required": "Day is required."
            }),
            startTime: Joi.string().messages({
                "string.pattern.base": "Start time must be in the format HH:MM in 24 hour format.",
                "any.required": "Start time is required."
            }),
            endTime: Joi.string().messages({
                "string.pattern.base": "End time must be in the format HH:MM in 24 hour format.",
                "any.required": "End time is required."
            }),
            price: Joi.number().messages(
                {
                    "number.base": "Price must be a number.",
                    "any.required": "Price is required."
                }
            )

        })
    ).messages({
        "array.min": "At least one service day is required.",
        "any.required": "Service days are required."
    }),
    pricingModel: Joi.string().valid("hourly", "daily").messages({
        "string.valid": "Pricing model must be one of the following: hourly, daily, weekly, monthly.",
        "any.required": "Pricing model is required."
    }),
    offDayPricing: Joi.boolean().messages({
        "boolean.base": "offDayPricing must be a boolean.",
        "any.required": "offDayPricing is required."
    }),

    status: Joi.string().valid("Available", "Booked", "InProgress", "Active", "Cancelled", "ActionRequiredListing").messages({
        "string.valid": "status must be string",
        "any.required": "statusis required."
    }),
    servicePrice: Joi.array().items(
        Joi.object({
            serviceId: Joi.string().trim().pattern(/^[0-9a-fA-F]{24}$/).messages({
                "string.pattern.base": "Service ID must be a valid MongoDB ObjectId."
            }),
            price: Joi.number().min(0).messages({
                "number.min": "Price must be at least 0.",
                "any.required": "Price is required."
            })
        })
    ),
    cancellationPolicy: Joi.string().messages({
        "string.base": "Cancellation policy must be a string.",
        "any.required": "Cancellation policy is required."
    }),
    durationUnit: Joi.string().valid("days", "minutes", "hours").default("hours").messages({
        "string.valid": "Duration unit must be one of the following: days, minutes, hours.",
        "any.required": "Duration unit is required."
    }),
    eventTypes: Joi.array().items(
        Joi.string().trim().pattern(/^[0-9a-fA-F]{24}$/).messages({
            "string.pattern.base": "Event Type ID must be a valid MongoDB ObjectId."
        })
    ).messages({
        "array.base": "Event Types must be an array.",
        "any.required": "Event Types are required."
    }),
    bufferTime: Joi.number().min(0).messages({
        "number.base": "Buffer time must be a number.",
        "number.min": "Buffer time cannot be negative."
    }),
    bufferTimeUnit: Joi.string().valid("minutes", "hours").default("minutes").messages({
        "string.valid": "Buffer time unit must be one of the following: minutes, hours.",
        "any.required": "Buffer time unit is required."
    }),
    serviceAddress: serviceAddressSchema,
    customAmenities: Joi.array().items(
        Joi.string().trim().max(100).messages({
            "string.max": "Each custom amenity must be at most 100 characters."
        })
    ).messages({
        "array.base": "Custom amenities must be an array."
    })

});


module.exports = { serviceupdateSchema };
