'use strict';

const express = require('express');
const router = express.Router();
const multer = require('multer');
const PDFDocument = require('pdfkit');
const { authenticateToken } = require('../middleware/auth');
const s3Service = require('../services/s3');
const { Document, User, Application } = require('../models');
const goHighLevelService = require('../services/goHighLevel');

// Configure multer for memory storage (files go to buffer, then S3)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024 // 10MB limit
  },
  fileFilter: (req, file, cb) => {
    // Allow common document types
    const allowedTypes = [
      'image/jpeg',
      'image/png',
      'image/gif',
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    ];

    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Allowed: JPEG, PNG, GIF, PDF, DOC, DOCX'), false);
    }
  }
});

// GET /api/uploads/document-types - Get list of document types
router.get('/document-types', (req, res) => {
  res.json({
    success: true,
    data: s3Service.getDocumentTypes()
  });
});

// POST /api/uploads/document - Upload a document
router.post('/document', authenticateToken, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: 'No file uploaded'
      });
    }

    const { documentType } = req.body;

    if (!documentType || !s3Service.DOCUMENT_TYPES[documentType]) {
      return res.status(400).json({
        success: false,
        message: 'Invalid document type',
        validTypes: Object.keys(s3Service.DOCUMENT_TYPES)
      });
    }

    const userId = req.user.id;

    // Upload to S3
    const result = await s3Service.uploadFile(
      req.file.buffer,
      userId,
      documentType,
      req.file.originalname,
      req.file.mimetype
    );

    // Check if document of this type already exists for this user
    let document = await Document.findOne({
      where: { userId, documentType }
    });

    if (document) {
      // Delete old file from S3
      try {
        await s3Service.deleteFile(document.s3Key);
      } catch (e) {
        console.warn('Failed to delete old file from S3:', e.message);
      }

      // Update existing document record
      await document.update({
        s3Key: result.key,
        originalFilename: req.file.originalname,
        mimeType: req.file.mimetype,
        fileSize: req.file.size,
        status: 'pending',
        uploadedAt: new Date()
      });
    } else {
      // Create new document record
      document = await Document.create({
        userId,
        documentType,
        s3Key: result.key,
        originalFilename: req.file.originalname,
        mimeType: req.file.mimetype,
        fileSize: req.file.size,
        status: 'pending'
      });
    }

    res.json({
      success: true,
      message: 'Document uploaded successfully',
      data: {
        id: document.id,
        documentType,
        documentTypeName: s3Service.DOCUMENT_TYPES[documentType],
        key: result.key,
        originalFilename: req.file.originalname,
        uploadedAt: document.uploadedAt
      }
    });
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to upload document',
      error: error.message
    });
  }
});

// POST /api/uploads/multiple - Upload multiple documents
router.post('/multiple', authenticateToken, upload.array('files', 10), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No files uploaded'
      });
    }

    const { documentTypes } = req.body; // JSON array of types matching files
    let types = [];

    try {
      types = JSON.parse(documentTypes || '[]');
    } catch (e) {
      return res.status(400).json({
        success: false,
        message: 'Invalid documentTypes format'
      });
    }

    const userId = req.user.id;
    const results = [];

    for (let i = 0; i < req.files.length; i++) {
      const file = req.files[i];
      const docType = types[i] || 'other';

      const result = await s3Service.uploadFile(
        file.buffer,
        userId,
        docType,
        file.originalname,
        file.mimetype
      );

      // Create or update document record
      let document = await Document.findOne({
        where: { userId, documentType: docType }
      });

      if (document) {
        try {
          await s3Service.deleteFile(document.s3Key);
        } catch (e) {
          console.warn('Failed to delete old file:', e.message);
        }
        await document.update({
          s3Key: result.key,
          originalFilename: file.originalname,
          mimeType: file.mimetype,
          fileSize: file.size,
          status: 'pending',
          uploadedAt: new Date()
        });
      } else {
        document = await Document.create({
          userId,
          documentType: docType,
          s3Key: result.key,
          originalFilename: file.originalname,
          mimeType: file.mimetype,
          fileSize: file.size,
          status: 'pending'
        });
      }

      results.push({
        id: document.id,
        documentType: docType,
        documentTypeName: s3Service.DOCUMENT_TYPES[docType],
        key: result.key,
        originalFilename: file.originalname,
        uploadedAt: document.uploadedAt
      });
    }

    res.json({
      success: true,
      message: `${results.length} document(s) uploaded successfully`,
      data: results
    });
  } catch (error) {
    console.error('Multiple upload error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to upload documents',
      error: error.message
    });
  }
});

// GET /api/uploads/document/:key - Get signed URL for document download
router.get('/document/*', authenticateToken, async (req, res) => {
  try {
    const key = req.params[0]; // Get full path after /document/

    if (!key) {
      return res.status(400).json({
        success: false,
        message: 'Document key required'
      });
    }

    const signedUrl = await s3Service.getSignedDownloadUrl(key);

    res.json({
      success: true,
      data: {
        url: signedUrl,
        expiresIn: 3600 // 1 hour
      }
    });
  } catch (error) {
    console.error('Get document error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get document',
      error: error.message
    });
  }
});

// DELETE /api/uploads/document/:key - Delete a document
router.delete('/document/*', authenticateToken, async (req, res) => {
  try {
    const key = req.params[0];

    if (!key) {
      return res.status(400).json({
        success: false,
        message: 'Document key required'
      });
    }

    const userId = req.user.id;

    // Find the document record
    const document = await Document.findOne({
      where: { userId, s3Key: key }
    });

    if (!document) {
      return res.status(404).json({
        success: false,
        message: 'Document not found'
      });
    }

    // Delete from S3
    await s3Service.deleteFile(key);

    // Delete from database
    await document.destroy();

    res.json({
      success: true,
      message: 'Document deleted successfully'
    });
  } catch (error) {
    console.error('Delete document error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete document',
      error: error.message
    });
  }
});

// POST /api/uploads/generate-payment-info - Generate payment info PDF
router.post('/generate-payment-info', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const {
      paymentMethod,
      zelleEmail,
      zellePhone,
      bankName,
      accountHolderName,
      accountNumber,
      routingNumber,
      accountType,
      bankAddress,
      swiftCode
    } = req.body;

    // Validate required fields based on payment method
    if (!paymentMethod || !['zelle', 'direct_deposit', 'wire'].includes(paymentMethod)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid payment method'
      });
    }

    if (paymentMethod === 'zelle' && !zelleEmail && !zellePhone) {
      return res.status(400).json({
        success: false,
        message: 'Zelle requires either email or phone number'
      });
    }

    if ((paymentMethod === 'direct_deposit' || paymentMethod === 'wire') &&
        (!bankName || !accountHolderName || !accountNumber || !routingNumber)) {
      return res.status(400).json({
        success: false,
        message: 'Bank details are required for direct deposit/wire'
      });
    }

    // Get user info for the PDF
    const user = await User.findByPk(userId);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Generate PDF
    const pdfBuffer = await generatePaymentInfoPDF({
      user: {
        firstName: user.firstName || user.first_name,
        lastName: user.lastName || user.last_name,
        email: user.email
      },
      paymentMethod,
      zelleEmail,
      zellePhone,
      bankName,
      accountHolderName,
      accountNumber,
      routingNumber,
      accountType,
      bankAddress,
      swiftCode
    });

    // Upload PDF to S3
    const filename = `payment_info_${Date.now()}.pdf`;
    const result = await s3Service.uploadFile(
      pdfBuffer,
      userId,
      'payment_info',
      filename,
      'application/pdf'
    );

    // Check if document of this type already exists for this user
    let document = await Document.findOne({
      where: { userId, documentType: 'payment_info' }
    });

    if (document) {
      // Delete old file from S3
      try {
        await s3Service.deleteFile(document.s3Key);
      } catch (e) {
        console.warn('Failed to delete old payment info file from S3:', e.message);
      }

      // Update existing document record
      await document.update({
        s3Key: result.key,
        originalFilename: filename,
        mimeType: 'application/pdf',
        fileSize: pdfBuffer.length,
        status: 'pending',
        uploadedAt: new Date()
      });
    } else {
      // Create new document record
      document = await Document.create({
        userId,
        documentType: 'payment_info',
        s3Key: result.key,
        originalFilename: filename,
        mimeType: 'application/pdf',
        fileSize: pdfBuffer.length,
        status: 'pending'
      });
    }

    res.json({
      success: true,
      message: 'Payment information document generated successfully',
      data: {
        id: document.id,
        documentType: 'payment_info',
        documentTypeName: 'Payment Information Authorization',
        key: result.key,
        originalFilename: filename,
        uploadedAt: document.uploadedAt
      }
    });
  } catch (error) {
    console.error('Generate payment info error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to generate payment information document',
      error: error.message
    });
  }
});

/**
 * Generate Payment Information Authorization PDF
 */
function generatePaymentInfoPDF(data) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ margin: 50 });
      const chunks = [];

      doc.on('data', chunk => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const methodLabels = {
        zelle: 'Zelle',
        direct_deposit: 'Direct Deposit (ACH)',
        wire: 'Wire Transfer'
      };

      // Header
      doc.fontSize(20).font('Helvetica-Bold').text('Pathway Transportation Corp', { align: 'center' });
      doc.fontSize(16).font('Helvetica').text('Payment Information Authorization', { align: 'center' });
      doc.moveDown(0.5);

      // Date
      const currentDate = new Date().toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric'
      });
      doc.fontSize(10).text(`Date: ${currentDate}`, { align: 'right' });
      doc.moveDown(2);

      // Horizontal line
      doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke();
      doc.moveDown(1);

      // Driver Information Section
      doc.fontSize(14).font('Helvetica-Bold').text('Driver Information');
      doc.moveDown(0.5);
      doc.fontSize(11).font('Helvetica');
      doc.text(`Name: ${data.user.firstName} ${data.user.lastName}`);
      doc.text(`Email: ${data.user.email}`);
      doc.moveDown(1.5);

      // Payment Method Section
      doc.fontSize(14).font('Helvetica-Bold').text('Payment Method');
      doc.moveDown(0.5);
      doc.fontSize(11).font('Helvetica');
      doc.text(`Selected Method: ${methodLabels[data.paymentMethod]}`);
      doc.moveDown(1);

      // Payment Details Section
      doc.fontSize(14).font('Helvetica-Bold').text('Payment Details');
      doc.moveDown(0.5);
      doc.fontSize(11).font('Helvetica');

      if (data.paymentMethod === 'zelle') {
        if (data.zelleEmail) {
          doc.text(`Zelle Email: ${data.zelleEmail}`);
        }
        if (data.zellePhone) {
          doc.text(`Zelle Phone: ${data.zellePhone}`);
        }
      } else {
        doc.text(`Bank Name: ${data.bankName}`);
        doc.text(`Account Holder: ${data.accountHolderName}`);
        doc.text(`Routing Number: ${data.routingNumber}`);
        doc.text(`Account Number: ****${data.accountNumber.slice(-4)}`);
        if (data.accountType) {
          doc.text(`Account Type: ${data.accountType.charAt(0).toUpperCase() + data.accountType.slice(1)}`);
        }
        if (data.paymentMethod === 'wire') {
          if (data.bankAddress) {
            doc.text(`Bank Address: ${data.bankAddress}`);
          }
          if (data.swiftCode) {
            doc.text(`SWIFT/BIC Code: ${data.swiftCode}`);
          }
        }
      }

      doc.moveDown(2);

      // Authorization Section
      doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke();
      doc.moveDown(1);

      doc.fontSize(14).font('Helvetica-Bold').text('Authorization');
      doc.moveDown(0.5);
      doc.fontSize(10).font('Helvetica');
      doc.text(
        'I hereby authorize Pathway Transportation Corp to process payments using the payment method and account information provided above. ' +
        'I confirm that all information provided is accurate and that I am authorized to use this payment method.',
        { align: 'justify' }
      );
      doc.moveDown(1);
      doc.text(
        'I understand that this authorization will remain in effect until I provide written notice of cancellation or update my payment information.',
        { align: 'justify' }
      );
      doc.moveDown(2);

      // Signature Section
      doc.fontSize(11).font('Helvetica');
      doc.text(`Electronic Signature: ${data.user.firstName} ${data.user.lastName}`);
      doc.text(`Date Signed: ${currentDate}`);
      doc.moveDown(2);

      // Footer
      doc.fontSize(8).fillColor('#666666');
      doc.text(
        'This document was electronically generated and signed through the Pathway Transportation Corp Driver Portal. ' +
        'For questions, please contact support@pathwaytransportationcorp.com.',
        50,
        doc.page.height - 80,
        { align: 'center', width: 500 }
      );

      doc.end();
    } catch (error) {
      reject(error);
    }
  });
}

// GET /api/uploads/my-documents - Get all documents for current user
router.get('/my-documents', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    const documents = await Document.findAll({
      where: { userId },
      order: [['uploadedAt', 'DESC']]
    });

    // Add signed URLs to each document
    const documentsWithUrls = await Promise.all(
      documents.map(async (doc) => {
        let signedUrl = null;
        try {
          signedUrl = await s3Service.getSignedDownloadUrl(doc.s3Key);
        } catch (e) {
          console.warn('Failed to get signed URL for:', doc.s3Key);
        }
        return {
          id: doc.id,
          type: doc.documentType,
          typeName: s3Service.DOCUMENT_TYPES[doc.documentType] || doc.documentType,
          key: doc.s3Key,
          originalName: doc.originalFilename,
          mimeType: doc.mimeType,
          fileSize: doc.fileSize,
          status: doc.status,
          uploadedAt: doc.uploadedAt,
          url: signedUrl
        };
      })
    );

    res.json({
      success: true,
      data: documentsWithUrls
    });
  } catch (error) {
    console.error('Get my documents error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get documents',
      error: error.message
    });
  }
});

// GET /api/uploads/my-application - Get current user's application data for lease agreement
router.get('/my-application', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    // Get user info
    const user = await User.findByPk(userId);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Get user's application
    const application = await Application.findOne({
      where: { userId },
      order: [['createdAt', 'DESC']]
    });

    res.json({
      success: true,
      data: {
        user: {
          id: user.id,
          firstName: user.firstName || user.first_name,
          lastName: user.lastName || user.last_name,
          email: user.email,
          phone: user.phone
        },
        application: application ? {
          streetAddress: application.streetAddress || application.street_address,
          city: application.city,
          state: application.state,
          zipCode: application.zipCode || application.zip_code,
          truckYear: application.truckYear || application.truck_year,
          truckMake: application.truckMake || application.truck_make,
          truckModel: application.truckModel || application.truck_model,
          truckVIN: application.truckVIN || application.truck_vin,
          hasTrailer: application.hasTrailer || application.has_trailer,
          trailerType: application.trailerType || application.trailer_type,
          trailerLength: application.trailerLength || application.trailer_length,
          position: application.position,
          ssnLast4: application.ssn ? application.ssn.slice(-4) : null
        } : null
      }
    });
  } catch (error) {
    console.error('Get my application error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get application data',
      error: error.message
    });
  }
});

// POST /api/uploads/generate-lease-agreement - Generate signed lease agreement PDF
router.post('/generate-lease-agreement', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const {
      // Owner info
      ownerName,
      ownerAddress,
      ownerCity,
      ownerState,
      ownerZip,
      // Equipment
      equipment,
      // Signature
      signatureData,
      signatureType
    } = req.body;

    // Validate required fields
    if (!ownerName || !signatureData) {
      return res.status(400).json({
        success: false,
        message: 'Owner name and signature are required'
      });
    }

    // Get user info
    const user = await User.findByPk(userId);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Generate PDF
    const pdfBuffer = await generateLeaseAgreementPDF({
      ownerName,
      ownerAddress: ownerAddress || '',
      ownerCity: ownerCity || '',
      ownerState: ownerState || '',
      ownerZip: ownerZip || '',
      equipment: equipment || [],
      signatureData,
      signatureType,
      signedDate: new Date()
    });

    // Upload PDF to S3
    const filename = `lease_agreement_${Date.now()}.pdf`;
    const result = await s3Service.uploadFile(
      pdfBuffer,
      userId,
      'agreement',
      filename,
      'application/pdf'
    );

    // Check if document of this type already exists for this user
    let document = await Document.findOne({
      where: { userId, documentType: 'agreement' }
    });

    if (document) {
      // Delete old file from S3
      try {
        await s3Service.deleteFile(document.s3Key);
      } catch (e) {
        console.warn('Failed to delete old lease agreement from S3:', e.message);
      }

      // Update existing document record
      await document.update({
        s3Key: result.key,
        originalFilename: filename,
        mimeType: 'application/pdf',
        fileSize: pdfBuffer.length,
        status: 'pending',
        uploadedAt: new Date()
      });
    } else {
      // Create new document record
      document = await Document.create({
        userId,
        documentType: 'agreement',
        s3Key: result.key,
        originalFilename: filename,
        mimeType: 'application/pdf',
        fileSize: pdfBuffer.length,
        status: 'pending'
      });
    }

    res.json({
      success: true,
      message: 'Lease agreement signed and saved successfully',
      data: {
        id: document.id,
        documentType: 'agreement',
        documentTypeName: 'Equipment Lease Agreement',
        key: result.key,
        originalFilename: filename,
        uploadedAt: document.uploadedAt
      }
    });
  } catch (error) {
    console.error('Generate lease agreement error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to generate lease agreement',
      error: error.message
    });
  }
});

// POST /api/uploads/generate-driver-contract - Generate signed driver contract PDF
router.post('/generate-driver-contract', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const body = req.body;
    const contractorName = body.contractorName;
    const contractorAddress = body.contractorAddress || body.address || '';
    const contractorCity = body.contractorCity || body.city || '';
    const contractorState = body.contractorState || body.state || '';
    const contractorZip = body.contractorZip || body.zipCode || '';
    const ssnLast4 = body.ssnLast4 || '****';
    const signatureData = body.signatureData;
    const signatureType = body.signatureType;
    let initials = body.initials;
    const initialedSections = body.initialedSections;

    // Validate required fields
    if (!contractorName || !signatureData || (!initials && !initialedSections)) {
      return res.status(400).json({
        success: false,
        message: 'Contractor name, initials, and signature are required'
      });
    }

    // If initials is a string (e.g. "TW"), build the object from initialedSections
    if (typeof initials === 'string' && Array.isArray(initialedSections)) {
      const initialsStr = initials;
      initials = {};
      for (const sectionId of initialedSections) {
        initials[sectionId] = initialsStr;
      }
    } else if (typeof initials === 'string') {
      // Fallback: apply to all known section keys
      const initialsStr = initials;
      initials = {};
      const allKeys = ['1','2','3','4','5','6','7','8','9','9.1','10','11','12','13','14','15','16','17','18','19','19.1','20','21a','21b','21c','21d','21e','21f','21g','21h','21i','21j','21k','21l','22','23','24','25'];
      for (const key of allKeys) {
        initials[key] = initialsStr;
      }
    }

    // Get user info
    const user = await User.findByPk(userId);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Generate PDF
    const pdfBuffer = await generateDriverContractPDF({
      contractorName,
      contractorAddress,
      contractorCity,
      contractorState,
      contractorZip,
      ssnLast4,
      initials: initials || {},
      signatureData,
      signatureType,
      signedDate: new Date()
    });

    // Upload PDF to S3
    const filename = `driver_contract_${Date.now()}.pdf`;
    const result = await s3Service.uploadFile(
      pdfBuffer,
      userId,
      'driver_contract',
      filename,
      'application/pdf'
    );

    // Check if document of this type already exists for this user
    let document = await Document.findOne({
      where: { userId, documentType: 'driver_contract' }
    });

    if (document) {
      // Delete old file from S3
      try {
        await s3Service.deleteFile(document.s3Key);
      } catch (e) {
        console.warn('Failed to delete old driver contract from S3:', e.message);
      }

      // Update existing document record
      await document.update({
        s3Key: result.key,
        originalFilename: filename,
        mimeType: 'application/pdf',
        fileSize: pdfBuffer.length,
        status: 'pending',
        uploadedAt: new Date()
      });
    } else {
      // Create new document record
      document = await Document.create({
        userId,
        documentType: 'driver_contract',
        s3Key: result.key,
        originalFilename: filename,
        mimeType: 'application/pdf',
        fileSize: pdfBuffer.length,
        status: 'pending'
      });
    }

    // Sync to GoHighLevel
    try {
      const application = await Application.findOne({
        where: { userId },
        order: [['createdAt', 'DESC']]
      });
      if (application) {
        await goHighLevelService.sendToWebhook({
          firstName: user.firstName || user.first_name,
          lastName: user.lastName || user.last_name,
          email: user.email,
          phone: user.phone,
          applicationId: application.applicationId || application.id,
          status: 'Driver Contract Signed',
          position: application.position,
          streetAddress: contractorAddress,
          city: contractorCity,
          state: contractorState,
          zipCode: contractorZip
        });
        console.log('GoHighLevel sync successful for driver contract');
      }
    } catch (ghlError) {
      console.error('GoHighLevel sync error:', ghlError.message);
      // Don't fail the request, just log the error
    }

    res.json({
      success: true,
      message: 'Driver contract signed and saved successfully',
      data: {
        id: document.id,
        documentType: 'driver_contract',
        documentTypeName: 'Independent Contractor Driver Agreement',
        key: result.key,
        originalFilename: filename,
        uploadedAt: document.uploadedAt
      }
    });
  } catch (error) {
    console.error('Generate driver contract error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to generate driver contract',
      error: error.message
    });
  }
});

/**
 * Generate Independent Contractor Driver Agreement PDF
 */
function generateDriverContractPDF(data) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ margin: 50, size: 'LETTER' });
      const chunks = [];

      doc.on('data', chunk => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const currentDate = new Date().toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric'
      });

      // Helper: check if we need a page break
      function checkPageBreak(neededSpace) {
        const spaceNeeded = neededSpace || 120;
        if (doc.y > doc.page.height - spaceNeeded) {
          doc.addPage();
        }
      }

      // Helper: render a section with initials
      function renderSection(number, title, text, initialKey) {
        checkPageBreak(160);
        doc.fontSize(11).font('Helvetica-Bold').fillColor('#000000')
          .text(`${number}. ${title}`);
        doc.moveDown(0.3);
        doc.fontSize(9.5).font('Helvetica').fillColor('#333333')
          .text(text, { align: 'justify' });
        doc.moveDown(0.3);
        const initialsVal = data.initials[initialKey] || '______';
        doc.fontSize(9).font('Helvetica-Bold').fillColor('#000000')
          .text(`Contractor Initials: ${initialsVal}`, { align: 'right' });
        doc.moveDown(0.8);
      }

      // Helper: render a sub-item with initials (for section 21)
      function renderSubItem(label, text, initialKey) {
        checkPageBreak(100);
        doc.fontSize(9.5).font('Helvetica').fillColor('#333333')
          .text(`  \u2022  ${label}: ${text}`, { indent: 15, align: 'justify' });
        doc.moveDown(0.2);
        const initialsVal = data.initials[initialKey] || '______';
        doc.fontSize(9).font('Helvetica-Bold').fillColor('#000000')
          .text(`Contractor Initials: ${initialsVal}`, { align: 'right' });
        doc.moveDown(0.5);
      }

      // ===== HEADER WITH LOGO =====
      const logoPath = require('path').join(__dirname, '..', 'pathway_logo.png');
      try {
        doc.image(logoPath, (doc.page.width - 180) / 2, doc.y, { width: 180 });
        doc.moveDown(3.5);
      } catch (logoErr) {
        // Fallback to text if logo not found
        doc.fontSize(16).fillColor('#000000').font('Helvetica-Bold')
          .text('PATHWAY TRANSPORTATION', { align: 'center' });
        doc.moveDown(0.2);
      }
      doc.fontSize(9).font('Helvetica').fillColor('#444444')
        .text('6844 JEFFERY AVE S COTTAGE GROVE, MN 55016-2333', { align: 'center' });
      doc.fontSize(9).text('MC#: 1592008  |  DOT#: 4148434', { align: 'center' });
      doc.moveDown(0.5);
      doc.moveTo(50, doc.y).lineTo(562, doc.y).stroke('#cccccc');
      doc.moveDown(0.5);

      // Driver info line
      doc.fontSize(10).font('Helvetica').fillColor('#000000');
      doc.text(`Driver Name: ${data.contractorName}          Social Security No.: ***-**-${data.ssnLast4}`);
      doc.moveDown(0.3);
      const fullAddress = [data.contractorAddress, data.contractorCity, data.contractorState, data.contractorZip]
        .filter(Boolean).join(', ');
      if (fullAddress) {
        doc.text(`Address: ${fullAddress}`);
        doc.moveDown(0.3);
      }
      doc.text(`Date: ${currentDate}`);
      doc.moveDown(0.8);

      // Title
      doc.fontSize(14).font('Helvetica-Bold').fillColor('#000000')
        .text('Independent Contractor Driver and Policy Agreement', { align: 'center' });
      doc.moveDown(0.5);
      doc.moveTo(50, doc.y).lineTo(562, doc.y).stroke('#cccccc');
      doc.moveDown(1);

      // ===== SECTION 1 =====
      renderSection('1', 'Independent Contractor Status',
        `I, ${data.contractorName}, understand and agree that I am an Independent Contractor Driver. This agreement shall remain in full force and effect until terminated by either party. Either Party may terminate this Agreement at any time, with or without cause, upon providing written notice to the other Party.`,
        '1');

      // ===== SECTION 2 =====
      renderSection('2', 'Contract Modifications',
        'I understand that additions or deletions can be made at any time to this contract policy agreement by Pathway Transportation. I will be provided with a new copy to review and understand promptly before signing to determine if I wish to continue with the contract or decline.',
        '2');

      // ===== SECTION 3 =====
      renderSection('3', 'Tax Responsibilities',
        'I understand that I am responsible for filing my taxes with the Internal Revenue Service and Resident State Revenue Department. Pathway Transportation will provide me with a 1099 form.',
        '3');

      // ===== SECTION 4 =====
      checkPageBreak(300);
      doc.fontSize(11).font('Helvetica-Bold').fillColor('#000000')
        .text('4. Payment Terms');
      doc.moveDown(0.3);
      doc.fontSize(9.5).font('Helvetica').fillColor('#333333');
      doc.text('The Contractor acknowledges and agrees that compensation shall be structured under one of the following payment models, as determined and agreed upon with Pathway Transportation:', { align: 'justify' });
      doc.moveDown(0.5);
      doc.font('Helvetica-Bold').text('1. Per-Mile Compensation');
      doc.font('Helvetica');
      doc.text('  \u2022  $0.60 per mile for Dry Van loads');
      doc.text('  \u2022  $0.60 per mile for Reefer loads');
      doc.text('  \u2022  $0.60 per mile for Flatbed loads');
      doc.moveDown(0.3);
      doc.text('After a continuous period of three (3) months of active service, the per-mile rate for loaded miles may be increased from $0.60 to $0.65, at the sole discretion of Pathway Transportation. This increase will be based on a performance evaluation considering, but not limited to:', { align: 'justify' });
      doc.text('  \u2022  Punctuality and on-time performance');
      doc.text('  \u2022  Successful completion of assigned loads');
      doc.text('  \u2022  Demonstrated experience and professionalism');
      doc.moveDown(0.5);

      checkPageBreak(200);
      doc.font('Helvetica-Bold').text('2. Percentage-Based Compensation');
      doc.font('Helvetica');
      doc.text('As an alternative to per-mile compensation, the Contractor may elect to be compensated based on a percentage of the gross revenue of each load. The applicable percentage shall be determined based on the Contractor\'s verified experience as follows:', { align: 'justify' });
      doc.text('  \u2022  Twenty-Seven Percent (27%) of the gross revenue per load for Contractors with two (2) or more years of experience');
      doc.text('  \u2022  Thirty Percent (30%) of the gross revenue per load for Contractors with five (5) or more years of experience');
      doc.moveDown(0.3);
      doc.text('Pathway Transportation reserves the right to determine eligibility for any rate adjustment based on overall performance, experience, and operational standards.', { align: 'justify' });
      doc.moveDown(0.3);
      doc.text('I may also receive Detention Pay and/or Multiple Stops, less Fuel Surcharge, when applicable, cash advances, and/or applicable Fees for liabilities caused by my negligence.', { align: 'justify' });
      doc.moveDown(0.3);
      const initials4 = data.initials['4'] || '______';
      doc.fontSize(9).font('Helvetica-Bold').fillColor('#000000')
        .text(`Contractor Initials: ${initials4}`, { align: 'right' });
      doc.moveDown(0.8);

      // ===== SECTION 5 =====
      renderSection('5', 'Deadhead Miles',
        'In the event the Contractor elects compensation based on mileage, empty (deadhead) miles shall be compensated at fifty percent (50%) of the base per-mile rate. For example, if the base rate is $0.60 per mile, empty miles shall be paid at $0.30 per mile. Pathway Transportation reserves the right to determine eligibility for any rate adjustment based on overall performance and operational standards.',
        '5');

      // ===== SECTION 6 =====
      renderSection('6', 'Personal Expenses',
        'I understand it is not the responsibility of Pathway Transportation to reimburse me for personal expenses. I will not be compensated for personal expenses incurred during job hauls, such as meals, cellular phone usage, or motor vehicle violation tickets due to negligence.',
        '6');

      // ===== SECTION 7 =====
      renderSection('7', 'No Guaranteed Work',
        'I understand that Pathway Transportation does not guarantee, nor am I obligated to haul, a specific amount of loads, earn a specific amount of revenue, work a specific amount of hours, or work specific days of the week. Any revenue I generate or pay I receive from Pathway Transportation will be solely for individual job hauls I accept to complete and have completed.',
        '7');

      // ===== SECTION 8 =====
      renderSection('8', 'Control Over Work',
        'I retain full control and discretion over any hauling jobs I choose to accept, the amount of hours I choose to work, and the days I choose to work. Thus, I retain full discretion over the potential revenue I may or may not generate based on the hauling jobs I accept or do not accept to complete for Pathway Transportation.',
        '8');

      // ===== SECTION 9 =====
      renderSection('9', 'Independence and Business Autonomy',
        'I confirm that, while I am engaged as an Independent Contractor Driver for Pathway Transportation, I maintain significant control and autonomy over how I perform my work. I have the freedom to accept or reject hauling jobs offered by Pathway Transportation and manage my own work schedule. Furthermore, I am customarily engaged in providing driving services independently and have the necessary licenses and insurance required to perform my services.',
        '9');

      // ===== SECTION 9.1 =====
      renderSection('9.1', 'Independence and Business Autonomy (continued)',
        'The parties agree that Contractor is an independent business and retains full control over the means, methods, and manner of performing services. Nothing in this Agreement shall be construed to create an employer-employee relationship. Contractor is free to accept or reject loads and may perform services for other entities, subject only to obligations under accepted load assignments. Contractor shall not be deemed under the exclusive direction or control of Carrier except as required for compliance with applicable laws, safety regulations, and specific load requirements.',
        '9.1');

      // ===== SECTION 10 =====
      checkPageBreak(180);
      doc.fontSize(11).font('Helvetica-Bold').fillColor('#000000')
        .text('10. Independently Engaged Services');
      doc.moveDown(0.3);
      doc.fontSize(9.5).font('Helvetica').fillColor('#333333');
      doc.text('I confirm that, while I may not operate a formal business entity, I am customarily engaged in providing driving services independently. I am responsible for maintaining my own insurance, which includes:', { align: 'justify' });
      doc.text('  \u2022  Occupational Accident Insurance: Coverage for injuries that may occur while I am working.');
      doc.text('  \u2022  Liability Insurance: Coverage for any damage or injuries I may cause while operating the truck.');
      doc.text('I understand that I must provide proof of these insurance coverages to Pathway Transportation.', { align: 'justify' });
      doc.moveDown(0.3);
      const initials10 = data.initials['10'] || '______';
      doc.fontSize(9).font('Helvetica-Bold').fillColor('#000000')
        .text(`Contractor Initials: ${initials10}`, { align: 'right' });
      doc.moveDown(0.8);

      // ===== SECTION 11 =====
      renderSection('11', 'Risk of Loss',
        'I understand that Pathway Transportation does not guarantee a profit. I understand that I may incur losses due to unforeseeable complications with the hauling job or due to damages or penalties caused to the motor vehicle or to Pathway Transportation as a result of my negligence or failure to adhere to DOT/FMCSA regulatory requirements.',
        '11');

      // ===== SECTION 12 =====
      renderSection('12', 'Regulatory Compliance',
        'I agree to follow and uphold all regulations set by the Department of Transportation and Federal Motor Carrier Safety Administration.',
        '12');

      // ===== SECTION 13 =====
      renderSection('13', 'Zero Tolerance Policy',
        'I understand that Pathway Transportation has a zero-tolerance policy and does not permit anything that is deemed contraband or illegal by the laws of the United States of America. I accept full responsibility and penalties due to my own actions regarding this policy.',
        '13');

      // ===== SECTION 14 =====
      renderSection('14', 'Use of Equipment',
        'I understand that taking the tractor and trailer anywhere other than the agreed-upon trip origin route and destination or my personal use or place of residence requires verbal notification/disclosure to Pathway Transportation.',
        '14');

      // ===== SECTION 15 =====
      renderSection('15', 'Maintenance Requirements',
        'Contractor is responsible for maintaining the equipment in safe operating condition in accordance with all applicable DOT and FMCSA regulations.',
        '15');

      // ===== SECTION 16 =====
      renderSection('16', 'Inspections',
        'Carrier may request documentation or verification of compliance with applicable safety regulations, but Contractor retains responsibility for maintenance and operation of equipment.',
        '16');

      // ===== SECTION 17 =====
      renderSection('17', 'Return of Equipment',
        'Upon termination of this Agreement or completion of contracted services, Contractor shall return any equipment provided, subject to reasonable business conditions and scheduling.',
        '17');

      // ===== SECTION 18 =====
      renderSection('18', 'Abandonment',
        'I understand that if I do not return the truck and trailer assigned to me to Pathway Transportation upon their request, it will be considered abandonment, and I will be liable for any and all recovery expenses that Pathway Transportation incurs in getting the truck returned to them.',
        '18');

      // ===== SECTION 19 =====
      renderSection('19', 'Liability for Abandonment',
        'I understand that due to my abandoning the truck and/or trailer, or both, I waive the right to use the term "abandonment" as my defense if the unit(s) is/are stolen as a result of abandonment. I understand that it is my responsibility to return the assigned truck and trailer to Pathway Transportation, and that criminal charges can and will be brought against me for commercial vehicle theft by the City of COTTAGE GROVE, MN Police Department or any city with jurisdiction, if I fail to do so.',
        '19');

      // ===== SECTION 19.1 =====
      renderSection('19.1', 'Reserve Fund (Withheld Compensation)',
        'The Contractor acknowledges and agrees that one (1) week of compensation shall be withheld and retained by Pathway Transportation as a reserve fund to cover any potential expenses, liabilities, damages, or obligations that may arise during the course of the working relationship. The reserve fund may only be applied to documented, legitimate expenses directly related to damages, losses, or contractual obligations incurred by Contractor. Any unused balance shall be returned within a reasonable time following termination. Any remaining balance of the reserve fund shall be returned to the Contractor upon termination of this Agreement, subject to final reconciliation.',
        '19.1');

      // ===== SECTION 20 =====
      renderSection('20', 'Documentation Responsibilities',
        'It is my responsibility to make and keep copies of the Vehicle Trip Report, Vehicle Expense Report, Bill of Lading, and all receipts of each trip until Pathway Transportation has been paid by the broker or shipper and I have been paid by Pathway Transportation. If the original copies are lost in the mail or due to my negligence and I cannot provide copies, I will be responsible for all expenses and lost earnings to Pathway Transportation, as well as my loss of pay for said load.',
        '20');

      // ===== SECTION 21 =====
      checkPageBreak(160);
      doc.fontSize(11).font('Helvetica-Bold').fillColor('#000000')
        .text('21. Deductions from Pay');
      doc.moveDown(0.3);
      doc.fontSize(9.5).font('Helvetica').fillColor('#333333')
        .text('I understand, acknowledge, and give Pathway Transportation permission to withdraw and/or deduct monies from my net revenue/pay for the following conditions:', { align: 'justify' });
      doc.moveDown(0.5);

      renderSubItem('21a', 'Cash Advances', '21a');
      renderSubItem('21b', 'Shortages in trip funds due to my failure to provide receipts for maintenance, fuel, supplies, or other items and services that I have been advanced monies to purchase on behalf of Pathway Transportation.', '21b');
      renderSubItem('21c', 'Damaged Cargo due to my negligence. I must document all bills of lading if I was not present or allowed to watch the loading or unloading of freight.', '21c');
      renderSubItem('21d', 'Any charges or penalties assessed for my failure to deliver load on time due to my negligence.', '21d');
      renderSubItem('21e', 'Any physical damage on the tractor and trailer assigned to me if I am found at fault in an accident or incident due to my negligence.', '21e');
      renderSubItem('21f', 'Any Towing charges for vehicles assigned to me if I am found at fault in an accident or incident due to my negligence.', '21f');
      renderSubItem('21g', 'Liability damages to another party\'s or parties\' personal property if I am found at fault in an accident or due to my negligence.', '21g');
      renderSubItem('21h', 'Transportation expenses for failure to deliver the assigned tractor and trailer to the care of Pathway Transportation wherever Pathway Transportation deems acceptable due to termination of contract.', '21h');
      renderSubItem('21i', 'Expenses accrued for failure to return the truck and trailer assigned to me in a clean and well-maintained manner.', '21i');
      renderSubItem('21j', 'Fees and penalties assessed by the US DOT due to driver qualification violations.', '21j');
      renderSubItem('21k', 'Toll and fuel costs for undisclosed routes of travel or undisclosed use of the vehicle.', '21k');
      renderSubItem('21l', 'I understand that this is not a complete list of items that may arise that could affect deductions from my revenue/pay and that I have the right to submit a written rebuttal to Pathway Transportation for consideration of reversal of deductions from wages for items listed and not listed.', '21l');

      // ===== SECTION 22 =====
      checkPageBreak(250);
      doc.fontSize(11).font('Helvetica-Bold').fillColor('#000000')
        .text('22. Payment Process');
      doc.moveDown(0.3);
      doc.fontSize(9.5).font('Helvetica').fillColor('#333333');
      doc.text('Contractor acknowledges that payment is contingent upon Carrier\'s receipt of payment from the broker or shipper, consistent with standard industry practices. All payments shall be governed by and processed in accordance with Pathway Transportation\'s Payment Policy, which specifies the applicable processing schedule, including designated days and times for payment.', { align: 'justify' });
      doc.moveDown(0.3);
      doc.text('Pathway Transportation receives payment for the load from the broker or shipper and the following paperwork, forms, and receipts from myself:', { align: 'justify' });
      doc.text('  A) Completed and Signed Truck Mile and Fuel Report');
      doc.text('  B) Completed and Signed Trip Expense Report with all fuel and expense receipts attached');
      doc.text('  C) Copy of Bill of Lading');
      doc.text('  D) Copy of All Driver Log Sheets and Daily Maintenance Sheets for the trip');
      doc.text('  E) Copy of All Inspections, tickets, or other DOT forms if received on the trip');
      doc.moveDown(0.3);
      const initials22 = data.initials['22'] || '______';
      doc.fontSize(9).font('Helvetica-Bold').fillColor('#000000')
        .text(`Contractor Initials: ${initials22}`, { align: 'right' });
      doc.moveDown(0.8);

      // ===== SECTION 23 =====
      renderSection('23', 'Payment Methods',
        'I understand that I will be paid via direct deposit and/or Zelle as preferred payment methods.',
        '23');

      // ===== SECTION 24 =====
      renderSection('24', 'Record Retention',
        'I understand that it is my responsibility to maintain copies of the above forms and receipts until I am paid for said trip. If I cannot produce a form or receipt, I may be subject to forfeiting my part or all of my contract pay for that specific load/haul job.',
        '24');

      // ===== SECTION 25 =====
      renderSection('25', 'Training and Procedures',
        'Any guidance provided by Carrier shall be limited to compliance with DOT/FMCSA regulations and customer requirements, and shall not be construed as control over the means and methods of Contractor\'s work.',
        '25');

      // ===== SIGNATURE SECTION =====
      checkPageBreak(250);
      doc.moveDown(1);
      doc.moveTo(50, doc.y).lineTo(562, doc.y).stroke('#cccccc');
      doc.moveDown(1);

      doc.fontSize(12).font('Helvetica-Bold').fillColor('#000000')
        .text('SIGNATURES', { align: 'center' });
      doc.moveDown(0.5);
      doc.fontSize(9.5).font('Helvetica').fillColor('#333333')
        .text('IN WITNESS WHEREOF, the parties have executed this Independent Contractor Driver and Policy Agreement as of the date first above written.', { align: 'justify' });
      doc.moveDown(1.5);

      // Company signatures
      doc.font('Helvetica-Bold').fillColor('#000000')
        .text('CARRIER: Pathway Transportation');
      doc.moveDown(0.8);
      doc.font('Helvetica');
      doc.text('_______________________________');
      doc.text('Diego Legaspi, Co-Chief Executive Officer');
      doc.moveDown(0.8);
      doc.text('_______________________________');
      doc.text('Yamil Morales, Co-Chief Executive Officer');
      doc.moveDown(1.5);

      // Contractor signature
      checkPageBreak(150);
      doc.font('Helvetica-Bold').text('CONTRACTOR:');
      doc.moveDown(0.5);
      doc.font('Helvetica');

      // If signature is drawn (base64 image)
      if (data.signatureType === 'draw' && data.signatureData.startsWith('data:image')) {
        try {
          const base64Data = data.signatureData.replace(/^data:image\/\w+;base64,/, '');
          const signatureBuffer = Buffer.from(base64Data, 'base64');
          doc.image(signatureBuffer, doc.x, doc.y, { width: 200, height: 60 });
          doc.moveDown(3);
        } catch (e) {
          doc.fontSize(16).font('Helvetica-Oblique').fillColor('#000000').text(data.contractorName);
          doc.fontSize(10).font('Helvetica');
        }
      } else {
        // Typed signature
        doc.fontSize(16).font('Helvetica-Oblique').fillColor('#000000').text(data.signatureData || data.contractorName);
        doc.fontSize(10).font('Helvetica');
      }

      doc.moveDown(0.5);
      doc.text('_______________________________');
      doc.text(`${data.contractorName}, Independent Contractor Driver`);
      doc.moveDown(0.5);
      doc.text(`Date Signed: ${currentDate}`);

      // Footer
      doc.fontSize(8).fillColor('#666666');
      doc.text(
        'This document was electronically generated and signed through the Pathway Transportation Driver Portal.',
        50,
        doc.page.height - 50,
        { align: 'center', width: 512 }
      );

      doc.end();
    } catch (error) {
      reject(error);
    }
  });
}

/**
 * Generate Equipment Lease Agreement PDF
 */
function generateLeaseAgreementPDF(data) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ margin: 50, size: 'LETTER' });
      const chunks = [];

      doc.on('data', chunk => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const currentDate = new Date().toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric'
      });

      // ===== PAGE 1 - Header and Parties =====
      // Header
      doc.fontSize(10).fillColor('#0099cc').font('Helvetica-Bold')
        .text('PATHWAY', 50, 50, { continued: true })
        .fillColor('#333333').text('WAY');
      doc.fontSize(8).fillColor('#666666').font('Helvetica')
        .text('T R A N S P O R T', 50, 62);

      doc.moveDown(2);

      // Title
      doc.fontSize(18).fillColor('#000000').font('Helvetica-Bold')
        .text('EQUIPMENT LEASE AGREEMENT', { align: 'center' });
      doc.moveDown(0.5);
      doc.moveTo(50, doc.y).lineTo(562, doc.y).stroke();
      doc.moveDown(1);

      // Intro paragraph
      doc.fontSize(10).font('Helvetica').fillColor('#333333');
      doc.text(`This Truck Lease Agreement ("Agreement") is made and entered into as of ${currentDate} ("Date"), by and between Morpro Inc. ("Carrier"), and ${data.ownerName} ("The Owner").`, {
        align: 'justify'
      });
      doc.moveDown(1.5);

      // Section 1 - Parties
      doc.fontSize(12).font('Helvetica-Bold').text('1. Parties Involved');
      doc.moveDown(0.5);
      doc.fontSize(10).font('Helvetica');
      doc.text('Carrier: ', { continued: true }).font('Helvetica-Bold')
        .text('Pathway Transportation Corp', { continued: true }).font('Helvetica')
        .text(' | MC 1592008 | USDOT 4148434');
      doc.text('Address: 2217 S. Lincoln Ave, Corona, CA 92882');
      doc.moveDown(0.5);
      doc.text(`The Owner: ${data.ownerName}`);
      const fullAddress = [data.ownerAddress, data.ownerCity, data.ownerState, data.ownerZip]
        .filter(Boolean).join(', ');
      doc.text(`Address: ${fullAddress || 'N/A'}`);
      doc.moveDown(1);

      // WHEREAS clauses
      doc.font('Helvetica-Bold').text('WHEREAS', { continued: true }).font('Helvetica')
        .text(', the Owner is the lawful owner of certain Motor vehicle equipment more fully described in Schedule A attached hereto ("Equipment")');
      doc.moveDown(0.5);
      doc.font('Helvetica-Bold').text('WHEREAS', { continued: true }).font('Helvetica')
        .text(', the Carrier is a registered motor carrier authorized to perform transportation services under the jurisdiction of the Federal Motor Carrier Safety Administration (FMCSA) and desires to lease the Equipment from the Owner Operator for conducting its authorized transportation services;');
      doc.moveDown(0.5);
      doc.font('Helvetica-Bold').text('AND WHEREAS', { continued: true }).font('Helvetica')
        .text(', the Owner desires to lease the Equipment to the Carrier under the terms and conditions set forth in this agreement and in compliance with the FMCSA regulations;');
      doc.moveDown(0.5);
      doc.font('Helvetica-Bold').text('NOW, THEREFORE', { continued: true }).font('Helvetica')
        .text(', in consideration of the premises and mutual covenants contained herein, and for other good and valuable consideration, the receipt and sufficiency of which are hereby acknowledged, the parties agree as follows:');
      doc.moveDown(1.5);

      // Section 2 - Duration
      doc.fontSize(12).font('Helvetica-Bold').text('2. Duration');
      doc.moveDown(0.5);
      doc.fontSize(10).font('Helvetica');
      doc.text('The term of this lease shall commence on the date of taking possession of the Equipment by the Carrier which shall continue for 12 months unless terminated earlier in accordance with the provisions of this Agreement. Any extensions shall be mutually agreed upon and documented in writing.', {
        align: 'justify'
      });
      doc.moveDown(1.5);

      // Section 3 - Schedule A - Equipment
      doc.fontSize(12).font('Helvetica-Bold').text('3. SCHEDULE A - DESCRIPTION OF EQUIPMENT');
      doc.moveDown(0.5);
      doc.fontSize(10).font('Helvetica').text('The following vehicle(s) and equipment are being leased:');
      doc.moveDown(0.5);

      // Equipment table
      const tableTop = doc.y;
      const tableLeft = 50;
      const colWidths = [30, 80, 80, 50, 120, 152];
      const rowHeight = 25;

      // Table header
      doc.font('Helvetica-Bold').fontSize(9);
      doc.rect(tableLeft, tableTop, 512, rowHeight).stroke();
      let xPos = tableLeft;
      ['No', 'Make', 'Model', 'Year', 'VIN', 'Description'].forEach((header, i) => {
        doc.text(header, xPos + 5, tableTop + 8, { width: colWidths[i] - 10 });
        xPos += colWidths[i];
        if (i < 5) {
          doc.moveTo(xPos, tableTop).lineTo(xPos, tableTop + rowHeight).stroke();
        }
      });

      // Table rows
      doc.font('Helvetica').fontSize(8);
      const equipment = data.equipment || [];
      for (let i = 0; i < 5; i++) {
        const rowTop = tableTop + rowHeight * (i + 1);
        doc.rect(tableLeft, rowTop, 512, rowHeight).stroke();

        xPos = tableLeft;
        const eq = equipment[i] || {};
        const values = [
          (i + 1).toString(),
          eq.make || '',
          eq.model || '',
          eq.year || '',
          eq.vin || '',
          eq.description || ''
        ];

        values.forEach((val, j) => {
          doc.text(val, xPos + 5, rowTop + 8, { width: colWidths[j] - 10 });
          xPos += colWidths[j];
          if (j < 5) {
            doc.moveTo(xPos, rowTop).lineTo(xPos, rowTop + rowHeight).stroke();
          }
        });
      }

      doc.moveDown(1);
      doc.y = tableTop + rowHeight * 6 + 10;
      doc.text('The Carrier provides and maintains the above equipment.');

      // ===== PAGE 2 =====
      doc.addPage();

      // Section 4 - Possession and Control
      doc.fontSize(12).font('Helvetica-Bold').text('4. Possession and Control');
      doc.moveDown(0.5);
      doc.fontSize(10).font('Helvetica');
      doc.text('Upon execution of this Agreement, the Carrier shall take control and possession of the Equipment and possession and control of the Equipment remain shall remain exclusively with the Carrier during the term of this Agreement. The Owner agrees to comply with the Carrier\'s rules and requests during the Agreement and Owner shall not take possession of the Equipment without taking permission from the Carrier.', {
        align: 'justify'
      });
      doc.moveDown(1.5);

      // Section 5 - Rate Schedule
      doc.fontSize(12).font('Helvetica-Bold').text('5. SCHEDULE B - Rate and Deduction Schedule');
      doc.moveDown(0.5);

      // Rate table
      const rateTableTop = doc.y;
      const rateColWidths = [100, 200, 212];

      doc.font('Helvetica-Bold').fontSize(9);
      ['Load Type', 'Rate', 'Payment Terms'].forEach((header, i) => {
        let xOffset = 50;
        for (let j = 0; j < i; j++) xOffset += rateColWidths[j];
        doc.text(header, xOffset + 5, rateTableTop + 5);
      });

      doc.font('Helvetica').fontSize(8);
      const rateTypes = ['Reefer', 'Flatbed', 'Dry Van', 'Multiple Stops', 'Partial Loads'];
      rateTypes.forEach((type, i) => {
        const rowTop = rateTableTop + 20 + (i * 35);
        doc.rect(50, rowTop, 512, 35).stroke();
        doc.text(type, 55, rowTop + 12);
        doc.text('12.25% of gross revenue\nplus operating expense\n2.75% Factoring', 155, rowTop + 5, { width: 190 });
        doc.text('1 week in arrears for loads\ndelivered previous week', 360, rowTop + 8, { width: 200 });
      });

      doc.y = rateTableTop + 20 + (5 * 35) + 15;

      // Section 6 - Insurance
      doc.fontSize(12).font('Helvetica-Bold').text('6. Insurance');
      doc.moveDown(0.5);
      doc.fontSize(10).font('Helvetica');
      doc.text('Carrier at Owner\'s cost, shall maintain at all times standard public liability and property damage insurance on the Equipment, covering both Owner and Carrier as per FMCSA for the use and operation of the Equipment, in the following limits: Bodily Injury and Property Damage, $1,000,000.00 Combined Single Limit.', {
        align: 'justify'
      });
      doc.moveDown(1);

      // Section 7 - Charge-Back Items
      doc.fontSize(12).font('Helvetica-Bold').text('7. Charge-Back Items');
      doc.moveDown(0.5);
      doc.fontSize(10).font('Helvetica');
      doc.text('The following items may be initially paid by the Carrier but will be deducted from the Owner\'s compensation:');
      doc.moveDown(0.3);
      const chargeBackItems = [
        'Fuel Costs', 'Maintenance and Repairs', 'Insurance Premiums', 'Toll Fees',
        'Licensing and Permits', 'Load Advances', 'Communication Devices', 'Trailer Rental Fees'
      ];
      chargeBackItems.forEach(item => {
        doc.text(`• ${item}`, { indent: 20 });
      });

      // ===== PAGE 3 - Termination and other clauses =====
      doc.addPage();

      // Section 8 - Termination
      doc.fontSize(12).font('Helvetica-Bold').text('8. Termination Procedures');
      doc.moveDown(0.5);
      doc.fontSize(10).font('Helvetica');
      doc.text('Either Owner or Carrier may cancel this Agreement at any time by giving to the other party thirty (30) days prior written notice of intent to do so, provided that the Owner is not past due on any amounts prepaid by the Carrier.', {
        align: 'justify'
      });
      doc.moveDown(1);

      // Section 9 - Maintenance
      doc.fontSize(12).font('Helvetica-Bold').text('9. Maintenance and Repair Obligations');
      doc.moveDown(0.5);
      doc.fontSize(10).font('Helvetica');
      doc.text('The Owner is responsible for all costs for general maintenance of the Equipment. This includes regular oil changes, tire rotations, brake inspections, and other routine maintenance necessary to keep the equipment in good working order. The Carrier will promptly notify Owner of any needed repairs.', {
        align: 'justify'
      });
      doc.moveDown(1);

      // Additional sections summary
      doc.fontSize(12).font('Helvetica-Bold').text('10. Additional Terms');
      doc.moveDown(0.5);
      doc.fontSize(10).font('Helvetica');
      doc.text('The Owner agrees to comply with all applicable laws, regulations, and ordinances in the operation of the leased equipment. The Owner is not required to purchase or rent any products, equipment, or services from the Carrier as a condition of entering into this lease.', {
        align: 'justify'
      });
      doc.moveDown(2);

      // ===== SIGNATURE SECTION =====
      doc.moveTo(50, doc.y).lineTo(562, doc.y).stroke();
      doc.moveDown(1);

      doc.fontSize(12).font('Helvetica-Bold').text('SIGNATURES');
      doc.moveDown(1);
      doc.fontSize(10).font('Helvetica');
      doc.text('IN WITNESS WHEREOF, the parties have executed this Equipment Lease Agreement as of the date first above written.');
      doc.moveDown(2);

      // Carrier signatures
      doc.font('Helvetica-Bold').text('CARRIER: Pathway Transportation Corp');
      doc.moveDown(1);
      doc.font('Helvetica');
      doc.text('_______________________________');
      doc.text('Diego Legaspi, Co-Chief Executive Officer');
      doc.moveDown(1);
      doc.text('_______________________________');
      doc.text('Yamil Morales, Co-Chief Executive Officer');
      doc.moveDown(2);

      // Owner signature
      doc.font('Helvetica-Bold').text('OWNER:');
      doc.moveDown(0.5);
      doc.font('Helvetica');

      // If signature is drawn (base64 image)
      if (data.signatureType === 'draw' && data.signatureData.startsWith('data:image')) {
        try {
          const base64Data = data.signatureData.replace(/^data:image\/\w+;base64,/, '');
          const signatureBuffer = Buffer.from(base64Data, 'base64');
          doc.image(signatureBuffer, doc.x, doc.y, { width: 200, height: 60 });
          doc.moveDown(3);
        } catch (e) {
          doc.text(`Signature: ${data.ownerName}`, { font: 'Helvetica-Oblique' });
        }
      } else {
        // Typed signature
        doc.fontSize(16).font('Helvetica-Oblique').text(data.signatureData || data.ownerName);
        doc.fontSize(10).font('Helvetica');
      }

      doc.moveDown(0.5);
      doc.text('_______________________________');
      doc.text(`${data.ownerName}, Owner`);
      doc.moveDown(0.5);
      doc.text(`Date Signed: ${currentDate}`);

      // Footer
      doc.fontSize(8).fillColor('#666666');
      doc.text(
        'This document was electronically generated and signed through the Pathway Transportation Corp Driver Portal.',
        50,
        doc.page.height - 50,
        { align: 'center', width: 512 }
      );

      doc.end();
    } catch (error) {
      reject(error);
    }
  });
}

module.exports = router;
