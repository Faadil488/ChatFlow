require('dotenv').config();
const { pool } = require('./db');

async function initDatabase() {
  if (!process.env.DATABASE_URL) {
    console.error('Error: DATABASE_URL is not defined in your environment variables.');
    process.exit(1);
  }

  const createTablesQuery = `
    -- 1. Shops table
    CREATE TABLE IF NOT EXISTS shops (
      id SERIAL PRIMARY KEY,
      phone_number TEXT UNIQUE,
      name TEXT
    );

    -- 2. Customers table (references shops)
    CREATE TABLE IF NOT EXISTS customers (
      id SERIAL PRIMARY KEY,
      shop_id INTEGER REFERENCES shops(id) ON DELETE CASCADE,
      name TEXT NOT NULL
    );

    -- 3. Transactions table (references customers, amount, type check, created_at)
    CREATE TABLE IF NOT EXISTS transactions (
      id SERIAL PRIMARY KEY,
      customer_id INTEGER REFERENCES customers(id) ON DELETE CASCADE,
      amount NUMERIC(10, 2) NOT NULL,
      type TEXT CHECK (type IN ('credit', 'payment')) NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `;

  try {
    console.log('Connecting to PostgreSQL database...');
    await pool.query(createTablesQuery);
    console.log('Success: "shops", "customers", and "transactions" tables created or already exist.');
  } catch (error) {
    console.error('Failed to initialize database tables:', error.message);
  } finally {
    // Close the pool cleanly so the script terminates
    await pool.end();
  }
}

initDatabase();
