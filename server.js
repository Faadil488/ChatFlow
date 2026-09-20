require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const db = require('./db');
const cron = require('node-cron');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware to parse JSON payloads
app.use(express.json());

/**
 * Sends a WhatsApp text message using the WhatsApp Cloud Graph API.
 *
 * @param {string} to - Recipient phone number with country code (e.g. "15551234567")
 * @param {string} text - The message text to send
 */
async function sendMessage(to, text) {
  const { PHONE_NUMBER_ID, WHATSAPP_TOKEN } = process.env;

  if (!PHONE_NUMBER_ID || !WHATSAPP_TOKEN) {
    console.warn('[sendMessage] Missing PHONE_NUMBER_ID or WHATSAPP_TOKEN in environment variables.');
    return;
  }

  const url = `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`;

  try {
    const response = await axios.post(
      url,
      {
        messaging_product: 'whatsapp',
        to: to,
        type: 'text',
        text: { body: text }
      },
      {
        headers: {
          'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    );

    console.log(`[sendMessage] Message successfully sent to ${to}:`, response.data);
    return response.data;
  } catch (error) {
    console.error(`[sendMessage] Failed to send message to ${to}:`, error.response?.data || error.message);
  }
}

/**
 * Classifies user intent and extracts transaction details using @google/generative-ai.
 * Keeps the Gemini API call completely isolated inside this function so the provider can be replaced later.
 *
 * @param {string} text - Incoming WhatsApp message text
 * @returns {Promise<{intent: "log_transaction"|"query_balance"|"mark_paid", customer_name: string|null, amount: number|null, type: "credit"|"payment"|null}|null>}
 */
async function classifyAndExtract(text) {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    console.error('[classifyAndExtract] Missing GEMINI_API_KEY in environment variables.');
    return null;
  }

  const prompt = `You are an AI assistant for a store ledger system.
Classify the following user message into exactly ONE of these intents:

- "log_transaction": Use this when the user gives a specific transaction amount to record, including a specific payment.
  Examples:
  * "Alice paid 100 rupees"
  * "Alice gave me 200"
  * "Alice took 500 on credit"
  * "Record a payment of ₹300 from Alice"

- "query_balance": The user wants to check how much a customer owes or their current balance.
  Examples:
  * "How much does Alice owe me?"
  * "What is Alice's balance?"
  * "Check balance for Alice"

- "mark_paid": Use this ONLY when the user says the customer has completely settled/cleared their outstanding dues without giving a specific transaction amount.
  Examples:
  * "Alice cleared her dues"
  * "Alice settled her account"
  * "Alice has paid everything"
  * "Mark Alice as fully paid"

Important rule:
If a specific amount is provided, ALWAYS classify it as "log_transaction", even if the message contains words like "paid", "settled", or "cleared".

Extract the following information where relevant:
- customer_name: The name of the customer (string), or null if not mentioned.
- amount: The monetary amount (number), or null if not mentioned.
- type: Either "credit" or "payment" (string), or null if not applicable.

You MUST respond ONLY with a valid JSON object matching this schema:
{
  "intent": "log_transaction" | "query_balance" | "mark_paid",
  "customer_name": string | null,
  "amount": number | null,
  "type": "credit" | "payment" | null
}

Do not include any explanations, markdown formatting, or text outside the JSON object.

User message: "${text}"`;

  try {
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({
      model: process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite',
      generationConfig: {
        responseMimeType: 'application/json',
        temperature: 0
      }
    });

    let result;
    try {
      result = await model.generateContent(prompt);
    } catch (apiErr) {
      if (apiErr.message && (apiErr.message.includes('503') || apiErr.message.includes('high demand'))) {
        console.warn('[classifyAndExtract] Temporary 503 spike, retrying once...');
        await new Promise((resolve) => setTimeout(resolve, 1500));
        result = await model.generateContent(prompt);
      } else {
        throw apiErr;
      }
    }

    let rawText = result.response.text();

    // Strip markdown code fences if present (e.g. ```json ... ``` or ``` ... ```)
    rawText = rawText.replace(/```(?:json)?\n?/gi, '').replace(/```\s*$/gi, '').trim();

    try {
      const parsed = JSON.parse(rawText);
      return parsed;
    } catch (parseError) {
      console.error('[classifyAndExtract] Failed to parse JSON response:', parseError.message, 'Raw response:', rawText);
      return null;
    }
  } catch (error) {
    console.error('[classifyAndExtract] Error calling Gemini API:', error.message);
    return null;
  }
}

/**
 * GET /webhook
 * Verification endpoint for webhook subscription
 * Checks hub.mode, hub.verify_token against process.env.VERIFY_TOKEN,
 * and responds with hub.challenge.
 */
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  // Check if a token and mode were sent
  if (mode && token) {
    // Check mode is 'subscribe' and token matches the configured environment variable
    if (mode === 'subscribe' && token === process.env.VERIFY_TOKEN) {
      console.log('[GET /webhook] Webhook verified successfully.');
      return res.status(200).send(challenge);
    } else {
      console.warn('[GET /webhook] Verification failed. Token or mode mismatch.');
      return res.sendStatus(403);
    }
  }

  // Missing query parameters
  return res.status(400).send('Missing required query parameters: hub.mode, hub.verify_token, hub.challenge');
});

// In-memory store for pending transactions awaiting confirmation
// Format: senderPhoneNumber -> { customer_name, amount, type }
const pendingTransactions = new Map();

/**
 * POST /webhook
 * Webhook event handler
 *
 * WhatsApp Cloud API Webhook JSON Payload Structure:
 * ----------------------------------------------------
 * {
 *   "object": "whatsapp_business_account",
 *   "entry": [
 *     {
 *       "id": "WHATSAPP_BUSINESS_ACCOUNT_ID",
 *       "changes": [
 *         {
 *           "value": {
 *             "messaging_product": "whatsapp",
 *             "metadata": {
 *               "display_phone_number": "15550253483",
 *               "phone_number_id": "PHONE_NUMBER_ID"
 *             },
 *             "contacts": [
 *               {
 *                 "profile": { "name": "John Doe" },
 *                 "wa_id": "15551234567"
 *               }
 *             ],
 *             "messages": [
 *               {
 *                 "from": "15551234567",       // Sender's phone number
 *                 "id": "wamid.HBgL...",       // Unique message ID
 *                 "timestamp": "1710000000",   // Unix timestamp
 *                 "type": "text",              // Type of message (text, image, etc.)
 *                 "text": {
 *                   "body": "hi"               // The actual text message content
 *                 }
 *               }
 *             ]
 *           },
 *           "field": "messages"
 *         }
 *       ]
 *     }
 *   ]
 * }
 */
app.post('/webhook', async (req, res) => {
  // Always acknowledge receipt immediately with 200 OK to satisfy Meta's webhook timeout requirements
  res.sendStatus(200);

  console.log('[POST /webhook] Webhook event received:');
  console.log(JSON.stringify(req.body, null, 2));

  // Safely extract incoming message details using optional chaining
  const message = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];

  if (message) {
    const senderNumber = message.from;
    const messageType = message.type;

    // Check if the message is a text message
    if (messageType === 'text') {
      const messageText = message.text?.body;
      console.log(`[POST /webhook] Received text from ${senderNumber}: "${messageText}"`);

      const trimmedText = messageText ? messageText.trim() : '';

      // 1. Keep existing "hi" -> "hello" behavior working
      if (trimmedText.toLowerCase() === 'hi') {
        console.log(`[POST /webhook] Replying 'hello' to ${senderNumber}...`);
        await sendMessage(senderNumber, 'hello');
        return;
      }

      // 2. Handle "YES" confirmation for pending transactions
      if (trimmedText.toLowerCase() === 'yes') {
        // Check whether this specific sender has a pending transaction waiting
        const pending = pendingTransactions.get(senderNumber);

        if (!pending) {
          await sendMessage(senderNumber, 'There is no pending transaction to confirm.');
          return;
        }

        try {
          // Find or create the shop associated with this sender's phone number
          let shopRes = await db.query('SELECT id FROM shops WHERE phone_number = $1', [senderNumber]);
          let shopId;

          if (shopRes.rows.length === 0) {
            const newShop = await db.query(
              'INSERT INTO shops (phone_number, name) VALUES ($1, $2) RETURNING id',
              [senderNumber, 'My Shop']
            );
            shopId = newShop.rows[0].id;
          } else {
            shopId = shopRes.rows[0].id;
          }

          // Find or create the customer under this shop
          let custRes = await db.query(
            'SELECT id, name FROM customers WHERE shop_id = $1 AND LOWER(name) = LOWER($2)',
            [shopId, pending.customer_name]
          );
          let customerId;
          let customerName;

          if (custRes.rows.length === 0) {
            const newCust = await db.query(
              'INSERT INTO customers (shop_id, name) VALUES ($1, $2) RETURNING id, name',
              [shopId, pending.customer_name]
            );
            customerId = newCust.rows[0].id;
            customerName = newCust.rows[0].name;
          } else {
            customerId = custRes.rows[0].id;
            customerName = custRes.rows[0].name;
          }

          // Insert the confirmed transaction into the database
          await db.query(
            'INSERT INTO transactions (customer_id, amount, type) VALUES ($1, $2, $3)',
            [customerId, pending.amount, pending.type]
          );

          // Clear the pending transaction after a successful insert
          pendingTransactions.delete(senderNumber);

          // Reply confirming it was successfully saved
          const confirmationReply = `Confirmed! Successfully recorded a ${pending.type} of ₹${pending.amount} for ${customerName}.`;
          await sendMessage(senderNumber, confirmationReply);
        } catch (dbError) {
          console.error('[POST /webhook] Error saving confirmed transaction:', dbError.message);
          await sendMessage(
            senderNumber,
            'Sorry, an error occurred while saving your transaction. Please try again.'
          );
        }

        return;
      }

      // 3. Classify intent and extract details using Gemini
      const result = await classifyAndExtract(messageText);

      // 4. If null, send failure reply
      if (!result) {
        await sendMessage(senderNumber, "Sorry, I couldn't understand that. Please try again.");
        return;
      }

      const customerName = result.customer_name || 'customer';

      // 5. Branch based on intent
      switch (result.intent) {
        case 'log_transaction': {
          // Check that all required fields are present
          if (!result.customer_name || result.amount == null || !result.type) {
            await sendMessage(
              senderNumber,
              "I need the customer name, amount, and whether this is a credit or payment. Please provide those details."
            );
            break;
          }

          // Store the pending transaction temporarily in memory for this sender
          // Do NOT insert anything into PostgreSQL yet
          pendingTransactions.set(senderNumber, {
            customer_name: result.customer_name,
            amount: result.amount,
            type: result.type
          });

          // Ask the user to reply YES to confirm
          const confirmationText = `Please confirm: Log a ${result.type} of ₹${result.amount} for ${result.customer_name}? Reply with YES to confirm.`;
          await sendMessage(senderNumber, confirmationText);
          break;
        }

        case 'query_balance': {
          // If no customer name was extracted, ask for clarification
          if (!result.customer_name) {
            await sendMessage(
              senderNumber,
              "Please specify whose balance you would like to check (e.g. 'How much does Alice owe me?')."
            );
            break;
          }

          try {
            // 1. Find the shop associated with the sender's phone number
            const shopRes = await db.query(
              'SELECT id FROM shops WHERE phone_number = $1',
              [senderNumber]
            );

            if (shopRes.rows.length === 0) {
              await sendMessage(
                senderNumber,
                `Customer "${result.customer_name}" was not found.`
              );
              break;
            }

            const shopId = shopRes.rows[0].id;

            // 2. Find the customer by name within that shop (case-insensitively)
            const custRes = await db.query(
              'SELECT id, name FROM customers WHERE shop_id = $1 AND LOWER(name) = LOWER($2)',
              [shopId, result.customer_name]
            );

            if (custRes.rows.length === 0) {
              await sendMessage(
                senderNumber,
                `Customer "${result.customer_name}" was not found.`
              );
              break;
            }

            const customer = custRes.rows[0];

            // 3. Calculate balance: credits add, payments subtract
            // Returns 0 if there are no transactions
            const balanceRes = await db.query(
              `SELECT 
                 COALESCE(
                   SUM(
                     CASE 
                       WHEN type = 'credit' THEN amount
                       WHEN type = 'payment' THEN -amount
                       ELSE 0
                     END
                   ), 
                   0
                 ) AS balance
               FROM transactions
               WHERE customer_id = $1`,
              [customer.id]
            );

            const balanceNum = parseFloat(balanceRes.rows[0].balance);
            const displayAmount = balanceNum % 1 === 0 ? balanceNum : balanceNum.toFixed(2);

            // 4. Natural language response based on balance
            if (balanceNum > 0) {
              await sendMessage(senderNumber, `${customer.name} owes you ₹${displayAmount}.`);
            } else if (balanceNum === 0) {
              await sendMessage(senderNumber, `${customer.name} has no outstanding balance.`);
            } else {
              const advanceAmount = Math.abs(balanceNum);
              const displayAdvance = advanceAmount % 1 === 0 ? advanceAmount : advanceAmount.toFixed(2);
              await sendMessage(
                senderNumber,
                `${customer.name} has an advance balance of ₹${displayAdvance} (paid more than recorded credits).`
              );
            }
          } catch (dbError) {
            console.error('[POST /webhook] Error querying balance:', dbError.message);
            await sendMessage(
              senderNumber,
              'Sorry, an error occurred while looking up the balance. Please try again.'
            );
          }
          break;
        }

        case 'mark_paid': {
          // 1. Validate that customer_name exists
          if (!result.customer_name) {
            await sendMessage(
              senderNumber,
              "Please specify which customer has paid (e.g. 'Alice cleared her dues')."
            );
            break;
          }

          try {
            // 2. Find the shop associated with the sender's phone number
            const shopRes = await db.query(
              'SELECT id FROM shops WHERE phone_number = $1',
              [senderNumber]
            );

            if (shopRes.rows.length === 0) {
              await sendMessage(
                senderNumber,
                `Customer "${result.customer_name}" was not found.`
              );
              break;
            }

            const shopId = shopRes.rows[0].id;

            // 3. Find the customer by name within that shop (case-insensitively)
            const custRes = await db.query(
              'SELECT id, name FROM customers WHERE shop_id = $1 AND LOWER(name) = LOWER($2)',
              [shopId, result.customer_name]
            );

            if (custRes.rows.length === 0) {
              await sendMessage(
                senderNumber,
                `Customer "${result.customer_name}" was not found.`
              );
              break;
            }

            const customer = custRes.rows[0];

            // 4. Determine the customer's current outstanding balance
            const balanceRes = await db.query(
              `SELECT 
                 COALESCE(
                   SUM(
                     CASE 
                       WHEN type = 'credit' THEN amount
                       WHEN type = 'payment' THEN -amount
                       ELSE 0
                     END
                   ), 
                   0
                 ) AS balance
               FROM transactions
               WHERE customer_id = $1`,
              [customer.id]
            );

            const currentBalance = parseFloat(balanceRes.rows[0].balance);

            // 5. If customer has no outstanding balance to settle
            if (currentBalance <= 0) {
              await sendMessage(
                senderNumber,
                `${customer.name} has no outstanding balance to settle.`
              );
              break;
            }

            // 6. Payment amount defaults to the full outstanding balance to clear all dues,
            // unless a specific partial amount was explicitly specified in the message
            const isNumericAmount = typeof result.amount === 'number' && !isNaN(result.amount) && result.amount > 0;
            const paymentAmount = isNumericAmount ? result.amount : currentBalance;

            // 7. Store pending confirmation in memory (reusing pendingTransactions)
            // Do NOT insert into PostgreSQL yet
            pendingTransactions.set(senderNumber, {
              customer_name: customer.name,
              amount: paymentAmount,
              type: 'payment'
            });

            const displayBalance = currentBalance % 1 === 0 ? currentBalance : currentBalance.toFixed(2);
            const displayPayment = paymentAmount % 1 === 0 ? paymentAmount : paymentAmount.toFixed(2);

            // 8. Ask for confirmation before saving
            const confirmationText = paymentAmount < currentBalance
              ? `${customer.name} currently owes you ₹${displayBalance}. Record a payment of ₹${displayPayment}? Reply with YES to confirm.`
              : `${customer.name} currently owes you ₹${displayBalance}. Record a payment of ₹${displayPayment} to settle the balance? Reply with YES to confirm.`;
            await sendMessage(senderNumber, confirmationText);
          } catch (dbError) {
            console.error('[POST /webhook] Error handling mark_paid:', dbError.message);
            await sendMessage(
              senderNumber,
              'Sorry, an error occurred while processing the settlement request. Please try again.'
            );
          }
          break;
        }

        default: {
          await sendMessage(senderNumber, "Sorry, I couldn't understand that. Please try again.");
          break;
        }
      }
    }
  } else {
    // Check if the webhook event was a delivery status update (sent, delivered, read)
    const status = req.body?.entry?.[0]?.changes?.[0]?.value?.statuses?.[0];
    if (status) {
      console.log(`[POST /webhook] Delivery status update: "${status.status}" for message ${status.id}`);
    }
  }
});

// ============================================================================
// Scheduled Cron Jobs (Asia/Kolkata)
// ============================================================================

/**
 * Daily Summary Job
 * Runs every day at 8:00 PM (Asia/Kolkata timezone).
 * Loops through all shops, calculates today's total credit given and total payments received,
 * and sends each shop owner a WhatsApp summary message using sendMessage().
 * Does NOT send to customers.
 */
async function sendDailySummary() {
  console.log('[Cron: Daily Summary] Running 8:00 PM daily summary job (Asia/Kolkata)...');
  try {
    const query = `
      SELECT 
        s.id AS shop_id,
        s.phone_number,
        s.name AS shop_name,
        COALESCE(SUM(CASE WHEN t.type = 'credit' THEN t.amount ELSE 0 END), 0) AS total_credit,
        COALESCE(SUM(CASE WHEN t.type = 'payment' THEN t.amount ELSE 0 END), 0) AS total_payment,
        COUNT(t.id) AS transaction_count
      FROM shops s
      LEFT JOIN customers c ON c.shop_id = s.id
      LEFT JOIN transactions t ON t.customer_id = c.id 
        AND (t.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata')::date = (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date
      WHERE s.phone_number IS NOT NULL
      GROUP BY s.id, s.phone_number, s.name
      ORDER BY s.id ASC
    `;

    const res = await db.query(query);
    const shops = res.rows;

    if (shops.length === 0) {
      console.log('[Cron: Daily Summary] No registered shops with phone numbers found.');
      return;
    }

    console.log(`[Cron: Daily Summary] Processing summaries for ${shops.length} shop(s)...`);

    for (const shop of shops) {
      const totalCredit = parseFloat(shop.total_credit);
      const totalPayment = parseFloat(shop.total_payment);
      const count = parseInt(shop.transaction_count, 10);

      const displayCredit = totalCredit % 1 === 0 ? totalCredit : totalCredit.toFixed(2);
      const displayPayment = totalPayment % 1 === 0 ? totalPayment : totalPayment.toFixed(2);

      const summaryMessage =
        `📊 *Daily Summary - ${shop.shop_name || 'My Shop'}*\n\n` +
        `💰 *Credit Given Today:* ₹${displayCredit}\n` +
        `💵 *Payments Received Today:* ₹${displayPayment}\n\n` +
        (count > 0
          ? `Total transactions recorded today: ${count}`
          : `No transactions were recorded today.`);

      try {
        const sent = await sendMessage(shop.phone_number, summaryMessage);
        if (sent) {
          console.log(`[Cron: Daily Summary] Successfully sent summary to shop "${shop.shop_name}" (${shop.phone_number}).`);
        } else {
          console.warn(`[Cron: Daily Summary] Could not deliver summary to shop "${shop.shop_name}" (${shop.phone_number}).`);
        }
      } catch (sendError) {
        console.error(`[Cron: Daily Summary] Failed to send summary to shop "${shop.shop_name}" (${shop.phone_number}):`, sendError.message);
      }
    }

    console.log('[Cron: Daily Summary] Daily summary job completed.');
  } catch (error) {
    console.error('[Cron: Daily Summary] Database query error during daily summary job:', error.message);
  }
}

/**
 * Weekly Monday Reminder Job
 * Runs every Monday at 10:00 AM (Asia/Kolkata timezone).
 * Finds all customers with a current balance > 0, groups them by shop,
 * and sends each shop owner a WhatsApp reminder listing the customers who owe money and how much they owe.
 * Does NOT message customers directly.
 */
async function sendWeeklyMondayReminders() {
  console.log('[Cron: Monday Reminder] Running 10:00 AM weekly outstanding dues reminder (Asia/Kolkata)...');
  try {
    const query = `
      SELECT 
        s.id AS shop_id,
        s.phone_number AS shop_phone,
        s.name AS shop_name,
        c.id AS customer_id,
        c.name AS customer_name,
        COALESCE(
          SUM(
            CASE 
              WHEN t.type = 'credit' THEN t.amount 
              WHEN t.type = 'payment' THEN -t.amount 
              ELSE 0 
            END
          ), 
          0
        ) AS balance
      FROM shops s
      JOIN customers c ON c.shop_id = s.id
      LEFT JOIN transactions t ON t.customer_id = c.id
      WHERE s.phone_number IS NOT NULL
      GROUP BY s.id, s.phone_number, s.name, c.id, c.name
      HAVING COALESCE(
        SUM(
          CASE 
            WHEN t.type = 'credit' THEN t.amount 
            WHEN t.type = 'payment' THEN -t.amount 
            ELSE 0 
          END
        ), 
        0
      ) > 0
      ORDER BY s.id ASC, balance DESC, c.name ASC
    `;

    const res = await db.query(query);

    if (res.rows.length === 0) {
      console.log('[Cron: Monday Reminder] No customers with outstanding balance found across any shop.');
      return;
    }

    // Group customers with outstanding balance by shop
    const shopsMap = new Map();
    for (const row of res.rows) {
      if (!shopsMap.has(row.shop_id)) {
        shopsMap.set(row.shop_id, {
          shopId: row.shop_id,
          shopName: row.shop_name || 'My Shop',
          phone: row.shop_phone,
          customers: []
        });
      }
      shopsMap.get(row.shop_id).customers.push({
        name: row.customer_name,
        balance: parseFloat(row.balance)
      });
    }

    console.log(`[Cron: Monday Reminder] Sending reminders to ${shopsMap.size} shop(s) with outstanding dues...`);

    for (const shop of shopsMap.values()) {
      let message = `📋 *Weekly Outstanding Dues Reminder - ${shop.shopName}*\n\nHere are the customers who currently owe money:\n\n`;
      let totalOutstanding = 0;

      for (const customer of shop.customers) {
        const formattedBalance = customer.balance % 1 === 0 ? customer.balance : customer.balance.toFixed(2);
        message += `• *${customer.name}*: ₹${formattedBalance}\n`;
        totalOutstanding += customer.balance;
      }

      const formattedTotal = totalOutstanding % 1 === 0 ? totalOutstanding : totalOutstanding.toFixed(2);
      message += `\n*Total Outstanding Balance:* ₹${formattedTotal}`;

      try {
        const sent = await sendMessage(shop.phone, message);
        if (sent) {
          console.log(`[Cron: Monday Reminder] Successfully sent reminder to shop "${shop.shopName}" (${shop.phone}) for ${shop.customers.length} customer(s).`);
        } else {
          console.warn(`[Cron: Monday Reminder] Could not deliver reminder to shop "${shop.shopName}" (${shop.phone}).`);
        }
      } catch (sendError) {
        console.error(`[Cron: Monday Reminder] Failed to send reminder to shop "${shop.shopName}" (${shop.phone}):`, sendError.message);
      }
    }

    console.log('[Cron: Monday Reminder] Weekly reminder job completed.');
  } catch (error) {
    console.error('[Cron: Monday Reminder] Database query error during weekly reminder job:', error.message);
  }
}

// Register scheduled cron tasks
// 1. Daily at 8:00 PM (20:00) Asia/Kolkata
cron.schedule('* * * * *', sendDailySummary, {
  scheduled: true,
  timezone: 'Asia/Kolkata'
});

// 2. Weekly on Monday at 10:00 AM (10:00) Asia/Kolkata
cron.schedule('0 10 * * 1', sendWeeklyMondayReminders, {
  scheduled: true,
  timezone: 'Asia/Kolkata'
});

// Start the server
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
    console.log(`- Webhook verification: GET  http://localhost:${PORT}/webhook`);
    console.log(`- Webhook receiver:     POST http://localhost:${PORT}/webhook`);
  });
}

module.exports = {
  app,
  sendMessage,
  classifyAndExtract,
  sendDailySummary,
  sendWeeklyMondayReminders
};
