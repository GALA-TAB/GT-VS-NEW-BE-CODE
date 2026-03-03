const phoneUtil = require('google-libphonenumber').PhoneNumberUtil.getInstance();
const { PhoneNumberFormat } = require('google-libphonenumber');

const validateAndFormatPhoneNumber = (contact, countryCode) => {
  try {
    let number;
    if (contact && contact.startsWith('+')) {
      // Already in E.164 format — parse directly without region
      number = phoneUtil.parse(contact);
    } else {
      const countryDialCode = parseInt(countryCode?.replace('+', ''), 10);
      const regionCode = phoneUtil.getRegionCodeForCountryCode(countryDialCode);
      if (!regionCode) throw new Error('Invalid country code.');
      number = phoneUtil.parseAndKeepRawInput(contact, regionCode);
    }

    if (!phoneUtil.isValidNumber(number)) {
      throw new Error(`Invalid phone number.`);
    }

    return phoneUtil.format(number, PhoneNumberFormat.E164);
  } catch (error) {
    throw new Error(error.message);
  }
};

module.exports = { validateAndFormatPhoneNumber };
