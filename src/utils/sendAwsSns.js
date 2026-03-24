const { SNSClient, PublishCommand } = require('@aws-sdk/client-sns');
require('dotenv').config();

const snsClient = new SNSClient({
  region: process.env.AWS_REGION || 'us-east-2',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

const sendAwsSns = async (to, text) => {
  try {
    if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
      console.error('AWS credentials not configured for SNS SMS.');
      return null;
    }

    if (!to || !text) {
      console.error('Recipient phone number and message text are required.');
      return null;
    }

    const params = {
      Message: text,
      PhoneNumber: to,
      MessageAttributes: {
        'AWS.SNS.SMS.SenderID': {
          DataType: 'String',
          StringValue: 'GalaTab',
        },
        'AWS.SNS.SMS.SMSType': {
          DataType: 'String',
          StringValue: 'Transactional',
        },
      },
    };

    const command = new PublishCommand(params);
    const response = await snsClient.send(command);
    console.log('AWS SNS SMS sent successfully:', response.MessageId);
    return response;
  } catch (error) {
    console.error('AWS SNS SMS Error:', error.message);
    return null;
  }
};

module.exports = { sendAwsSns };
