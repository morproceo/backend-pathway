/**
 * Seed Admin User
 * Run with: node src/seeders/seedAdmin.js
 */

require('dotenv').config();
const db = require('../models');

async function seedAdmin() {
  try {
    console.log('Connecting to database...');
    await db.sequelize.authenticate();
    console.log('Connected successfully!');

    // Sync models
    await db.sequelize.sync({ alter: true });
    console.log('Database synced!');

    // Check if admin exists
    const existingAdmin = await db.User.findOne({
      where: { email: 'admin@jrmlgroup.com' }
    });

    if (existingAdmin) {
      console.log('Admin user already exists!');
      console.log('Email: admin@jrmlgroup.com');
    } else {
      // Create admin user
      const admin = await db.User.create({
        email: 'admin@jrmlgroup.com',
        password: 'JRMLAdmin2024!',
        firstName: 'Admin',
        lastName: 'User',
        role: 'admin',
        isActive: true
      });

      console.log('Admin user created successfully!');
      console.log('Email: admin@jrmlgroup.com');
      console.log('Password: JRMLAdmin2024!');
    }

    // Create test driver if not exists
    const existingDriver = await db.User.findOne({
      where: { email: 'driver@test.com' }
    });

    if (existingDriver) {
      console.log('\nTest driver already exists!');
      console.log('Email: driver@test.com');
    } else {
      const driver = await db.User.create({
        email: 'driver@test.com',
        password: 'driver123',
        firstName: 'John',
        lastName: 'Driver',
        phone: '555-123-4567',
        role: 'driver',
        isActive: true
      });

      console.log('\nTest driver created successfully!');
      console.log('Email: driver@test.com');
      console.log('Password: driver123');
    }

    console.log('\n✅ Seeding complete!');
    process.exit(0);
  } catch (error) {
    console.error('Error seeding database:', error);
    process.exit(1);
  }
}

seedAdmin();
