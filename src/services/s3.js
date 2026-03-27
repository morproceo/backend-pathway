'use strict';

const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const path = require('path');

// Initialize S3 Client
const s3Client = new S3Client({
  region: process.env.AWS_REGION || 'us-east-2',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
  }
});

const BUCKET_NAME = process.env.AWS_S3_BUCKET || 'pathway-transportation-files';

// Document types with display names
const DOCUMENT_TYPES = {
  cdl: 'CDL License',
  medical: 'Medical Card',
  mvr: 'MVR Report',
  registration: 'Truck Registration',
  insurance: 'Insurance Certificate',
  w9: 'W9 Form',
  authority: 'MC Authority',
  agreement: 'Lease Agreement',
  driver_contract: 'Independent Contractor Driver Agreement',
  payment_info: 'Payment Information Authorization',
  other: 'Other Document'
};

/**
 * Generate organized file key for S3
 * Format: drivers/{driverId}/{documentType}/{originalName}_{timestamp}.{ext}
 */
function generateFileKey(driverId, documentType, originalFilename) {
  const ext = path.extname(originalFilename);
  const baseName = path.basename(originalFilename, ext)
    .replace(/[^a-zA-Z0-9-_]/g, '_') // Sanitize filename
    .substring(0, 50); // Limit length

  const timestamp = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  const uniqueId = Math.random().toString(36).substring(2, 8);

  return `drivers/${driverId}/${documentType}/${baseName}_${timestamp}_${uniqueId}${ext}`;
}

/**
 * Upload file to S3
 */
async function uploadFile(fileBuffer, driverId, documentType, originalFilename, mimeType) {
  const key = generateFileKey(driverId, documentType, originalFilename);

  const command = new PutObjectCommand({
    Bucket: BUCKET_NAME,
    Key: key,
    Body: fileBuffer,
    ContentType: mimeType,
    Metadata: {
      'driver-id': driverId,
      'document-type': documentType,
      'original-filename': originalFilename,
      'upload-date': new Date().toISOString()
    }
  });

  await s3Client.send(command);

  return {
    key,
    bucket: BUCKET_NAME,
    documentType,
    originalFilename,
    uploadedAt: new Date().toISOString(),
    url: `https://${BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${key}`
  };
}

/**
 * Get signed URL for secure file download (expires in 1 hour)
 */
async function getSignedDownloadUrl(key, expiresIn = 3600) {
  const command = new GetObjectCommand({
    Bucket: BUCKET_NAME,
    Key: key
  });

  return getSignedUrl(s3Client, command, { expiresIn });
}

/**
 * Delete file from S3
 */
async function deleteFile(key) {
  const command = new DeleteObjectCommand({
    Bucket: BUCKET_NAME,
    Key: key
  });

  await s3Client.send(command);
  return true;
}

/**
 * Get all document types
 */
function getDocumentTypes() {
  return DOCUMENT_TYPES;
}

module.exports = {
  uploadFile,
  getSignedDownloadUrl,
  deleteFile,
  getDocumentTypes,
  DOCUMENT_TYPES
};
