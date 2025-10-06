const express = require('express');
const path = require('path');
const axios = require('axios');
const cors = require('cors');
const fs = require('fs');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(express.json());
app.use(cors());
app.use(express.static('.'));

// Referral storage
const REFERRAL_FILE = 'referrals.json';

function readReferrals() {
    try {
        if (fs.existsSync(REFERRAL_FILE)) {
            return JSON.parse(fs.readFileSync(REFERRAL_FILE, 'utf8'));
        }
    } catch (error) {
        console.error('Error reading referrals:', error);
    }
    return {};
}

function writeReferrals(data) {
    try {
        fs.writeFileSync(REFERRAL_FILE, JSON.stringify(data, null, 2));
        return true;
    } catch (error) {
        console.error('Error writing referrals:', error);
        return false;
    }
}

// Serve frontend
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Get referral stats
app.get('/api/referral-stats', (req, res) => {
    try {
        const { ref } = req.query;
        const referrals = readReferrals();
        
        if (ref && ref !== 'default') {
            if (!referrals[ref]) {
                referrals[ref] = { referrals: 0, earnings: 0, createdAt: new Date().toISOString() };
            }
            res.json(referrals[ref]);
        } else {
            res.json({ referrals: 0, earnings: 0 });
        }
    } catch (error) {
        console.error('Error getting referral stats:', error);
        res.json({ referrals: 0, earnings: 0 });
    }
});

// Update referral stats
app.post('/api/update-referral', (req, res) => {
    try {
        const { referralCode, amount } = req.body;
        
        if (!referralCode || referralCode === 'default') {
            return res.json({ success: true });
        }

        const referrals = readReferrals();
        
        if (!referrals[referralCode]) {
            referrals[referralCode] = { referrals: 0, earnings: 0, createdAt: new Date().toISOString() };
        }

        referrals[referralCode].referrals += 1;
        referrals[referralCode].earnings += 10; // 10 KES per referral
        
        writeReferrals(referrals);
        res.json({ success: true });
    } catch (error) {
        console.error('Error updating referral:', error);
        res.status(500).json({ success: false });
    }
});

// REAL PayHero Payment Integration
app.post('/api/pay', async (req, res) => {
    try {
        const { phoneNumber, service, amount, referralCode } = req.body;

        console.log('Real payment request:', { phoneNumber, service, amount, referralCode });

        // Validation
        if (!phoneNumber || !service || !amount) {
            return res.status(400).json({
                success: false,
                message: 'Phone number, service, and amount are required'
            });
        }

        if (amount < 100) {
            return res.status(400).json({
                success: false,
                message: 'Minimum amount is 100 KES'
            });
        }

        if (!phoneNumber.startsWith('254') || phoneNumber.length !== 12) {
            return res.status(400).json({
                success: false,
                message: 'Invalid M-PESA number. Use format: 2547XXXXXXXX'
            });
        }

        // PayHero API Configuration - REAL CREDENTIALS REQUIRED
        const payheroConfig = {
            apiKey: process.env.PAYHERO_API_KEY,
            apiSecret: process.env.PAYHERO_API_SECRET,
            merchantId: process.env.PAYHERO_MERCHANT_ID,
            baseUrl: process.env.PAYHERO_BASE_URL || 'https://api.payhero.co.ke/live'
        };

        // Check if credentials are set
        if (!payheroConfig.apiKey || payheroConfig.apiKey === 'your_live_api_key_here') {
            return res.status(500).json({
                success: false,
                message: 'Payment system not configured. Please contact administrator.'
            });
        }

        // Prepare REAL PayHero STK Push request
        const paymentPayload = {
            merchant_id: payheroConfig.merchantId,
            account_number: phoneNumber,
            amount: amount,
            reference: `CHEGETECH-${service}-${Date.now()}`,
            description: `Chege Tech - ${service} Subscription`,
            callback_url: `${process.env.BASE_URL || 'https://chegetech.onrender.com'}/api/payment-callback`,
            currency: 'KES',
            payment_method: 'mpesa'
        };

        console.log('Sending REAL PayHero request:', {
            url: `${payheroConfig.baseUrl}/v1/payments/mpesa-stk-push`,
            payload: paymentPayload
        });

        // Make REAL API call to PayHero
        const payheroResponse = await axios.post(
            `${payheroConfig.baseUrl}/v1/payments/mpesa-stk-push`,
            paymentPayload,
            {
                headers: {
                    'Authorization': `Bearer ${payheroConfig.apiKey}`,
                    'Content-Type': 'application/json',
                    'X-API-SECRET': payheroConfig.apiSecret
                },
                timeout: 30000
            }
        );

        console.log('PayHero API response:', payheroResponse.data);

        if (payheroResponse.data && payheroResponse.data.success) {
            // Update referral stats
            await fetch(`${process.env.BASE_URL || 'http://localhost:5000'}/api/update-referral`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    referralCode: referralCode || 'default',
                    amount: amount
                })
            });

            res.json({
                success: true,
                message: 'Payment initiated successfully. Check your phone to complete M-PESA payment.',
                transactionId: payheroResponse.data.transaction_id,
                data: payheroResponse.data
            });
        } else {
            throw new Error(payheroResponse.data.message || 'Payment initiation failed');
        }

    } catch (error) {
        console.error('REAL Payment error:', error.response?.data || error.message);
        
        let errorMessage = 'Payment failed. Please try again.';
        
        if (error.response?.data?.message) {
            errorMessage = error.response.data.message;
        } else if (error.code === 'ECONNREFUSED') {
            errorMessage = 'Payment service temporarily unavailable';
        } else if (error.code === 'ETIMEDOUT') {
            errorMessage = 'Payment request timeout. Please try again.';
        }

        res.status(500).json({
            success: false,
            message: errorMessage
        });
    }
});

// REAL Payment Callback Webhook (PayHero will call this)
app.post('/api/payment-callback', (req, res) => {
    const callbackData = req.body;
    console.log('REAL Payment callback received:', callbackData);

    // Process the payment result from PayHero
    if (callbackData.status === 'success') {
        console.log('✅ PAYMENT SUCCESSFUL:', {
            transactionId: callbackData.transaction_id,
            amount: callbackData.amount,
            phone: callbackData.phone_number,
            reference: callbackData.reference
        });
        
        // Here you would:
        // 1. Update payment status in database
        // 2. Send confirmation email/SMS
        // 3. Activate the subscription
    } else if (callbackData.status === 'failed') {
        console.log('❌ PAYMENT FAILED:', {
            transactionId: callbackData.transaction_id,
            reason: callbackData.reason
        });
    }

    res.json({ status: 'received' });
});

// Health check
app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'OK', 
        service: 'Chege Tech - REAL Payments',
        timestamp: new Date().toISOString(),
        environment: process.env.NODE_ENV
    });
});

app.listen(PORT, () => {
    console.log(`🚀 Chege Tech REAL Payment Server running on port ${PORT}`);
    console.log(`📍 Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`💳 Payment System: REAL PayHero Integration`);
});
