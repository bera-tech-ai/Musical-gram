const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// In-memory storage (replace with database in production)
const transactions = new Map();
const referrals = new Map();

// PayHero API Helper Functions
class PayHeroAPI {
    constructor() {
        this.apiKey = process.env.PAYHERO_API_KEY;
        this.apiSecret = process.env.PAYHERO_API_SECRET;
        this.merchantId = process.env.PAYHERO_MERCHANT_ID;
        this.baseURL = process.env.PAYHERO_BASE_URL;
    }

    generateSignature(timestamp, method, endpoint, body = '') {
        const message = `${timestamp}${method}${endpoint}${body}`;
        return crypto
            .createHmac('sha256', this.apiSecret)
            .update(message)
            .digest('hex');
    }

    async makeRequest(endpoint, method = 'GET', data = null) {
        try {
            const timestamp = Date.now().toString();
            const signature = this.generateSignature(
                timestamp, 
                method, 
                endpoint, 
                data ? JSON.stringify(data) : ''
            );

            const headers = {
                'Authorization': `Bearer ${this.apiKey}`,
                'Content-Type': 'application/json',
                'X-Timestamp': timestamp,
                'X-Signature': signature,
                'X-Merchant-ID': this.merchantId
            };

            const fetch = await import('node-fetch');
            const response = await fetch.default(`${this.baseURL}${endpoint}`, {
                method,
                headers,
                body: data ? JSON.stringify(data) : null
            });

            const result = await response.json();
            return result;
        } catch (error) {
            console.error('PayHero API Error:', error);
            throw new Error('Payment service temporarily unavailable');
        }
    }

    async initiateSTKPush(phone, amount, reference) {
        const endpoint = '/stkpush';
        const payload = {
            merchant_id: this.merchantId,
            phone: phone,
            amount: amount,
            transaction_reference: reference,
            callback_url: `${process.env.BASE_URL}/api/callback`,
            description: `ChegeTech Premium Subscription - ${reference}`
        };

        return await this.makeRequest(endpoint, 'POST', payload);
    }

    async checkTransactionStatus(checkoutRequestID) {
        const endpoint = `/transaction/status/${checkoutRequestID}`;
        return await this.makeRequest(endpoint, 'GET');
    }
}

const payhero = new PayHeroAPI();

// Routes
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// STK Push Endpoint
app.post('/api/payhero/stkpush', async (req, res) => {
    try {
        const { phone, plan, referralCode } = req.body;
        
        // Validate input
        if (!phone || !/^2547\d{8}$/.test(phone)) {
            return res.status(400).json({
                success: false,
                message: 'Please provide a valid M-Pesa number (2547XXXXXXXX)'
            });
        }

        if (!plan) {
            return res.status(400).json({
                success: false,
                message: 'Please select a subscription plan'
            });
        }

        const amount = 100; // Fixed amount for all plans
        const transactionRef = `CHTECH${Date.now()}${Math.random().toString(36).substr(2, 5)}`.toUpperCase();

        // Store transaction details
        transactions.set(transactionRef, {
            phone,
            plan,
            amount,
            status: 'pending',
            timestamp: new Date(),
            referralCode
        });

        // Initiate STK Push with PayHero
        const stkResponse = await payhero.initiateSTKPush(phone, amount, transactionRef);

        if (stkResponse.success) {
            // Update transaction with checkout ID
            const transaction = transactions.get(transactionRef);
            transaction.checkoutRequestID = stkResponse.checkout_request_id;
            transactions.set(transactionRef, transaction);

            res.json({
                success: true,
                message: 'Payment request sent to your phone. Please enter your M-Pesa PIN to complete payment.',
                transactionRef,
                checkoutRequestID: stkResponse.checkout_request_id
            });
        } else {
            res.status(400).json({
                success: false,
                message: stkResponse.message || 'Failed to initiate payment'
            });
        }
    } catch (error) {
        console.error('STK Push Error:', error);
        res.status(500).json({
            success: false,
            message: error.message || 'Internal server error'
        });
    }
});

// Payment Callback Endpoint
app.post('/api/callback', async (req, res) => {
    try {
        const callbackData = req.body;
        
        console.log('Payment Callback Received:', JSON.stringify(callbackData, null, 2));

        // Extract transaction details from callback
        const {
            transaction_reference: transactionRef,
            status,
            checkout_request_id: checkoutRequestID,
            mpesa_receipt_number: receiptNumber
        } = callbackData;

        // Update transaction status
        if (transactions.has(transactionRef)) {
            const transaction = transactions.get(transactionRef);
            transaction.status = status.toLowerCase();
            transaction.receiptNumber = receiptNumber;
            transaction.completedAt = new Date();

            transactions.set(transactionRef, transaction);

            // Handle referral if payment successful
            if (status.toLowerCase() === 'completed' && transaction.referralCode) {
                await handleReferral(transaction.referralCode, transactionRef);
            }

            console.log(`Transaction ${transactionRef} updated to status: ${status}`);
        }

        res.status(200).json({ success: true });
    } catch (error) {
        console.error('Callback Error:', error);
        res.status(500).json({ success: false });
    }
});

// Transaction Status Check
app.get('/api/transaction/:transactionRef/status', async (req, res) => {
    try {
        const { transactionRef } = req.params;
        
        if (!transactions.has(transactionRef)) {
            return res.status(404).json({
                success: false,
                message: 'Transaction not found'
            });
        }

        const transaction = transactions.get(transactionRef);
        
        // If still pending, check with PayHero
        if (transaction.status === 'pending' && transaction.checkoutRequestID) {
            try {
                const statusResponse = await payhero.checkTransactionStatus(transaction.checkoutRequestID);
                
                if (statusResponse.status && statusResponse.status !== 'pending') {
                    transaction.status = statusResponse.status.toLowerCase();
                    transactions.set(transactionRef, transaction);
                }
            } catch (error) {
                console.error('Status check error:', error);
            }
        }

        res.json({
            success: true,
            status: transaction.status,
            receiptNumber: transaction.receiptNumber,
            plan: transaction.plan
        });
    } catch (error) {
        console.error('Status Check Error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to check transaction status'
        });
    }
});

// Referral System
app.post('/api/referral/generate', (req, res) => {
    const { userId } = req.body;
    const referralCode = `REF${Math.random().toString(36).substr(2, 8).toUpperCase()}`;
    
    referrals.set(referralCode, {
        userId,
        code: referralCode,
        createdAt: new Date(),
        referredUsers: [],
        earnings: 0
    });

    res.json({
        success: true,
        referralCode,
        referralLink: `${process.env.BASE_URL}?ref=${referralCode}`
    });
});

app.get('/api/referral/:code', (req, res) => {
    const { code } = req.params;
    
    if (referrals.has(code)) {
        res.json({
            success: true,
            referral: referrals.get(code)
        });
    } else {
        res.status(404).json({
            success: false,
            message: 'Invalid referral code'
        });
    });
});

async function handleReferral(referralCode, transactionRef) {
    if (referrals.has(referralCode)) {
        const referral = referrals.get(referralCode);
        referral.referredUsers.push(transactionRef);
        referral.earnings += 20; // KES 20 per referral
        referral.lastEarningDate = new Date();
        
        referrals.set(referralCode, referral);
        console.log(`Referral ${referralCode} earned KES 20 from transaction ${transactionRef}`);
    }
}

// Health check endpoint
app.get('/api/health', (req, res) => {
    res.json({
        success: true,
        message: 'ChegeTech Premium Platform is running',
        timestamp: new Date().toISOString(),
        environment: process.env.NODE_ENV
    });
});

app.listen(PORT, () => {
    console.log(`🚀 ChegeTech Premium Platform running on port ${PORT}`);
    console.log(`📍 Environment: ${process.env.NODE_ENV}`);
    console.log(`🌐 Base URL: ${process.env.BASE_URL}`);
});
