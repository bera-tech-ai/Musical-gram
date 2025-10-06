const express = require('express');
const axios = require('axios');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('.'));

// Initialize data files
const dataDir = './data';
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir);
}

const transactionsFile = path.join(dataDir, 'transactions.json');
const referralsFile = path.join(dataDir, 'referrals.json');

// Initialize JSON files if they don't exist
if (!fs.existsSync(transactionsFile)) {
    fs.writeFileSync(transactionsFile, JSON.stringify([]));
}
if (!fs.existsSync(referralsFile)) {
    fs.writeFileSync(referralsFile, JSON.stringify({}));
}

// Safaricom Daraja API Configuration
const DARAJA_CONFIG = {
    consumerKey: process.env.DARAJA_CONSUMER_KEY,
    consumerSecret: process.env.DARAJA_CONSUMER_SECRET,
    shortcode: process.env.MPESA_SHORTCODE || '174379',
    passkey: process.env.MPESA_PASSKEY,
    callbackUrl: process.env.CALLBACK_URL || 'https://bera-subscriptions.onrender.com/api/callback'
};

// Email configuration
const emailTransporter = nodemailer.createTransporter({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: 587,
    secure: false,
    auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
    }
});

// Helper functions
function readTransactions() {
    try {
        return JSON.parse(fs.readFileSync(transactionsFile, 'utf8'));
    } catch (error) {
        return [];
    }
}

function writeTransactions(transactions) {
    fs.writeFileSync(transactionsFile, JSON.stringify(transactions, null, 2));
}

function readReferrals() {
    try {
        return JSON.parse(fs.readFileSync(referralsFile, 'utf8'));
    } catch (error) {
        return {};
    }
}

function writeReferrals(referrals) {
    fs.writeFileSync(referralsFile, JSON.stringify(referrals, null, 2));
}

// Generate Daraja access token
async function getAccessToken() {
    try {
        const auth = Buffer.from(`${DARAJA_CONFIG.consumerKey}:${DARAJA_CONFIG.consumerSecret}`).toString('base64');
        
        const response = await axios.get('https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials', {
            headers: {
                'Authorization': `Basic ${auth}`
            }
        });
        
        return response.data.access_token;
    } catch (error) {
        console.error('Error getting access token:', error.response?.data || error.message);
        throw error;
    }
}

// Generate Lipa Na M-PESA password
function generatePassword() {
    const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, -3);
    const shortcode = DARAJA_CONFIG.shortcode;
    const passkey = DARAJA_CONFIG.passkey;
    
    const password = Buffer.from(shortcode + passkey + timestamp).toString('base64');
    return { password, timestamp };
}

// Initiate STK Push
async function initiateSTKPush(phone, amount, reference) {
    try {
        const accessToken = await getAccessToken();
        const { password, timestamp } = generatePassword();
        
        const stkPayload = {
            BusinessShortCode: DARAJA_CONFIG.shortcode,
            Password: password,
            Timestamp: timestamp,
            TransactionType: 'CustomerPayBillOnline',
            Amount: amount,
            PartyA: phone,
            PartyB: DARAJA_CONFIG.shortcode,
            PhoneNumber: phone,
            CallBackURL: DARAJA_CONFIG.callbackUrl,
            AccountReference: reference,
            TransactionDesc: `Subscription payment for ${reference}`
        };
        
        const response = await axios.post(
            'https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest',
            stkPayload,
            {
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': 'application/json'
                }
            }
        );
        
        return response.data;
    } catch (error) {
        console.error('Error initiating STK Push:', error.response?.data || error.message);
        throw error;
    }
}

// Send email receipt
async function sendEmailReceipt(email, transaction) {
    try {
        const mailOptions = {
            from: process.env.SMTP_USER,
            to: email,
            subject: 'Your Bera Subscription Receipt',
            html: `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                    <h2 style="color: #E50914;">Bera Subscriptions</h2>
                    <h3>Payment Receipt</h3>
                    <div style="background: #f9f9f9; padding: 20px; border-radius: 5px;">
                        <p><strong>Service:</strong> ${transaction.service}</p>
                        <p><strong>Plan:</strong> ${transaction.plan}</p>
                        <p><strong>Amount:</strong> KSh ${transaction.amount}</p>
                        <p><strong>Transaction ID:</strong> ${transaction.transactionId}</p>
                        <p><strong>Reference:</strong> ${transaction.reference}</p>
                        <p><strong>Date:</strong> ${new Date(transaction.timestamp).toLocaleString()}</p>
                        ${transaction.referralEarnings ? `<p><strong>Referral Credit:</strong> KSh ${transaction.referralEarnings}</p>` : ''}
                    </div>
                    <p>Thank you for your subscription!</p>
                </div>
            `
        };
        
        await emailTransporter.sendMail(mailOptions);
        console.log('Email receipt sent to:', email);
    } catch (error) {
        console.error('Error sending email:', error);
    }
}

// Routes

// Serve frontend
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Payment endpoint
app.post('/api/pay', async (req, res) => {
    try {
        const { phone, service, plan, amount, referralId, email } = req.body;
        
        if (!phone || !service || !plan || !amount) {
            return res.status(400).json({ error: 'Missing required fields' });
        }
        
        // Format phone number (2547...)
        const formattedPhone = phone.startsWith('254') ? phone : 
                              phone.startsWith('0') ? '254' + phone.slice(1) : 
                              phone.startsWith('+254') ? phone.slice(1) : '254' + phone;
        
        const reference = `BERA-${service.toUpperCase()}-${plan.toUpperCase()}`;
        const transactionId = uuidv4();
        
        // Initiate STK Push
        const stkResponse = await initiateSTKPush(formattedPhone, amount, reference);
        
        if (stkResponse.ResponseCode === '0') {
            // Save transaction as pending
            const transaction = {
                id: transactionId,
                phone: formattedPhone,
                service,
                plan,
                amount,
                reference,
                checkoutRequestID: stkResponse.CheckoutRequestID,
                merchantRequestID: stkResponse.MerchantRequestID,
                status: 'pending',
                referralId: referralId || null,
                email: email || null,
                timestamp: new Date().toISOString()
            };
            
            const transactions = readTransactions();
            transactions.push(transaction);
            writeTransactions(transactions);
            
            res.json({
                success: true,
                message: 'STK Push initiated successfully',
                checkoutRequestID: stkResponse.CheckoutRequestID,
                transactionId
            });
        } else {
            res.status(400).json({
                success: false,
                error: 'Failed to initiate payment'
            });
        }
    } catch (error) {
        console.error('Payment error:', error);
        res.status(500).json({
            success: false,
            error: 'Internal server error'
        });
    }
});

// Callback endpoint
app.post('/api/callback', (req, res) => {
    try {
        const callbackData = req.body;
        console.log('M-PESA Callback:', JSON.stringify(callbackData, null, 2));
        
        const stkCallback = callbackData.Body.stkCallback;
        const checkoutRequestID = stkCallback.CheckoutRequestID;
        
        const transactions = readTransactions();
        const transactionIndex = transactions.findIndex(t => t.checkoutRequestID === checkoutRequestID);
        
        if (transactionIndex !== -1) {
            const transaction = transactions[transactionIndex];
            
            if (stkCallback.ResultCode === 0) {
                // Payment successful
                transaction.status = 'success';
                transaction.mpesaReceiptNumber = stkCallback.CallbackMetadata.Item.find(item => item.Name === 'MpesaReceiptNumber')?.Value;
                transaction.phoneNumber = stkCallback.CallbackMetadata.Item.find(item => item.Name === 'PhoneNumber')?.Value;
                transaction.transactionDate = stkCallback.CallbackMetadata.Item.find(item => item.Name === 'TransactionDate')?.Value;
                
                // Handle referral earnings
                if (transaction.referralId) {
                    const referrals = readReferrals();
                    if (!referrals[transaction.referralId]) {
                        referrals[transaction.referralId] = {
                            earnings: 0,
                            totalEarnings: 0,
                            transactions: []
                        };
                    }
                    
                    const referralEarnings = 10; // 10 KSh per referral
                    referrals[transaction.referralId].earnings += referralEarnings;
                    referrals[transaction.referralId].totalEarnings += referralEarnings;
                    referrals[transaction.referralId].transactions.push({
                        transactionId: transaction.id,
                        amount: referralEarnings,
                        timestamp: new Date().toISOString()
                    });
                    
                    transaction.referralEarnings = referralEarnings;
                    writeReferrals(referrals);
                }
                
                // Send email receipt if email provided
                if (transaction.email) {
                    sendEmailReceipt(transaction.email, transaction);
                }
                
                console.log('Payment successful for transaction:', transaction.id);
            } else {
                // Payment failed
                transaction.status = 'failed';
                transaction.errorMessage = stkCallback.ResultDesc;
                console.log('Payment failed for transaction:', transaction.id);
            }
            
            writeTransactions(transactions);
        }
        
        res.status(200).json({ ResultCode: 0, ResultDesc: "Success" });
    } catch (error) {
        console.error('Callback error:', error);
        res.status(200).json({ ResultCode: 1, ResultDesc: "Error" });
    }
});

// Check transaction status
app.get('/api/transaction/:id', (req, res) => {
    try {
        const transactions = readTransactions();
        const transaction = transactions.find(t => t.id === req.params.id);
        
        if (!transaction) {
            return res.status(404).json({ error: 'Transaction not found' });
        }
        
        res.json(transaction);
    } catch (error) {
        console.error('Transaction status error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Referral endpoints
app.post('/api/referral/generate', (req, res) => {
    try {
        const { userId } = req.body;
        const referralId = userId || uuidv4().slice(0, 8);
        
        const referrals = readReferrals();
        if (!referrals[referralId]) {
            referrals[referralId] = {
                earnings: 0,
                totalEarnings: 0,
                transactions: [],
                createdAt: new Date().toISOString()
            };
            writeReferrals(referrals);
        }
        
        res.json({ referralId, referralLink: `${req.headers.origin || 'https://bera-subscriptions.onrender.com'}?ref=${referralId}` });
    } catch (error) {
        console.error('Referral generation error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.get('/api/referral/:id', (req, res) => {
    try {
        const referrals = readReferrals();
        const referralData = referrals[req.params.id];
        
        if (!referralData) {
            return res.status(404).json({ error: 'Referral not found' });
        }
        
        res.json(referralData);
    } catch (error) {
        console.error('Referral fetch error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Transactions endpoint
app.get('/api/transactions', (req, res) => {
    try {
        const transactions = readTransactions();
        res.json(transactions);
    } catch (error) {
        console.error('Transactions fetch error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Admin login
app.post('/api/login', (req, res) => {
    try {
        const { username, password } = req.body;
        
        if (username === process.env.ADMIN_USERNAME && password === process.env.ADMIN_PASSWORD) {
            const token = jwt.sign({ admin: true }, process.env.JWT_SECRET || 'admin_secret', { expiresIn: '24h' });
            res.json({ success: true, token });
        } else {
            res.status(401).json({ success: false, error: 'Invalid credentials' });
        }
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Payout request
app.post('/api/payout/:ref', (req, res) => {
    try {
        const referrals = readReferrals();
        const referralData = referrals[req.params.ref];
        
        if (!referralData) {
            return res.status(404).json({ error: 'Referral not found' });
        }
        
        const earnings = referralData.earnings;
        const whatsappMessage = `Hi! I want to withdraw my referral earnings of KSh ${earnings}. My referral ID is ${req.params.ref}.`;
        const whatsappUrl = `https://wa.me/254743982206?text=${encodeURIComponent(whatsappMessage)}`;
        
        res.json({ success: true, whatsappUrl, earnings });
    } catch (error) {
        console.error('Payout error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Admin dashboard data
app.get('/api/admin/dashboard', (req, res) => {
    try {
        const transactions = readTransactions();
        const referrals = readReferrals();
        
        const totalSales = transactions
            .filter(t => t.status === 'success')
            .reduce((sum, t) => sum + t.amount, 0);
            
        const totalReferrals = Object.values(referrals)
            .reduce((sum, r) => sum + r.totalEarnings, 0);
            
        const successfulTransactions = transactions.filter(t => t.status === 'success').length;
        const pendingTransactions = transactions.filter(t => t.status === 'pending').length;
        
        res.json({
            totalSales,
            totalReferrals,
            successfulTransactions,
            pendingTransactions,
            totalTransactions: transactions.length
        });
    } catch (error) {
        console.error('Admin dashboard error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.listen(PORT, () => {
    console.log(`Bera Subscriptions server running on port ${PORT}`);
    console.log(`Frontend: http://localhost:${PORT}`);
});
