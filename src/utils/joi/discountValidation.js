const Joi = require('joi');

exports.discountValidation = Joi.object({
  discountId: Joi.string(),
  discountName: Joi.string(),
  discountType: Joi.string().valid('Percentage', 'Fixed'),
  serviceListingId: Joi.string().allow(null, ''),
  startDate: Joi.date(),
  endDate: Joi.date(),
  percentage: Joi.number(),
  maxDiscount: Joi.number(),
  minAmountInCart: Joi.number(),
  maxTotalUsage: Joi.number(),
  discountCode: Joi.string(),
  status: Joi.string().valid('Active', 'Inactive')
});
