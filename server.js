
'use strict';

const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

const app = express();
const PORT = Number(process.env.PORT) || 5000;
const BASE_URL = (process.env.BASE_URL || '').replace(/\/+$/, '');

// PayHero configuration
const PAYHERO_API_KEY = process.env.PAYHERO_API_KEY;
const PAYHERO_API_SECRET = process.env.PAYHERO_API_SECRET;
const PAYHERO_MERCHANT_ID = process.env.PAYHERO_MERCHANT_ID;
const PAYHERO_BASE_URL = (process.env.PAYHERO_BASE_URL || '').replace(/\/+$/, '');

// In-memory storage.
// IMPORTANT: Data is lost when the server restarts.
// Replace these Maps with MongoDB for production.
const transactions = new Map();
const referrals = new Map();

// Middleware
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Helpers
function normalizeStatus(status) {
    return String(status || 'pending').trim().toLowerCase();
}

function isSuccessfulStatus(status) {
    return ['completed', 'success', 'successful', 'paid'].includes(
        normalizeStatus(status)
    );
}

function isFinalStatus(status) {
    return [
        'completed',
        'success',
        'successful',
        'paid',
        'failed',
        'cancelled',
        'canceled',
        'rejected',
        'expired'
    ].includes(normalizeStatus(status));
}

function findTransactionByCheckoutId(checkoutRequestID) {
    for (const [reference, transaction] of transactions.entries()) {
        if (transaction.checkoutRequestID === checkoutRequestID) {
            return { reference, transaction };
        }
    }

    return null;
}

function getTransactionReference(callbackData) {
    return (
        callbackData.transaction_reference ||
        callbackData.external_reference ||
        callbackData.reference ||
        null
    );
}

// PayHero API helper
class PayHeroAPI {
    constructor() {
        this.apiKey = PAYHERO_API_KEY;
        this.apiSecret = PAYHERO_API_SECRET;
        this.merchantId = PAYHERO_MERCHANT_ID;
        this.baseURL = PAYHERO_BASE_URL;
    }

    validateConfiguration() {
        const missing = [];

        if (!this.apiKey) missing.push('PAYHERO_API_KEY');
        if (!this.apiSecret) missing.push('PAYHERO_API_SECRET');
        if (!this.merchantId) missing.push('PAYHERO_MERCHANT_ID');
        if (!this.baseURL) missing.push('PAYHERO_BASE_URL');

        if (missing.length) {
            throw new Error(
                `Missing PayHero environment variables: ${missing.join(', ')}`
            );
        }

        if (typeof fetch !== 'function') {
            throw new Error(
                'This server requires Node.js 18 or later for built-in fetch.'
            );
        }
    }

    generateSignature(timestamp, method, endpoint, body = '') {
        if (!this.apiSecret) {
            throw new Error('PAYHERO_API_SECRET is not configured.');
        }

        const message = `${timestamp}${method}${endpoint}${body}`;

        return crypto
            .createHmac('sha256', this.apiSecret)
            .update(message)
            .digest('hex');
    }

    async makeRequest(endpoint, method = 'GET', data = null) {
        this.validateConfiguration();

        const timestamp = Date.now().toString();
        const body = data ? JSON.stringify(data) : '';
        const signature = this.generateSignature(
            timestamp,
            method,
            endpoint,
            body
        );

        const headers = {
            Authorization: `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
            'X-Timestamp': timestamp,
            'X-Signature': signature,
            'X-Merchant-ID': this.merchantId
        };

        const options = {
            method,
            headers
        };

        if (data && method !== 'GET' && method !== 'HEAD') {
            options.body = body;
        }

        let response;

        try {
            response = await fetch(`${this.baseURL}${endpoint}`, options);
        } catch (error) {
            console.error('PayHero connection error:', error.message);
            throw new Error('Could not connect to the PayHero service.');
        }

        const responseText = await response.text();
        let result = {};

        if (responseText) {
            try {
                result = JSON.parse(responseText);
            } catch {
                result = { message: responseText };
            }
        }

        if (!response.ok) {
            console.error('PayHero HTTP error:', response.status, result);

            const error = new Error(
                result.message ||
                result.error ||
                `PayHero returned HTTP ${response.status}.`
            );

            error.statusCode = 502;
            throw error;
        }

        return result;
    }

    async initiateSTKPush(phone, amount, reference) {
        // Confirm this path and payload against your PayHero API documentation.
        const endpoint = '/stkpush';

        const payload = {
            merchant_id: this.merchantId,
            phone,
            amount,
            transaction_reference: reference,
            callback_url: BASE_URL
                ? `${BASE_URL}/api/callback`
                : undefined,
            description: `ChegeTech Premium Subscription - ${reference}`
        };

        return this.makeRequest(endpoint, 'POST', payload);
    }

    async checkTransactionStatus(checkoutRequestID) {
        // Confirm this path against your PayHero API documentation.
        const endpoint =
            `/transaction/status/${encodeURIComponent(checkoutRequestID)}`;

        return this.makeRequest(endpoint, 'GET');
    }
}

const payhero = new PayHeroAPI();

// Home page
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'), (error) => {
        if (error && !res.headersSent) {
            res.status(404).send('Website page not found. Check public/index.html.');
        }
    });
});

// Initiate M-Pesa STK Push
app.post('/api/payhero/stkpush', async (req, res) => {
    try {
        const { phone, plan, referralCode } = req.body || {};

        if (!phone || !/^2547\d{8}$/.test(String(phone))) {
            return res.status(400).json({
                success: false,
                message: 'Enter a valid M-Pesa number in the format 2547XXXXXXXX.'
            });
        }

        if (
            typeof plan !== 'string' ||
            !plan.trim() ||
            plan.trim().length > 100
        ) {
            return res.status(400).json({
                success: false,
                message: 'Please select a valid subscription plan.'
            });
        }

        if (
            referralCode !== undefined &&
            referralCode !== null &&
            typeof referralCode !== 'string'
        ) {
            return res.status(400).json({
                success: false,
                message: 'Invalid referral code.'
            });
        }

        if (referralCode && !referrals.has(referralCode)) {
            return res.status(400).json({
                success: false,
                message: 'The referral code is invalid.'
            });
        }

        if (!BASE_URL) {
            return res.status(500).json({
                success: false,
                message: 'BASE_URL is not configured on the server.'
            });
        }

        const amount = 100; // KES: change this if your plans have different prices.
        const transactionRef =
            `CHTECH${Date.now()}${crypto.randomBytes(3).toString('hex')}`
                .toUpperCase();

        const transaction = {
            phone: String(phone),
            plan: plan.trim(),
            amount,
            status: 'pending',
            timestamp: new Date(),
            referralCode: referralCode || null,
            checkoutRequestID: null,
            receiptNumber: null,
            referralRewarded: false
        };

        transactions.set(transactionRef, transaction);

        try {
            const stkResponse = await payhero.initiateSTKPush(
                transaction.phone,
                amount,
                transactionRef
            );

            // Accommodate common response field names, but verify the
            // actual response format returned by your PayHero account.
            const checkoutRequestID =
                stkResponse.checkout_request_id ||
                stkResponse.checkoutRequestID ||
                stkResponse.CheckoutRequestID ||
                null;

            const accepted =
                stkResponse.success === true ||
                stkResponse.status === 'success' ||
                stkResponse.status === 'queued' ||
                Boolean(checkoutRequestID);

            if (!accepted) {
                transaction.status = 'failed';
                transaction.gatewayResponse = stkResponse;
                transactions.set(transactionRef, transaction);

                return res.status(502).json({
                    success: false,
                    message:
                        stkResponse.message ||
                        stkResponse.error ||
                        'PayHero did not confirm the payment request.'
                });
            }

            transaction.checkoutRequestID = checkoutRequestID;
            transactions.set(transactionRef, transaction);

            return res.json({
                success: true,
                message:
                    'Payment request submitted. Check your phone and follow the M-Pesa instructions.',
                transactionRef,
                checkoutRequestID
            });
        } catch (error) {
            transaction.status = 'failed';
            transactions.set(transactionRef, transaction);
            throw error;
        }
    } catch (error) {
        console.error('STK Push error:', error.message);

        return res.status(error.statusCode || 500).json({
            success: false,
            message: error.message || 'Could not initiate the payment.'
        });
    }
});

// PayHero payment callback
app.post('/api/callback', async (req, res) => {
    try {
        const callbackData = req.body || {};

        console.log(
            'Payment callback received:',
            JSON.stringify(callbackData)
        );

        const checkoutRequestID =
            callbackData.checkout_request_id ||
            callbackData.checkoutRequestID ||
            null;

        let transactionRef = getTransactionReference(callbackData);
        let transaction = transactionRef
            ? transactions.get(transactionRef)
            : null;

        // If the callback omits the reference, try the checkout ID.
        if (!transaction && checkoutRequestID) {
            const found = findTransactionByCheckoutId(checkoutRequestID);

            if (found) {
                transactionRef = found.reference;
                transaction = found.transaction;
            }
        }

        if (!transaction) {
            console.warn('Callback did not match a stored transaction.');
            // Acknowledge the callback to avoid repeated delivery loops.
            // Check your provider's callback retry requirements.
            return res.status(200).json({
                success: true,
                message: 'Callback received; no matching transaction found.'
            });
        }

        const callbackStatus = normalizeStatus(
            callbackData.status ||
            callbackData.transaction_status ||
            callbackData.result ||
            callbackData.payment_status
        );

        if (callbackStatus === 'pending' && !isFinalStatus(callbackStatus)) {
            return res.status(200).json({ success: true });
        }

        // Do not downgrade a completed payment due to a later callback.
        if (
            !isSuccessfulStatus(transaction.status) ||
            isSuccessfulStatus(callbackStatus)
        ) {
            transaction.status = callbackStatus;
        }

        transaction.receiptNumber =
            callbackData.mpesa_receipt_number ||
            callbackData.receipt_number ||
            callbackData.MpesaReceiptNumber ||
            transaction.receiptNumber;

        transaction.lastCallbackAt = new Date();

        if (isSuccessfulStatus(transaction.status)) {
            transaction.completedAt =
                transaction.completedAt || new Date();

            if (transaction.referralCode && !transaction.referralRewarded) {
                await handleReferral(
                    transaction.referralCode,
                    transactionRef
                );

                transaction.referralRewarded = true;
            }
        }

        transactions.set(transactionRef, transaction);

        console.log(
            `Transaction ${transactionRef} status: ${transaction.status}`
        );

        return res.status(200).json({ success: true });
    } catch (error) {
        console.error('Payment callback error:', error.message);

        return res.status(500).json({
            success: false,
            message: 'Failed to process payment callback.'
        });
    }
});

// Check transaction status
app.get('/api/transaction/:transactionRef/status', async (req, res) => {
    try {
        const { transactionRef } = req.params;
        const transaction = transactions.get(transactionRef);

        if (!transaction) {
            return res.status(404).json({
                success: false,
                message:
                    'Transaction not found. It may have expired after a server restart.'
            });
        }

        if (
            transaction.status === 'pending' &&
            transaction.checkoutRequestID
        ) {
            try {
                const statusResponse = await payhero.checkTransactionStatus(
                    transaction.checkoutRequestID
                );

                const gatewayStatus = normalizeStatus(
                    statusResponse.status ||
                    statusResponse.transaction_status ||
                    statusResponse.payment_status
                );

                if (gatewayStatus && gatewayStatus !== 'pending') {
                    transaction.status = gatewayStatus;
                }

                transaction.receiptNumber =
                    statusResponse.mpesa_receipt_number ||
                    statusResponse.receipt_number ||
                    transaction.receiptNumber;

                if (isSuccessfulStatus(transaction.status)) {
                    transaction.completedAt =
                        transaction.completedAt || new Date();

                    if (
                        transaction.referralCode &&
                        !transaction.referralRewarded
                    ) {
                        await handleReferral(
                            transaction.referralCode,
                            transactionRef
                        );

                        transaction.referralRewarded = true;
                    }
                }

                transactions.set(transactionRef, transaction);
            } catch (error) {
                console.error('Gateway status check failed:', error.message);
                // Return the last locally stored status if the gateway
                // status endpoint is temporarily unavailable.
            }
        }

        return res.json({
            success: true,
            transactionRef,
            status: transaction.status,
            receiptNumber: transaction.receiptNumber || null,
            plan: transaction.plan,
            amount: transaction.amount,
            timestamp: transaction.timestamp
        });
    } catch (error) {
        console.error('Status check error:', error.message);

        return res.status(500).json({
            success: false,
            message: 'Failed to check transaction status.'
        });
    }
});

// Generate a referral code
app.post('/api/referral/generate', (req, res) => {
    try {
        const { userId } = req.body || {};

        if (
            userId === undefined ||
            userId === null ||
            !String(userId).trim() ||
            String(userId).length > 200
        ) {
            return res.status(400).json({
                success: false,
                message: 'A valid userId is required.'
            });
        }

        let referralCode;

        do {
            referralCode =
                `REF${crypto.randomBytes(5).toString('hex')}`.toUpperCase();
        } while (referrals.has(referralCode));

        referrals.set(referralCode, {
            userId: String(userId),
            code: referralCode,
            createdAt: new Date(),
            referredUsers: [],
            earnings: 0
        });

        return res.status(201).json({
            success: true,
            referralCode,
            referralLink: BASE_URL
                ? `${BASE_URL}/?ref=${encodeURIComponent(referralCode)}`
                : null
        });
    } catch (error) {
        console.error('Referral generation error:', error.message);

        return res.status(500).json({
            success: false,
            message: 'Could not generate a referral code.'
        });
    }
});

// Get referral details
app.get('/api/referral/:code', (req, res) => {
    const { code } = req.params;

    if (!referrals.has(code)) {
        return res.status(404).json({
            success: false,
            message: 'Invalid referral code.'
        });
    }

    const referral = referrals.get(code);

    return res.json({
        success: true,
        referral: {
            userId: referral.userId,
            code: referral.code,
            createdAt: referral.createdAt,
            referredUsers: referral.referredUsers,
            earnings: referral.earnings,
            lastEarningDate: referral.lastEarningDate || null
        }
    });
});

// Award referral earnings only once per transaction.
async function handleReferral(referralCode, transactionRef) {
    const referral = referrals.get(referralCode);

    if (!referral) {
        console.warn(`Referral code ${referralCode} was not found.`);
        return false;
    }

    if (referral.referredUsers.includes(transactionRef)) {
        return true;
    }

    referral.referredUsers.push(transactionRef);
    referral.earnings += 20; // KES 20 per successful referred payment.
    referral.lastEarningDate = new Date();

    referrals.set(referralCode, referral);

    console.log(
        `Referral ${referralCode} earned KES 20 from ${transactionRef}.`
    );

    return true;
}

// Health check
app.get('/api/health', (req, res) => {
    res.json({
        success: true,
        message: 'ChegeTech Premium Platform is running',
        timestamp: new Date().toISOString(),
        environment: process.env.NODE_ENV || 'production'
    });
});

// Unknown API routes
app.use('/api', (req, res) => {
    res.status(404).json({
        success: false,
        message: 'API endpoint not found.'
    });
});

// General error handler
app.use((error, req, res, next) => {
    console.error('Server error:', error.message);

    if (res.headersSent) {
        return next(error);
    }

    return res.status(error.status || 500).json({
        success: false,
        message: 'An unexpected server error occurred.'
    });
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
    console.log(`ChegeTech Premium Platform running on port ${PORT}`);
    console.log(`Environment: ${process.env.NODE_ENV || 'production'}`);
    console.log(`Base URL configured: ${BASE_URL ? 'Yes' : 'No'}`);

    const missing = [];

    if (!PAYHERO_API_KEY) missing.push('PAYHERO_API_KEY');
    if (!PAYHERO_API_SECRET) missing.push('PAYHERO_API_SECRET');
    if (!PAYHERO_MERCHANT_ID) missing.push('PAYHERO_MERCHANT_ID');
    if (!PAYHERO_BASE_URL) missing.push('PAYHERO_BASE_URL');
    if (!BASE_URL) missing.push('BASE_URL');

    if (missing.length) {
        console.warn(
            `Configuration required before payments can work: ${missing.join(', ')}`
        );
    }
});
