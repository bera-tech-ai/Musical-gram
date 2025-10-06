require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('.'));

// Simple JSON storage for referrals
const REFERRALS_FILE = 'referrals.json';

function readReferrals() {
  try {
    if (fs.existsSync(REFERRALS_FILE)) {
      return JSON.parse(fs.readFileSync(REFERRALS_FILE, 'utf8'));
    }
  } catch (error) {
    console.error('Error reading referrals:', error);
  }
  return {};
}

function writeReferrals(data) {
  try {
    fs.writeFileSync(REFERRALS_FILE, JSON.stringify(data, null, 2));
  } catch (error) {
    console.error('Error writing referrals:', error);
  }
}

// PayHero STK Push endpoint
app.post('/api/pay', async (req, res) => {
  try {
    const { phone, amount, service, referralCode } = req.body;

    // Validate input
    if (!phone || !amount || !service) {
      return res.status(400).json({ 
        success: false, 
        message: 'Phone number, amount, and service are required' 
      });
    }

    // Format phone number (Kenya format)
    let formattedPhone = phone.toString().trim();
    if (formattedPhone.startsWith('0')) {
      formattedPhone = '254' + formattedPhone.substring(1);
    } else if (formattedPhone.startsWith('+254')) {
      formattedPhone = formattedPhone.substring(1);
    }

    // Validate amount
    const paymentAmount = parseInt(amount);
    if (paymentAmount < 100) {
      return res.status(400).json({ 
        success: false, 
        message: 'Minimum amount is KES 100' 
      });
    }

    // PayHero API configuration
    const payheroConfig = {
      merchant_id: process.env.PAYHERO_MERCHANT_ID,
      api_key: process.env.PAYHERO_API_KEY,
      api_secret: process.env.PAYHERO_API_SECRET
    };

    // STK Push payload
    const stkPayload = {
      MerchantID: payheroConfig.merchant_id,
      PhoneNumber: formattedPhone,
      Amount: paymentAmount,
      TransactionDesc: `Chege Tech - ${service} Subscription`,
      CallBackURL: `${process.env.BASE_URL}/api/callback`,
      AccountReference: `CHEGE-${service.toUpperCase()}`,
      TransactionType: 'CustomerPayBillOnline'
    };

    // Make request to PayHero API
    const response = await axios.post(
      `${process.env.PAYHERO_BASE_URL}/stk/push`,
      stkPayload,
      {
        headers: {
          'Authorization': `Bearer ${payheroConfig.api_key}`,
          'Content-Type': 'application/json'
        }
      }
    );

    console.log('PayHero Response:', response.data);

    if (response.data.ResponseCode === '0') {
      // Track referral if applicable
      if (referralCode) {
        const referrals = readReferrals();
        if (!referrals[referralCode]) {
          referrals[referralCode] = { earnings: 0, payments: 0 };
        }
        referrals[referralCode].payments += 1;
        referrals[referralCode].earnings += 10; // KES 10 per referral
        writeReferrals(referrals);
      }

      // WhatsApp redirect URL
      const whatsappText = `Hi%20Chege%20Tech%20Team,%20I%20have%20completed%20my%20payment%20for%20${service}.`;
      const whatsappUrl = `https://wa.me/${process.env.ADMIN_WHATSAPP}?text=${whatsappText}`;

      return res.json({
        success: true,
        message: 'STK Push sent successfully',
        checkoutRequestID: response.data.CheckoutRequestID,
        whatsappUrl: whatsappUrl
      });
    } else {
      return res.status(400).json({
        success: false,
        message: response.data.ResponseDescription || 'Payment failed'
      });
    }

  } catch (error) {
    console.error('Payment Error:', error);
    
    // Fallback simulation for demo purposes
    if (process.env.NODE_ENV === 'development') {
      const whatsappText = `Hi%20Chege%20Tech%20Team,%20I%20have%20completed%20my%20payment%20for%20${req.body.service}.`;
      const whatsappUrl = `https://wa.me/${process.env.ADMIN_WHATSAPP}?text=${whatsappText}`;
      
      return res.json({
        success: true,
        message: 'STK Push simulated successfully',
        checkoutRequestID: 'SIMULATED_' + Date.now(),
        whatsappUrl: whatsappUrl
      });
    }

    return res.status(500).json({
      success: false,
      message: 'Payment processing failed. Please try again.'
    });
  }
});

// Callback endpoint for PayHero
app.post('/api/callback', (req, res) => {
  console.log('Payment Callback:', req.body);
  res.status(200).send('OK');
});

// Referral stats endpoint
app.get('/api/referral/:code', (req, res) => {
  const referrals = readReferrals();
  const stats = referrals[req.params.code] || { earnings: 0, payments: 0 };
  res.json(stats);
});

// Serve frontend for all other routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`🚀 Chege Tech server running on port ${PORT}`);
  console.log(`📍 Environment: ${process.env.NODE_ENV}`);
});
