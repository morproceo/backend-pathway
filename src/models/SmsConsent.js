'use strict';

module.exports = (sequelize, DataTypes) => {
  const SmsConsent = sequelize.define('SmsConsent', {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true
    },
    fullName: {
      type: DataTypes.STRING(255),
      allowNull: false,
      field: 'full_name'
    },
    phone: {
      type: DataTypes.STRING(20),
      allowNull: false
    },
    email: {
      type: DataTypes.STRING(255),
      allowNull: true
    },
    reason: {
      type: DataTypes.TEXT,
      allowNull: true
    },
    consentTimestamp: {
      type: DataTypes.DATE,
      allowNull: false,
      field: 'consent_timestamp'
    },
    ipAddress: {
      type: DataTypes.STRING(45),
      allowNull: true,
      field: 'ip_address'
    },
    pageUrl: {
      type: DataTypes.STRING(500),
      allowNull: true,
      field: 'page_url'
    },
    consentText: {
      type: DataTypes.TEXT,
      allowNull: false,
      field: 'consent_text'
    },
    smsConfirmationSent: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
      field: 'sms_confirmation_sent'
    },
    marketingOptIn: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
      field: 'marketing_opt_in'
    },
    marketingConsentText: {
      type: DataTypes.TEXT,
      allowNull: true,
      field: 'marketing_consent_text'
    }
  }, {
    tableName: 'sms_consents',
    underscored: true
  });

  return SmsConsent;
};
