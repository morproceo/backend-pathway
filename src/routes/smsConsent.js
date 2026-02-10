const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const nodemailer = require('nodemailer');

// Try to load models (may fail if DB not connected)
let SmsConsent, dbAvailable = false;
try {
  const models = require('../models');
  SmsConsent = models.SmsConsent;
  dbAvailable = true;
} catch (e) {
  console.warn('SmsConsent model not available, running in log-only mode');
}

const CONSENT_TEXT = 'I consent to receive transactional messages from Pathway Transportation Corp at the phone number provided. Message frequency may vary. Message & Data rates may apply. Reply HELP for help or STOP to opt-out.';
const MARKETING_CONSENT_TEXT = 'I consent to receive marketing and promotional messages from Pathway Transportation Corp at the phone number provided. Message frequency may vary. Message & Data rates may apply. Reply HELP for help or STOP to opt-out.';

// Validation
const validateConsent = [
  body('fullName').trim().notEmpty().withMessage('Full name is required'),
  body('phone').trim().notEmpty().withMessage('Phone number is required'),
  body('smsOptIn').isBoolean().equals('true').withMessage('SMS consent is required'),
  body('ageConfirmation').isBoolean().equals('true').withMessage('You must confirm you are 18 years or older'),
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

    const { fullName, phone, email, reason, pageUrl, marketingOptIn } = req.body;
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
      smsConfirmationSent: false,
      marketingOptIn: marketingOptIn === true,
      marketingConsentText: marketingOptIn === true ? MARKETING_CONSENT_TEXT : null
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
    console.log('Marketing Opt-In:', marketingOptIn === true ? 'Yes' : 'No');
    console.log('IP:', ipAddress);
    console.log('Timestamp:', consentTimestamp.toISOString());
    console.log('============================');

    // Send email notification to yamil@morpro.io
    try {
      const transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST || 'smtp.gmail.com',
        port: parseInt(process.env.SMTP_PORT || '587'),
        secure: process.env.SMTP_SECURE === 'true',
        auth: {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASS,
        },
      });

      const notificationEmail = process.env.SMS_NOTIFICATION_EMAIL || 'yamil@morpro.io';

      await transporter.sendMail({
        from: process.env.SMTP_FROM || process.env.SMTP_USER,
        to: notificationEmail,
        subject: `New SMS Opt-In: ${fullName} - ${phone}`,
        html: `
          <h2>New SMS Opt-In Consent Received</h2>
          <table style="border-collapse: collapse; width: 100%; max-width: 600px;">
            <tr><td style="padding: 8px; border: 1px solid #ddd; font-weight: bold;">Name</td><td style="padding: 8px; border: 1px solid #ddd;">${fullName}</td></tr>
            <tr><td style="padding: 8px; border: 1px solid #ddd; font-weight: bold;">Phone</td><td style="padding: 8px; border: 1px solid #ddd;">${phone}</td></tr>
            <tr><td style="padding: 8px; border: 1px solid #ddd; font-weight: bold;">Email</td><td style="padding: 8px; border: 1px solid #ddd;">${email || 'N/A'}</td></tr>
            <tr><td style="padding: 8px; border: 1px solid #ddd; font-weight: bold;">Reason</td><td style="padding: 8px; border: 1px solid #ddd;">${reason || 'N/A'}</td></tr>
            <tr><td style="padding: 8px; border: 1px solid #ddd; font-weight: bold;">Marketing Opt-In</td><td style="padding: 8px; border: 1px solid #ddd;">${marketingOptIn === true ? 'Yes' : 'No'}</td></tr>
            <tr><td style="padding: 8px; border: 1px solid #ddd; font-weight: bold;">IP Address</td><td style="padding: 8px; border: 1px solid #ddd;">${ipAddress}</td></tr>
            <tr><td style="padding: 8px; border: 1px solid #ddd; font-weight: bold;">Timestamp</td><td style="padding: 8px; border: 1px solid #ddd;">${consentTimestamp.toISOString()}</td></tr>
            <tr><td style="padding: 8px; border: 1px solid #ddd; font-weight: bold;">Page URL</td><td style="padding: 8px; border: 1px solid #ddd;">${pageUrl || 'N/A'}</td></tr>
          </table>
          <p style="margin-top: 16px; color: #666;">Consent Text: ${CONSENT_TEXT}</p>
          ${marketingOptIn === true ? `<p style="color: #666;">Marketing Consent: ${MARKETING_CONSENT_TEXT}</p>` : ''}
        `,
      });
      console.log('SMS opt-in notification email sent to', notificationEmail);
    } catch (emailError) {
      console.error('Failed to send notification email:', emailError.message);
      // Don't fail the request if email fails
    }

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
