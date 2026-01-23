'use strict';

const express = require('express');
const router = express.Router();
const multer = require('multer');
const { authenticateToken, requireAdmin } = require('../middleware/auth');
const s3Service = require('../services/s3');
const { CompanyDocument, User } = require('../models');

// Configure multer for memory storage
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB limit
  fileFilter: (req, file, cb) => {
    const allowedTypes = [
      'application/pdf',
      'image/jpeg',
      'image/png',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    ];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type'), false);
    }
  }
});

// Document types available for company documents
const COMPANY_DOCUMENT_TYPES = {
  mc_authority: 'MC Authority',
  w9: 'W-9 Form',
  ucr: 'UCR Registration',
  coi: 'Certificate of Insurance',
  dot_authority: 'DOT Authority',
  ifta: 'IFTA License',
  irp: 'IRP Registration',
  hazmat: 'Hazmat Permit',
  oversize: 'Oversize/Overweight Permit',
  other: 'Other Document'
};

// GET /api/company-documents/types - Get available document types
router.get('/types', (req, res) => {
  res.json({
    success: true,
    data: COMPANY_DOCUMENT_TYPES
  });
});

// GET /api/company-documents - Get all company documents (drivers see active only)
router.get('/', authenticateToken, async (req, res) => {
  try {
    const isAdmin = req.user.role === 'admin';
    
    const where = isAdmin ? {} : { isActive: true };
    
    const documents = await CompanyDocument.findAll({
      where,
      include: [{
        model: User,
        as: 'uploader',
        attributes: ['id', 'firstName', 'lastName']
      }],
      order: [['documentType', 'ASC'], ['createdAt', 'DESC']]
    });

    // Generate download URLs for each document
    const documentsWithUrls = documents.map(doc => ({
      id: doc.id,
      name: doc.name,
      description: doc.description,
      documentType: doc.documentType,
      documentTypeName: COMPANY_DOCUMENT_TYPES[doc.documentType] || doc.documentType,
      originalFilename: doc.originalFilename,
      fileSize: doc.fileSize,
      mimeType: doc.mimeType,
      isActive: doc.isActive,
      uploadedBy: doc.uploader ? `${doc.uploader.firstName} ${doc.uploader.lastName}` : null,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
      url: `https://${process.env.AWS_S3_BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com/${doc.s3Key}`
    }));

    res.json({
      success: true,
      data: documentsWithUrls
    });
  } catch (error) {
    console.error('Get company documents error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch company documents',
      error: error.message
    });
  }
});

// POST /api/company-documents - Upload new company document (admin only)
router.post('/', authenticateToken, requireAdmin, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: 'No file uploaded'
      });
    }

    const { name, description, documentType } = req.body;

    if (!name || !documentType) {
      return res.status(400).json({
        success: false,
        message: 'Name and document type are required'
      });
    }

    if (!COMPANY_DOCUMENT_TYPES[documentType]) {
      return res.status(400).json({
        success: false,
        message: 'Invalid document type',
        validTypes: Object.keys(COMPANY_DOCUMENT_TYPES)
      });
    }

    // Upload to S3
    const result = await s3Service.uploadFile(
      req.file.buffer,
      'company',
      documentType,
      req.file.originalname,
      req.file.mimetype
    );

    // Create database record
    const document = await CompanyDocument.create({
      name,
      description,
      documentType,
      s3Key: result.key,
      originalFilename: req.file.originalname,
      mimeType: req.file.mimetype,
      fileSize: req.file.size,
      isActive: true,
      uploadedBy: req.user.id
    });

    res.status(201).json({
      success: true,
      message: 'Document uploaded successfully',
      data: {
        id: document.id,
        name: document.name,
        documentType: document.documentType,
        documentTypeName: COMPANY_DOCUMENT_TYPES[document.documentType],
        originalFilename: document.originalFilename,
        url: result.url
      }
    });
  } catch (error) {
    console.error('Upload company document error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to upload document',
      error: error.message
    });
  }
});

// PUT /api/company-documents/:id - Update company document (admin only)
router.put('/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, description, isActive } = req.body;

    const document = await CompanyDocument.findByPk(id);
    if (!document) {
      return res.status(404).json({
        success: false,
        message: 'Document not found'
      });
    }

    await document.update({
      name: name !== undefined ? name : document.name,
      description: description !== undefined ? description : document.description,
      isActive: isActive !== undefined ? isActive : document.isActive
    });

    res.json({
      success: true,
      message: 'Document updated successfully',
      data: document
    });
  } catch (error) {
    console.error('Update company document error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update document',
      error: error.message
    });
  }
});

// DELETE /api/company-documents/:id - Delete company document (admin only)
router.delete('/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    const document = await CompanyDocument.findByPk(id);
    if (!document) {
      return res.status(404).json({
        success: false,
        message: 'Document not found'
      });
    }

    // Delete from S3
    try {
      await s3Service.deleteFile(document.s3Key);
    } catch (e) {
      console.warn('Failed to delete from S3:', e.message);
    }

    // Delete from database
    await document.destroy();

    res.json({
      success: true,
      message: 'Document deleted successfully'
    });
  } catch (error) {
    console.error('Delete company document error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete document',
      error: error.message
    });
  }
});

module.exports = router;
