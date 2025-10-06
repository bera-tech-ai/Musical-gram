require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static('public'));

// Data storage files
const TRANSACTIONS_FILE = 'transactions.json';
const REFERRALS_FILE = 'referrals.json';

// Initialize data files if they don't exist
const initializeFiles = () => {
  if (!fs.existsSync(TRANSACTIONS_FILE)) {
    fs.writeFileSync(TRANSACTIONS_FILE, JSON.stringify([]));
  }
  if (!fs.existsSync(REFERRALS_FILE)) {
    fs.writeFileSync(REFERRALS_FILE, JSON.stringify({}));
  }
};

initializeFiles();

// Helper functions to read/write data
const readTransactions = () => {
  try {
    const data = fs.readFileSync(TRANSACTIONS_FILE, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    return [];
  }
};

const writeTransactions = (data) => {
  fs.writeFileSync(TRANSACTIONS_FILE, JSON.stringify(data, null, 2));
};

const readReferrals = () => {
  try {
    const data = fs.readFileSync(REFERRALS_FILE, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    return {};
  }
};

const writeReferrals = (data) => {
  fs.writeFileSync(REFERRALS_FILE, JSON.stringify(data, null, 2));
};

// Serve homepage
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Generate referral code
app.post('/api/generate-referral', (req, res) => {
  const { username } = req.body;
  
  if (!username) {
    return res.status(400).json({ error: 'Username is required' });
  }

  const referrals = readReferrals();
  
  if (!referrals[username]) {
    referrals[username] = {
      code: username,
      earnings: 0,
      referredUsers: [],
      createdAt: new Date().toISOString()
    };
    writeReferrals(referrals);
  }

  res.json({
    referralLink: `https://chegetech.onrender.com/?ref=${username}`,
    earnings: referrals[username].earnings
  });
});

// Get referral data
app.get('/api/referral/:username', (req, res) => {
  const { username } = req.params;
  const referrals = readReferrals();
  
  if (referrals[username]) {
    res.json(referrals[username]);
  } else {
    res.status(404).json({ error: 'Referral not found' });
  }
});

// Process payment
app.post('/api/initiate-payment', async (req, res) => {
  const { service, duration, phoneNumber, amount, referralCode } = req.body;
  
  try {
    // In test mode, we'll simulate payment success
    // In production, you would use actual PayHero API calls
    
    const transactionId = 'TXN_' + Date.now();
    const transaction = {
      id: transactionId,
      service,
      duration,
      phoneNumber,
      amount,
      status: 'completed', // Simulating success in test mode
      timestamp: new Date().toISOString(),
      referralCode
    };

    // Save transaction
    const transactions = readTransactions();
    transactions.push(transaction);
    writeTransactions(transactions);

    // Process referral if applicable
    if (referralCode) {
      const referrals = readReferrals();
      if (referrals[referralCode]) {
        referrals[referralCode].earnings += 10;
        referrals[referralCode].referredUsers.push({
          phoneNumber,
          amount,
          timestamp: new Date().toISOString()
        });
        writeReferrals(referrals);
      }
    }

    res.json({
      success: true,
      transactionId,
      message: 'Payment initiated successfully'
    });

  } catch (error) {
    console.error('Payment error:', error);
    res.status(500).json({
      success: false,
      error: 'Payment processing failed'
    });
  }
});

// Get user stats
app.get('/api/user-stats/:phoneNumber', (req, res) => {
  const { phoneNumber } = req.params;
  const transactions = readTransactions();
  
  const userTransactions = transactions.filter(t => t.phoneNumber === phoneNumber);
  const totalSpent = userTransactions.reduce((sum, t) => sum + t.amount, 0);
  
  res.json({
    totalTransactions: userTransactions.length,
    totalSpent,
    lastTransaction: userTransactions[userTransactions.length - 1] || null
  });
});

app.listen(PORT, () => {
  console.log(`Chege Tech server running on port ${PORT}`);
  console.log(`Visit: http://localhost:${PORT}`);
});
