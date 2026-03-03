const Joi = require('joi');
const { roles } = require('../types');

const registerUserSchema = Joi.object({
  providers: Joi.array()
    .items(Joi.string().valid('local', 'google', 'facebook'))
    .min(1)
    .required()
    .messages({
      'array.min': 'At least one provider is required.',
      'any.required': 'Provider is required.',
      'any.only': 'Invalid provider type.'
    }),
  email: Joi.string()
    .email()
    .when('provider', {
      is: 'local',
      then: Joi.required(),
      otherwise: Joi.optional()
    })
    .messages({
      'string.email': 'Email must be a valid email.',
      'any.required': 'Email is required.'
    }),

  password: Joi.string()
    .min(6)
    .when('provider', {
      is: 'local',
      then: Joi.required(),
      otherwise: Joi.optional()
    })
    .messages({
      'string.min': 'Password must be at least 6 characters long.',
      'any.required': 'Password is required.'
    }),

  firstName: Joi.string().required().messages({
    'any.required': 'First name is required.'
  }),

  lastName: Joi.string().required().messages({
    'any.required': 'Last name is required.'
  }),

  contact: Joi.string().required().messages({
    'any.required': 'Contact number is required.'
  }),

  countryCode: Joi.string().required().messages({
    'any.required': 'Country code is required.'
  }),

  countryName: Joi.string().required().messages({
    'any.required': 'Country name is required.'
  }),

  city: Joi.string().required().messages({
    'any.required': 'city is required.'
  }),

  state: Joi.string().optional().allow(''),

  country: Joi.string().pattern(/^[0-9a-fA-F]{24}$/).required().messages({
    'any.required': 'country is required.'
  }),

  role: Joi.string().valid(roles.ADMIN, roles.VENDOR, roles.CUSTOMER).required().messages({
    'any.required': 'Role is required.',
    'any.only': 'Invalid user type.'
  }),

  googleId: Joi.string()
    .when('provider', {
      is: 'google',
      then: Joi.required(),
      otherwise: Joi.optional()
    })
    .messages({
      'any.required': 'Google ID is required for Google login.'
    }),

  facebookId: Joi.string()
    .when('provider', {
      is: 'facebook',
      then: Joi.required(),
      otherwise: Joi.optional()
    })
    .messages({
      'any.required': 'Facebook ID is required for Facebook login.'
    })
});



const validateUserProfile = (data, options = { partial: false }) => {
  const schema = Joi.object({
    firstName: Joi.string()
      .trim()
      .min(2)
      .max(50)
      .allow('')
      .when('$partial', { is: false, then: Joi.required() }),
    lastName: Joi.string()
      .trim()
      .min(2)
      .max(50)
      .allow('')
      .when('$partial', { is: false, then: Joi.required() }),

    // Contact Information
    contact: Joi.string()
      .allow('')
      .when('$partial', { is: false, then: Joi.required() })
      .messages({
        'any.required': 'Contact number is required'
      }),
    city: Joi.string()
      .allow('')
      .when('$partial', { is: false, then: Joi.required() })
      .messages({
        'any.required': 'city is required.'
      }),

    state: Joi.string()
      .allow('')
      .optional(),

    country: Joi.string()
      .pattern(/^[0-9a-fA-F]{24}$/)
      .allow('')
      .when('$partial', { is: false, then: Joi.required() })
      .messages({
        'any.required': 'country is required.'
      }),
  

    countryCode: Joi.string()
      .allow('')
      .when('contact', {
        is: Joi.string().min(1),
        then: Joi.string()
          .pattern(/^\+\d{1,4}$/)
          .required()
      })
      .messages({
        'string.pattern.base': 'Invalid country code format',
        'any.required': 'Country code is required when providing contact number'
      }),

     companyName: Joi.string()
      .trim()
      .min(2)
      .max(100)
      .allow('')
      .when('$partial', { is: false, then: Joi.required() }),
      profilePicture: Joi.string()
      .trim()
      .allow('')
      .when('$partial', { is: false, then: Joi.required() }),
      globalPreferences: Joi.object({
        preferredLanguage: Joi.string()
          .allow('')
          .when('$partial', { is: false, then: Joi.required() })
          .messages({
            'any.only': 'Invalid preferred language',
            'any.required': 'preferredLanguage is required'
          }),
        preferredCurrency: Joi.string()
          .allow('')
          .when('$partial', { is: false, then: Joi.required() })
          .messages({
            'any.only': 'Invalid preferred currency',
            'any.required': 'preferredCurrency is required'
          }),
        timeZone: Joi.string()
          .allow('')
          .when('$partial', { is: false, then: Joi.required() })
          .messages({
            'any.only': 'Invalid time zone',
            'any.required': 'timeZone is required'
          }),
        calendarStartOfWeek: Joi.string()
          .valid('sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday')
          .allow('')
          .when('$partial', { is: false, then: Joi.required() })
          .messages({
            'any.only': 'Invalid start of week',
            'any.required': 'calendarStartOfWeek is required'
          })
      }),
      
    address: Joi.object({
      mailingAddress: Joi.string()
        .trim()
        .min(5)
        .max(255)
        .allow('')
        .when('$partial', { is: false, then: Joi.required() })
        .messages({
          'string.empty': 'address.mailingAddress is required',
          'any.required': 'address.mailingAddress is required'
        })
      
    }).when('$partial', { is: false, then: Joi.required() })
  }).options({ allowUnknown: true });

  return schema.validate(data, {
    context: { partial: options.partial }
  });
};
module.exports = { registerUserSchema, validateUserProfile };
