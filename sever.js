require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 10000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Serve static files from current directory
app.use(express.static(__dirname));

// Request logging middleware
app.use((req, res, next) => {
    console.log(`📥 [${new Date().toISOString()}] ${req.method} ${req.url}`);
    if (req.method === 'POST' && req.body) {
        console.log('Request Body:', JSON.stringify(req.body));
    }
    next();
});

// Simple JSON storage for referrals
const REFERRALS_FILE = 'referrals.json';

function readReferrals() {
    try {
        if (fs.existsSync(REFERRALS_FILE)) {
            const data = fs.readFileSync(REFERRALS_FILE, 'utf8');
            return JSON.parse(data);
        }
    } catch (error) {
        console.error('❌ Error reading referrals:', error);
    }
    return {};
}

function writeReferrals(data) {
    try {
        fs.writeFileSync(REFERRALS_FILE, JSON.stringify(data, null, 2));
        console.log('✅ Referrals data saved');
    } catch (error) {
        console.error('❌ Error writing referrals:', error);
    }
}

// Health check endpoint - TEST THIS FIRST
app.get('/api/health', (req, res) => {
    console.log('✅ Health check passed');
    res.json({ 
        status: 'OK', 
        message: 'Chege Tech API is running perfectly!',
        timestamp: new Date().toISOString(),
        nodejs: true,
        environment: process.env.NODE_ENV || 'development'
    });
});

// Test endpoint
app.get('/api/test', (req, res) => {
    res.json({ 
        message: 'Node.js server is working!',
        server: 'Express.js',
        time: new Date().toISOString()
    });
});

// PayHero STK Push endpoint
app.post('/api/pay', async (req, res) => {
    console.log('💰 Payment request received');
    
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
        } else if (!formattedPhone.startsWith('254')) {
            formattedPhone = '254' + formattedPhone;
        }

        // Validate phone format
        if (!/^254[17]\d{8}$/.test(formattedPhone)) {
            return res.status(400).json({ 
                success: false, 
                message: 'Please enter a valid Kenyan phone number (e.g., 0712345678)' 
            });
        }

        // Validate amount
        const paymentAmount = parseInt(amount);
        if (paymentAmount < 100) {
            return res.status(400).json({ 
                success: false, 
                message: 'Minimum amount is KES 100' 
            });
        }

        console.log(`🔧 Processing payment: ${service} for KES ${amount} to ${formattedPhone}`);

        // DEMO MODE - Always use demo mode for testing
        console.log('🎮 Using DEMO mode (PayHero credentials not required)');
        
        const whatsappText = `Hi%20Chege%20Tech%20Team,%20I%20have%20completed%20my%20payment%20for%20${encodeURIComponent(service)}.%20Phone:%20${formattedPhone}%20Amount:%20KES%20${amount}`;
        const whatsappUrl = `https://wa.me/${process.env.ADMIN_WHATSAPP || '254743982206'}?text=${whatsappText}`;
        
        // Track referral if applicable
        if (referralCode && referralCode !== 'default') {
            const referrals = readReferrals();
            if (!referrals[referralCode]) {
                referrals[referralCode] = { earnings: 0, payments: 0, name: 'Unknown' };
            }
            referrals[referralCode].payments += 1;
            referrals[referralCode].earnings += 10;
            writeReferrals(referrals);
            console.log(`📊 Referral tracked: ${referralCode}`);
        }

        // Simulate processing delay
        await new Promise(resolve => setTimeout(resolve, 2000));

        console.log('✅ Payment processed successfully (Demo Mode)');

        return res.json({
            success: true,
            message: 'STK Push sent successfully! Check your phone to complete M-PESA payment.',
            checkoutRequestID: 'DEMO_' + Date.now(),
            whatsappUrl: whatsappUrl,
            demo: true,
            phone: formattedPhone,
            amount: paymentAmount,
            service: service
        });

    } catch (error) {
        console.error('💥 Payment Processing Error:', error);
        
        return res.status(500).json({
            success: false,
            message: 'Payment processing failed. Please try again.',
            error: error.message
        });
    }
});

// Callback endpoint for PayHero (when you add real credentials later)
app.post('/api/callback', (req, res) => {
    console.log('📞 Payment Callback Received:', req.body);
    res.status(200).json({ status: 'OK', message: 'Callback received' });
});

// Referral stats endpoint
app.get('/api/referral/:code', (req, res) => {
    console.log(`📊 Fetching referral stats for: ${req.params.code}`);
    const referrals = readReferrals();
    const stats = referrals[req.params.code] || { earnings: 0, payments: 0, name: 'Unknown' };
    res.json(stats);
});

// Serve frontend for all other routes - THIS MUST BE LAST
app.get('*', (req, res) => {
    console.log(`🌐 Serving frontend for: ${req.url}`);
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Error handling middleware
app.use((error, req, res, next) => {
    console.error('💥 Global Error Handler:', error);
    res.status(500).json({ 
        success: false, 
        message: 'Something went wrong!',
        error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
    console.log('\n✨ ====================================');
    console.log('🚀 CHEGE TECH SERVER STARTED SUCCESSFULLY!');
    console.log('✨ ====================================');
    console.log(`📍 Port: ${PORT}`);
    console.log(`🌐 Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`🔗 Local URL: http://localhost:${PORT}`);
    console.log(`🔗 Render URL: https://your-service-name.onrender.com`);
    console.log('📋 Available Endpoints:');
    console.log('   GET  /api/health - Health check');
    console.log('   GET  /api/test - Test endpoint');
    console.log('   POST /api/pay - Process payment');
    console.log('   POST /api/callback - Payment callback');
    console.log('   GET  /api/referral/:code - Referral stats');
    console.log('✨ ====================================\n');
});

// Handle graceful shutdown
process.on('SIGTERM', () => {
    console.log('🛑 SIGTERM received, shutting down gracefully');
    process.exit(0);
});
