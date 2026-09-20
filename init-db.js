require('dotenv').config();
const { pool } = require('./db');

async function createShopsTable() {
  if (!process.env.DATABASE_URL) {
    console.error('Error: DATABASE_URL is not defined in your environment variables.');
    process.exit(1);
  }

  const createTableQuery = `
    CREATE TABLE IF NOT EXISTS shops (
      id SERIAL PRIMARY KEY,
      phone_number TEXT UNIQUE,
      name TEXT
    );
  `;

  try {
    console.log('Connecting to PostgreSQL database...');
    await pool.query(createTableQuery);
    console.log('Success: "shops" table created or already exists.');
  } catch (error) {
    console.error('Failed to create "shops" table:', error.message);
  } finally {
    // Close the pool cleanly so the script terminates
    await pool.end();
  }
}

createShopsTable();
