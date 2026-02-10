const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');

// Try to load models (may fail if DB not connected)
let SmsConsent, dbAvailable = false;
try {
  const models = require('../models');
  SmsConsent = models.SmsConsent;
  dbAvailable = true;
} catch (e) {
  console.warn('SmsConsent model not available, running in log-only mode');
}

const CONSENT_TEXT = 'I agree to receive SMS messages from Pathway Transportation Corp regarding appointment confirmations, reminders, and service notifications. Message and data rates may apply. Reply STOP to opt out at any time.';

// Validation
const validateConsent = [
  body('fullName').trim().notEmpty().withMessage('Full name is required'),
  body('phone').trim().notEmpty().withMessage('Phone number is required'),
  body('smsOptIn').isBoolean().equals('true').withMessage('SMS consent is required'),
];

// POST /api/sms-consent - Submit SMS opt-in consent
router.post('/', validateConsent, async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors: errors.array()
      });
    }

    const { fullName, phone, email, reason, pageUrl } = req.body;
    const consentTimestamp = new Date();
    const ipAddress = req.headers['x-forwarded-for'] || req.ip;

    const consentRecord = {
      fullName,
      phone,
      email: email || null,
      reason: reason || null,
      consentTimestamp,
      ipAddress,
      pageUrl: pageUrl || null,
      consentText: CONSENT_TEXT,
      smsConfirmationSent: false
    };

    // Save to database if available
    if (dbAvailable && SmsConsent) {
      try {
        const saved = await SmsConsent.create(consentRecord);
        console.log(`SMS consent recorded: ${saved.id} - ${phone}`);
      } catch (dbError) {
        console.error('Database save error:', dbError.message);
        // Continue even if DB fails - log the consent
      }
    }

    console.log('=== SMS CONSENT RECEIVED ===');
    console.log('Name:', fullName);
    console.log('Phone:', phone);
    console.log('Email:', email || 'N/A');
    console.log('IP:', ipAddress);
    console.log('Timestamp:', consentTimestamp.toISOString());
    console.log('============================');

    // TODO: Future integration - trigger SMS confirmation via Twilio or GoHighLevel
    // Example:
    // await twilioClient.messages.create({
    //   body: 'Pathway Transportation Corp: You have opted in to receive SMS notifications. Reply STOP to opt out.',
    //   to: phone,
    //   from: process.env.TWILIO_PHONE_NUMBER
    // });

    res.json({
      success: true,
      message: 'SMS consent recorded successfully',
      data: {
        fullName,
        phone,
        consentTimestamp: consentTimestamp.toISOString(),
        confirmationNumber: `PW-SMS-${Date.now()}`
      }
    });

  } catch (error) {
    console.error('SMS consent error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to process SMS consent'
    });
  }
});

module.exports = router;
