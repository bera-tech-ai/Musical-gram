// server.js
import express from "express";
import axios from "axios";
import dotenv from "dotenv";
import sqlite3 from "sqlite3";
import { open } from "sqlite";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());
app.use(express.static(__dirname));

const PORT = process.env.PORT || 5000;

// ✅ Connect to SQLite (stores transactions & referrals)
let db;
(async () => {
  db = await open({
    filename: "./chege_subscriptions.db",
    driver: sqlite3.Database,
  });

  await db.exec(`
    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      service TEXT,
      amount INTEGER,
      phone TEXT,
      ref TEXT,
      status TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS referrals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ref_code TEXT,
      earnings INTEGER DEFAULT 0
    );
  `);
})();

// ✅ Route — Payment initiation via PayHero
app.post("/api/pay", async (req, res) => {
  const { service, amount, phone, ref } = req.body;
  if (!service || !amount || !phone)
    return res.json({ success: false, message: "Missing payment details." });

  try {
    const payload = {
      amount,
      account_number: "ChegeTechSubs",
      phone_number: phone,
      narrative: `Subscription for ${service}`,
      callback_url: `${process.env.BASE_URL}/api/callback`,
    };

    const headers = {
      "Content-Type": "application/json",
      "X-API-KEY": process.env.PAYHERO_API_KEY,
      "X-API-SECRET": process.env.PAYHERO_API_SECRET,
      "X-MERCHANT-ID": process.env.PAYHERO_MERCHANT_ID,
    };

    const response = await axios.post(
      `${process.env.PAYHERO_BASE_URL}/mobile-money/mpesa/stk/push`,
      payload,
      { headers }
    );

    if (response.data.status === true) {
      await db.run(
        "INSERT INTO transactions (service, amount, phone, ref, status) VALUES (?, ?, ?, ?, ?)",
        [service, amount, phone, ref || "none", "pending"]
      );

      res.json({
        success: true,
        message: "Payment initiated successfully.",
      });
    } else {
      res.json({ success: false, message: response.data.message });
    }
  } catch (error) {
    console.error("PayHero error:", error.response?.data || error.message);
    res.json({ success: false, message: "Failed to initiate payment." });
  }
});

// ✅ PayHero Callback
app.post("/api/callback", async (req, res) => {
  try {
    const { status, amount, narrative, phone_number } = req.body;

    if (status === "SUCCESS") {
      await db.run(
        "UPDATE transactions SET status = ? WHERE phone = ? AND amount = ? AND status = 'pending'",
        ["success", phone_number, amount]
      );

      // Referral reward
      const refRow = await db.get("SELECT * FROM referrals WHERE ref_code = ?", [
        narrative,
      ]);
      if (refRow) {
        await db.run(
          "UPDATE referrals SET earnings = earnings + 10 WHERE ref_code = ?",
          [narrative]
        );
      }

      // Redirect user to WhatsApp for confirmation
      return res.redirect("https://wa.me/254743982206");
    } else {
      await db.run(
        "UPDATE transactions SET status = ? WHERE phone = ? AND amount = ? AND status = 'pending'",
        ["failed", phone_number, amount]
      );
      return res.sendStatus(200);
    }
  } catch (error) {
    console.error("Callback error:", error.message);
    res.sendStatus(500);
  }
});

// ✅ Referral link creation
app.get("/api/referral/:code", async (req, res) => {
  const { code } = req.params;
  if (!code) return res.json({ success: false });
  await db.run(
    "INSERT OR IGNORE INTO referrals (ref_code, earnings) VALUES (?, 0)",
    [code]
  );
  res.json({ success: true, message: "Referral link registered." });
});

// ✅ View referral earnings
app.get("/api/referrals", async (req, res) => {
  const rows = await db.all("SELECT * FROM referrals");
  res.json(rows);
});

// ✅ Fallback route to serve index.html
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.listen(PORT, () =>
  console.log(`🚀 Chege Tech Subscriptions running on port ${PORT}`)
);
