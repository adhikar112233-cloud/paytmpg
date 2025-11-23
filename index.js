// server.js
require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const axios = require("axios");
const PaytmChecksum = require("paytmchecksum");
const paytmConfig = require("./paytm.config");

const app = express();

app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false })); // callback ke liye

// Simple health check
app.get("/", (req, res) => {
  res.send("✅ Paytm PG backend is running.");
});

// Helper: unique orderId generate
function generateOrderId() {
  return "ORDER_" + Date.now() + "_" + Math.floor(Math.random() * 1000);
}

/**
 * 1) CREATE ORDER + INITIATE TRANSACTION
 *    FRONTEND isko call karega
 *    POST /api/paytm/create-order
 *    body: { amount, customerId }
 */
app.post("/api/paytm/create-order", async (req, res) => {
  try {
    const { amount, customerId } = req.body;

    if (!amount || !customerId) {
      return res
        .status(400)
        .json({ error: "amount and customerId are required" });
    }

    const orderId = generateOrderId();

    const paytmParams = {
      requestType: "Payment",
      mid: paytmConfig.mid,
      websiteName: paytmConfig.website,
      orderId,
      callbackUrl: paytmConfig.callbackUrl,
      txnAmount: {
        value: amount.toString(),
        currency: "INR"
      },
      userInfo: {
        custId: customerId.toString()
      }
    };

    // Signature
    const checksum = await PaytmChecksum.generateSignature(
      JSON.stringify(paytmParams),
      paytmConfig.key
    );

    const requestBody = {
      body: paytmParams,
      head: {
        signature: checksum
      }
    };

    const url = `${paytmConfig.host}/theia/api/v1/initiateTransaction?mid=${paytmConfig.mid}&orderId=${orderId}`;

    const { data } = await axios.post(url, requestBody, {
      headers: {
        "Content-Type": "application/json"
      }
    });

    if (
      !data.body ||
      !data.body.resultInfo ||
      data.body.resultInfo.resultStatus !== "S"
    ) {
      console.error("Initiate Transaction Failed:", data);
      return res.status(400).json({
        error: "Failed to initiate transaction",
        paytmResponse: data
      });
    }

    const txnToken = data.body.txnToken;

    // 🔴 Yahan tum apne DB (Firestore / MySQL) me order save kar sakte ho
    // Example pseudo:
    // await saveOrder({ orderId, amount, customerId, status: "PENDING" });

    return res.json({
      mid: paytmConfig.mid,
      orderId,
      amount,
      txnToken,
      callbackUrl: paytmConfig.callbackUrl,
      env: process.env.PAYTM_ENVIRONMENT
    });
  } catch (err) {
    console.error("create-order error:", err?.response?.data || err.message);
    return res.status(500).json({
      error: "Something went wrong while creating order",
      details: err.message
    });
  }
});

/**
 * 2) PAYTM CALLBACK (optional, but recommended)
 *    Paytm yahan HTML form POST karega
 *    URL: PAYTM_CALLBACK_URL
 */
app.post("/api/paytm/callback", async (req, res) => {
  try {
    const receivedData = { ...req.body };

    console.log("Paytm callback data:", receivedData);

    const paytmChecksum = receivedData.CHECKSUMHASH;
    delete receivedData.CHECKSUMHASH;

    // Agar tum old form-checkout use kar rahe ho to checksum verify kar sakte ho
    let isValidChecksum = true;
    if (paytmChecksum) {
      isValidChecksum = PaytmChecksum.verifySignature(
        receivedData,
        paytmConfig.key,
        paytmChecksum
      );
    }

    if (!isValidChecksum) {
      console.warn("❌ Invalid checksum in callback");
      return res.status(400).send("Checksum mismatched");
    }

    // OPTIONAL: yahi par tum order status API call karke DB update kar sakte ho

    return res.send(
      "Paytm callback received. You can close this window and return to the app."
    );
  } catch (err) {
    console.error("callback error:", err.message);
    return res.status(500).send("Internal Server Error");
  }
});

/**
 * 3) TRANSACTION STATUS API
 *    Frontend payment ke baad yeh route call kare:
 *    POST /api/paytm/status
 *    body: { orderId }
 */
app.post("/api/paytm/status", async (req, res) => {
  try {
    const { orderId } = req.body;

    if (!orderId) {
      return res.status(400).json({ error: "orderId is required" });
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
      headers: {
        "Content-Type": "application/json"
      }
    });

    const resultInfo = data?.body?.resultInfo;
    const txnStatus = resultInfo?.resultStatus; // "TXN_SUCCESS", "TXN_FAILURE", "PENDING" etc.

    // 🔴 Yahan DB me order update karo:
    // if (txnStatus === "TXN_SUCCESS") { status = "SUCCESS" ... }
    // else if (txnStatus === "PENDING") { status = "PENDING" ... }
    // else { status = "FAILED" ... }

    return res.json({
      orderId,
      status: txnStatus,
      resultInfo,
      paytmResponse: data.body
    });
  } catch (err) {
    console.error("status error:", err?.response?.data || err.message);
    return res.status(500).json({
      error: "Something went wrong while checking status",
      details: err.message
    });
  }
});

// ==== START SERVER (Render friendly) ====
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`🚀 Paytm backend running on port ${PORT}`);
});
