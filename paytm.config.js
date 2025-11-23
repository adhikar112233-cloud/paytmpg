// paytm.config.js
require('dotenv').config();

const isProd = process.env.PAYTM_ENVIRONMENT === 'PROD';

module.exports = {
  mid: process.env.PAYTM_MID,
  key: process.env.PAYTM_MERCHANT_KEY,
  website: process.env.PAYTM_WEBSITE,
  callbackUrl: process.env.PAYTM_CALLBACK_URL,
  industryTypeId: process.env.PAYTM_INDUSTRY_TYPE_ID || 'Retail',
  channelId: process.env.PAYTM_CHANNEL_ID || 'WEB',
  host: isProd ? 'https://securegw.paytm.in' : 'https://securegw-stage.paytm.in'
};
