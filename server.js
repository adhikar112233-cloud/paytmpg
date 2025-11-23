// server.js
require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');
const PaytmChecksum = require('paytmchecksum');
const paytmConfig = require('./paytm.config');

const app = express();

app.use(cors());
app.use(bodyParser.json());
// Paytm callback HTML form POST ke liye:
app.use(bodyParser.urlencoded({ extended: false }));

// Helper: unique orderId
function generateOrderId() {
  return 'ORDER_' + Date.now() + '_' + Math.floor(Math.random() * 1000);
}

/**
 * 1) CREATE ORDER + INITIATE TRANSACTION
 * front-end yeh route call karega jab user "Pay Now" click kare
 * body: { amount, customerId }
 */
app.post('/api/paytm/create-order', async (req, res) => {
  try {
    const { amount, customerId } = req.body;

    if (!amount || !customerId) {
      return res.status(400).json({ error: 'amount and customerId required' });
    }

    const orderId = generateOrderId();

    // Paytm Init Txn body
    const body = {
      requestType: 'Payment',
      mid: paytmConfig.mid,
      websiteName: paytmConfig.website,
      orderId,
      callbackUrl: paytmConfig.callbackUrl,
      txnAmount: {
        value: amount.toString(),
        currency: 'INR'
      },
      userInfo: {
        custId: customerId.toString()
      }
    };

    // Signature (checksum) generate – Paytm ke checksum logic ke hisaab se
    const checksum = await PaytmChecksum.generateSignature(
      JSON.stringify(body),
      paytmConfig.key
    );

    const initTxnRequest = {
      body,
      head: {
        signature: checksum
      }
    };

    const url = `${paytmConfig.host}/theia/api/v1/initiateTransaction?mid=${paytmConfig.mid}&orderId=${orderId}`;

    const { data } = await axios.post(url, initTxnRequest, {
      headers: { 'Content-Type': 'application/json' }
    });

    // Error handling for failed init
    if (
      !data.body ||
      !data.body.resultInfo ||
      data.body.resultInfo.resultStatus !== 'S'
    ) {
      console.error('Paytm initiate txn failed:', data);
      return res.status(400).json({
        error: 'Failed to initiate transaction',
        paytmResponse: data
      });
    }

    const txnToken = data.body.txnToken;

    // 🔴 YAHAN DB ME ORDER SAVE KARO (Firestore / MySQL / etc.)
    // Example pseudo:
    // await saveOrderToDB({ orderId, amount, customerId, status: 'PENDING' });

    // Frontend ko ye details bhejo JS Checkout ke liye
    return res.json({
      mid: paytmConfig.mid,
      orderId,
      amount,
      txnToken,
      callbackUrl: paytmConfig.callbackUrl,
      env: process.env.PAYTM_ENVIRONMENT
    });
  } catch (err) {
    console.error('create-order error:', err?.response?.data || err.message);
    return res.status(500).json({
      error: 'Something went wrong while creating order',
      details: err.message
    });
  }
});

/**
 * 2) PAYTM CALLBACK URL
 * Paytm yahan HTML form POST bhejega (agar tumne callback URL set kiya hai)
 * Ye endpoint optional hai, lekin recommended hai callback ko log/verify karna.
 */
app.post('/api/paytm/callback', async (req, res) => {
  try {
    const receivedData = { ...req.body };
    console.log('Paytm callback received:', receivedData);

    const paytmChecksum = receivedData.CHECKSUMHASH;
    delete receivedData.CHECKSUMHASH;

    // Verify checksum (old form flow)
    let isValidChecksum = false;
    if (paytmChecksum) {
      isValidChecksum = PaytmChecksum.verifySignature(
        receivedData,
        paytmConfig.key,
        paytmChecksum
      );
    }

    if (!isValidChecksum) {
      console.warn('Invalid checksum in callback');
      // Yahan tum apni UI dikha sakte ho:
      return res.status(400).send('Checksum mismatched');
    }

    const orderId = receivedData.ORDERID;

    // OPTIONAL: yahi par status API bhi call kar sakte ho
    // lekin main niche /status route bana diya hai reusable.

    // Simple response (agar ye page browser me open hota hai)
    return res.send('Callback received. Please wait while we verify payment.');
  } catch (err) {
    console.error('callback error:', err.message);
    return res.status(500).send('Internal Server Error');
  }
});

/**
 * 3) TRANSACTION STATUS VERIFY
 * Frontend payment complete hone ke baad is route ko hit kare
 * body: { orderId }
 * Ye Paytm Transaction Status API call karega & final status dega
 */
app.post('/api/paytm/status', async (req, res) => {
  try {
    const { orderId } = req.body;
    if (!orderId) {
      return res.status(400).json({ error: 'orderId required' });
    }

    const body = {
      mid: paytmConfig.mid,
      orderId
    };

    const checksum = await PaytmChecksum.generateSignature(
      JSON.stringify(body),
      paytmConfig.key
    );

    const statusRequest = {
      body,
      head: {
        signature: checksum
      }
    };

    const url = `${paytmConfig.host}/v3/order/status`;

    const { data } = await axios.post(url, statusRequest, {
      headers: { 'Content-Type': 'application/json' }
    });

    const resultInfo = data?.body?.resultInfo;
    const txnStatus = resultInfo?.resultStatus; // e.g. "TXN_SUCCESS", "TXN_FAILURE", "PENDING"

    // 🔴 YAHAN APNI ORDER TABLE UPDATE KARO
    // Example:
    // if (txnStatus === 'TXN_SUCCESS') {
    //   await updateOrder(orderId, { status: 'SUCCESS', paytmData: data.body });
    // } else if (txnStatus === 'PENDING') {
    //   await updateOrder(orderId, { status: 'PENDING', paytmData: data.body });
    // } else {
    //   await updateOrder(orderId, { status: 'FAILED', paytmData: data.body });
    // }

    return res.json({
      orderId,
      status: txnStatus,
      resultInfo,
      paytmResponse: data.body
    });
  } catch (err) {
    console.error('status error:', err?.response?.data || err.message);
    return res.status(500).json({
      error: 'Something went wrong while checking status',
      details: err.message
    });
  }
});

const port = process.env.PORT || 4000;
app.listen(port, () => {
  console.log(`Paytm backend listening on port ${port}`);
});
