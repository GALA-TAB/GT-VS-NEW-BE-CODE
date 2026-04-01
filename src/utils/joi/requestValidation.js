const Joi = require('joi');

const requestSchema = Joi.object({
    service: Joi.string().trim().pattern(/^[0-9a-fA-F]{24}$/).required().messages({
        "string.pattern.base": "serviceTypeId must be a valid MongoDB ObjectId.",
        "any.required": "serviceTypeId is required."
    }),
    paymentMethodid: Joi.string()
        .pattern(/^[a-zA-Z0-9_-]+$/)
        .required()
        .messages({
            "string.pattern.base": "Payment Method ID must be a valid format",
            "string.empty": "Payment Method ID cannot be empty.",
            "any.required": "Payment Method ID is required."
        }),
    guests: Joi.number().integer().min(1).required().messages({
        "any.required": "Guests is required.",
        "number.integer": "Guests must be an integer.",
        "number.min": "Guests must be at least 1."
    }),
    checkIn: Joi.date().greater('now').required().messages({
        "any.required": "Check-in time is required."
    }),

    checkOut: Joi.date().greater('now').required().messages({

        "any.required": "Check-out date is required."
    }),
    message: Joi.string().trim().optional().messages({
        "string.base": "message must be string",
        "any.required": " message is optional."
    }),
    totalPrice: Joi.number().min(0).required().messages({
        "number.min": "Total price must be at least 0.",
        "any.required": "Total price is required."
    }),
    eventType: Joi.string().trim().optional().allow('', null).messages({
        "string.base": "Event type must be a string."
    }),
    guestsOfHonor: Joi.array().items(Joi.string().trim()).optional().messages({
        "array.base": "Guests of honor must be an array of names."
    })

});

module.exports = { requestSchema };
