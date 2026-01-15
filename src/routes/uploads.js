'use strict';

const express = require('express');
const router = express.Router();
const multer = require('multer');
const { authenticateToken } = require('../middleware/auth');
const s3Service = require('../services/s3');
const { Document } = require('../models');

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

module.exports = router;
