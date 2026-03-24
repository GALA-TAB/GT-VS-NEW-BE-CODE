const twilio = require('twilio');
require('dotenv').config();
const AppError = require('./appError');
const { sendAwsSns } = require('./sendAwsSns');

const sendTwilioSms = async (to, text) => {
  try {
    // Try AWS SNS first
    const snsResponse = await sendAwsSns(to, text);
    if (snsResponse) {
      console.log('SMS sent via AWS SNS');
      return snsResponse;
    }

    // Fallback: try Twilio SMS
    if (
      process.env.TWILLIO_ACCOUNT_ID &&
      process.env.TWILLIO_AUTH_TOKEN &&
      process.env.TWILLIO_PHONE_NUMBER
    ) {
      const client = twilio(process.env.TWILLIO_ACCOUNT_ID, process.env.TWILLIO_AUTH_TOKEN);
      const smsResponse = await client.messages.create({
        body: text,
        from: process.env.TWILLIO_PHONE_NUMBER,
        to
      });
      console.log('SMS sent via Twilio');
      return smsResponse;
    }

    console.error('No SMS provider available (AWS SNS and Twilio both failed)');
    return null;
  } catch (error) {
    const errorMessage = error.message || 'An unknown error occurred while sending SMS.';
    console.error('SMS Error:', errorMessage);
    return null;
  }
};


const sendOtpVoiceCall = async (phoneNumber, otpCode) => {
  try {
    if (
      !process.env.TWILLIO_ACCOUNT_ID ||
      !process.env.TWILLIO_AUTH_TOKEN ||
      !process.env.TWILLIO_PHONE_NUMBER
    ) {
      throw new AppError('Twilio environment variables missing.', 500);
    }

    if (!phoneNumber || !otpCode) {
      throw new AppError('Phone number and OTP are required.', 400);
    }

    const client = twilio(process.env.TWILLIO_ACCOUNT_ID, process.env.TWILLIO_AUTH_TOKEN);

    // Format OTP as spaced digits so it's read clearly
    const formattedOtp = otpCode.split('').join(' ');

    const twimlMessage = `<Response><Say voice="alice" language="en-US">Hello! Your verification code is ${formattedOtp}. Thank you!</Say></Response>`;

    const call = await client.calls.create({
      twiml: twimlMessage,
      to: phoneNumber,
      from: process.env.TWILLIO_PHONE_NUMBER,
    });

    return call;
  } catch (error) {
    console.error('Voice Call Error:', error.message);
    throw new AppError(`Voice call failed: ${error.message}`, error.statusCode || 500);
    return null;
  }
};

module.exports ={sendTwilioSms,sendOtpVoiceCall};



