const express = require('express');
const router = express.Router();
const { body, query, validationResult } = require('express-validator');
const { Op } = require('sequelize');
const { Application, User, Document } = require('../models');
const { authenticateToken, requireAdmin } = require('../middleware/auth');
const goHighLevelService = require('../services/goHighLevel');
const s3Service = require('../services/s3');

// All admin routes require authentication and admin role
router.use(authenticateToken, requireAdmin);

// GET /api/admin/applications - List all applications with filters
router.get('/applications', async (req, res) => {
  try {
    const {
      status,
      position,
      search,
      page = 1,
      limit = 20,
      sortBy = 'submittedAt',
      sortOrder = 'DESC'
    } = req.query;

    const where = {};

    // Filter by status
    if (status && status !== 'all') {
      where.status = status;
    }

    // Filter by position
    if (position && position !== 'all') {
      where.position = position;
    }

    // Search by name, email, or application ID
    if (search) {
      where[Op.or] = [
        { firstName: { [Op.like]: `%${search}%` } },
        { lastName: { [Op.like]: `%${search}%` } },
        { email: { [Op.like]: `%${search}%` } },
        { applicationId: { [Op.like]: `%${search}%` } }
      ];
    }

    const offset = (parseInt(page) - 1) * parseInt(limit);

    const { count, rows: applications } = await Application.findAndCountAll({
      where,
      include: [{
        model: User,
        as: 'user',
        attributes: ['id', 'email', 'firstName', 'lastName', 'phone', 'createdAt']
      }],
      order: [[sortBy, sortOrder]],
      limit: parseInt(limit),
      offset
    });

    res.json({
      success: true,
      data: {
        applications,
        pagination: {
          total: count,
          page: parseInt(page),
          limit: parseInt(limit),
          totalPages: Math.ceil(count / parseInt(limit))
        }
      }
    });
  } catch (error) {
    console.error('List applications error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to list applications'
    });
  }
});

// GET /api/admin/applications/:id - Get single application
router.get('/applications/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const application = await Application.findOne({
      where: {
        [Op.or]: [
          { id },
          { applicationId: id }
        ]
      },
      include: [{
        model: User,
        as: 'user',
        attributes: ['id', 'email', 'firstName', 'lastName', 'phone', 'createdAt', 'lastLoginAt']
      }]
    });

    if (!application) {
      return res.status(404).json({
        success: false,
        message: 'Application not found'
      });
    }

    res.json({
      success: true,
      data: application
    });
  } catch (error) {
    console.error('Get application error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get application'
    });
  }
});

// PUT /api/admin/applications/:id/status - Update application status
router.put('/applications/:id/status', [
  body('status').isIn(['pending', 'review', 'background', 'approved', 'rejected'])
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors: errors.array()
      });
    }

    const { id } = req.params;
    const { status, notes } = req.body;

    const application = await Application.findOne({
      where: {
        [Op.or]: [
          { id },
          { applicationId: id }
        ]
      }
    });

    if (!application) {
      return res.status(404).json({
        success: false,
        message: 'Application not found'
      });
    }

    // Update status
    await application.update({
      status,
      reviewedBy: req.user.id,
      reviewedAt: new Date(),
      ...(notes && { adminNotes: application.adminNotes ? `${application.adminNotes}\n\n${notes}` : notes })
    });

    // Sync status to GoHighLevel
    try {
      await goHighLevelService.updateContactStatus(application.ghlContactId, status);
    } catch (ghlError) {
      console.error('GoHighLevel status update error:', ghlError);
    }

    res.json({
      success: true,
      message: 'Application status updated',
      data: application
    });
  } catch (error) {
    console.error('Update status error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update status'
    });
  }
});

// PUT /api/admin/applications/:id/notes - Add admin notes
router.put('/applications/:id/notes', [
  body('notes').trim().notEmpty()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors: errors.array()
      });
    }

    const { id } = req.params;
    const { notes } = req.body;

    const application = await Application.findOne({
      where: {
        [Op.or]: [
          { id },
          { applicationId: id }
        ]
      }
    });

    if (!application) {
      return res.status(404).json({
        success: false,
        message: 'Application not found'
      });
    }

    const timestamp = new Date().toISOString();
    const newNote = `[${timestamp}] ${req.user.firstName} ${req.user.lastName}: ${notes}`;
    const updatedNotes = application.adminNotes
      ? `${application.adminNotes}\n\n${newNote}`
      : newNote;

    await application.update({ adminNotes: updatedNotes });

    res.json({
      success: true,
      message: 'Notes added',
      data: application
    });
  } catch (error) {
    console.error('Add notes error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to add notes'
    });
  }
});

// GET /api/admin/stats - Dashboard statistics
router.get('/stats', async (req, res) => {
  try {
    const [
      totalApplications,
      pendingCount,
      reviewCount,
      backgroundCount,
      approvedCount,
      rejectedCount,
      ownerOperatorCount,
      leaseOperatorCount,
      driverCount
    ] = await Promise.all([
      Application.count(),
      Application.count({ where: { status: 'pending' } }),
      Application.count({ where: { status: 'review' } }),
      Application.count({ where: { status: 'background' } }),
      Application.count({ where: { status: 'approved' } }),
      Application.count({ where: { status: 'rejected' } }),
      Application.count({ where: { position: 'OO' } }),
      Application.count({ where: { position: 'LO' } }),
      Application.count({ where: { position: 'DR' } })
    ]);

    // Recent applications (last 7 days)
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const recentCount = await Application.count({
      where: {
        submittedAt: { [Op.gte]: sevenDaysAgo }
      }
    });

    res.json({
      success: true,
      data: {
        total: totalApplications,
        byStatus: {
          pending: pendingCount,
          review: reviewCount,
          background: backgroundCount,
          approved: approvedCount,
          rejected: rejectedCount
        },
        byPosition: {
          ownerOperator: ownerOperatorCount,
          leaseOperator: leaseOperatorCount,
          driver: driverCount
        },
        recentApplications: recentCount
      }
    });
  } catch (error) {
    console.error('Stats error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get stats'
    });
  }
});

// GET /api/admin/users - List all users
router.get('/users', async (req, res) => {
  try {
    const { role, search, page = 1, limit = 20 } = req.query;

    const where = {};

    if (role && role !== 'all') {
      where.role = role;
    }

    if (search) {
      where[Op.or] = [
        { firstName: { [Op.like]: `%${search}%` } },
        { lastName: { [Op.like]: `%${search}%` } },
        { email: { [Op.like]: `%${search}%` } }
      ];
    }

    const offset = (parseInt(page) - 1) * parseInt(limit);

    const { count, rows: users } = await User.findAndCountAll({
      where,
      attributes: { exclude: ['password'] },
      order: [['createdAt', 'DESC']],
      limit: parseInt(limit),
      offset
    });

    res.json({
      success: true,
      data: {
        users,
        pagination: {
          total: count,
          page: parseInt(page),
          limit: parseInt(limit),
          totalPages: Math.ceil(count / parseInt(limit))
        }
      }
    });
  } catch (error) {
    console.error('List users error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to list users'
    });
  }
});

// GET /api/admin/applications/:id/documents - Get documents for an application's user
router.get('/applications/:id/documents', async (req, res) => {
  try {
    const { id } = req.params;

    // Find the application first
    const application = await Application.findOne({
      where: {
        [Op.or]: [
          { id },
          { applicationId: id }
        ]
      }
    });

    if (!application) {
      return res.status(404).json({
        success: false,
        message: 'Application not found'
      });
    }

    // Get documents for this user
    const documents = await Document.findAll({
      where: { userId: application.userId },
      order: [['uploadedAt', 'DESC']]
    });

    // Add signed URLs
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

    // Required document types
    const requiredDocs = ['cdl', 'medical', 'mvr', 'registration', 'insurance', 'w9'];
    const uploadedTypes = documents.map(d => d.documentType);
    const missingDocs = requiredDocs.filter(d => !uploadedTypes.includes(d));

    res.json({
      success: true,
      data: {
        documents: documentsWithUrls,
        summary: {
          total: documents.length,
          required: requiredDocs.length,
          uploaded: uploadedTypes.filter(t => requiredDocs.includes(t)).length,
          missing: missingDocs,
          progress: Math.round((uploadedTypes.filter(t => requiredDocs.includes(t)).length / requiredDocs.length) * 100)
        }
      }
    });
  } catch (error) {
    console.error('Get application documents error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get documents'
    });
  }
});

// GET /api/admin/documents/by-email/:email - Get documents by user email
router.get('/documents/by-email/:email', async (req, res) => {
  try {
    const { email } = req.params;

    // Find the user by email
    const user = await User.findOne({
      where: { email: email.toLowerCase() }
    });

    if (!user) {
      return res.json({
        success: true,
        data: {
          documents: [],
          summary: {
            total: 0,
            required: 6,
            uploaded: 0,
            missing: ['cdl', 'medical', 'mvr', 'registration', 'insurance', 'w9'],
            progress: 0
          }
        }
      });
    }

    // Get documents for this user
    const documents = await Document.findAll({
      where: { userId: user.id },
      order: [['uploadedAt', 'DESC']]
    });

    // Add signed URLs
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
          filename: doc.originalFilename,
          mimeType: doc.mimeType,
          fileSize: doc.fileSize,
          status: doc.status,
          uploadedAt: doc.uploadedAt,
          url: signedUrl
        };
      })
    );

    // Required document types
    const requiredDocs = ['cdl', 'medical', 'mvr', 'registration', 'insurance', 'w9'];
    const uploadedTypes = documents.map(d => d.documentType);
    const missingDocs = requiredDocs.filter(d => !uploadedTypes.includes(d));

    res.json({
      success: true,
      data: {
        documents: documentsWithUrls,
        summary: {
          total: documents.length,
          required: requiredDocs.length,
          uploaded: uploadedTypes.filter(t => requiredDocs.includes(t)).length,
          missing: missingDocs,
          progress: Math.round((uploadedTypes.filter(t => requiredDocs.includes(t)).length / requiredDocs.length) * 100)
        }
      }
    });
  } catch (error) {
    console.error('Get documents by email error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get documents'
    });
  }
});

// PUT /api/admin/applications/:id - Update/edit application data
router.put('/applications/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;

    const application = await Application.findOne({
      where: {
        [Op.or]: [
          { id },
          { applicationId: id }
        ]
      }
    });

    if (!application) {
      return res.status(404).json({
        success: false,
        message: 'Application not found'
      });
    }

    // Fields that can be updated
    const allowedFields = [
      'firstName', 'lastName', 'email', 'phone', 'dateOfBirth', 'ssn', 'startDate',
      'streetAddress', 'city', 'state', 'zipCode',
      'cdlNumber', 'cdlState', 'cdlClass', 'licenseExpiration', 'endorsements', 'hasTWIC', 'twicExpiration',
      'yearsExperience', 'hasAccidents', 'accidentDetails', 'hasViolations', 'violationDetails', 'hasDUI', 'duiDetails',
      'employer1Name', 'employer1Phone', 'employer1Position', 'employer1StartDate', 'employer1EndDate', 'employer1ReasonLeaving',
      'employer2Name', 'employer2Phone', 'employer2Position', 'employer2StartDate', 'employer2EndDate', 'employer2ReasonLeaving',
      'hasOwnTruck', 'truckYear', 'truckMake', 'truckModel', 'truckVIN',
      'hasTrailer', 'trailerType', 'trailerLength',
      'ref1Name', 'ref1Phone', 'ref1Relationship',
      'ref2Name', 'ref2Phone', 'ref2Relationship',
      'position', 'status'
    ];

    // Filter to only allowed fields
    const filteredUpdates = {};
    for (const [key, value] of Object.entries(updates)) {
      if (allowedFields.includes(key)) {
        filteredUpdates[key] = value;
      }
    }

    await application.update(filteredUpdates);

    // Fetch updated application with user info
    const updatedApp = await Application.findOne({
      where: { id: application.id },
      include: [{
        model: User,
        as: 'user',
        attributes: ['id', 'email', 'firstName', 'lastName', 'phone', 'createdAt']
      }]
    });

    res.json({
      success: true,
      message: 'Application updated successfully',
      data: updatedApp
    });
  } catch (error) {
    console.error('Update application error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update application'
    });
  }
});

// GET /api/admin/applications/:id/full - Get application with documents and progress
router.get('/applications/:id/full', async (req, res) => {
  try {
    const { id } = req.params;

    const application = await Application.findOne({
      where: {
        [Op.or]: [
          { id },
          { applicationId: id }
        ]
      },
      include: [{
        model: User,
        as: 'user',
        attributes: ['id', 'email', 'firstName', 'lastName', 'phone', 'createdAt', 'lastLoginAt']
      }]
    });

    if (!application) {
      return res.status(404).json({
        success: false,
        message: 'Application not found'
      });
    }

    // Get documents if user exists
    let documents = [];
    let documentSummary = { total: 0, required: 6, uploaded: 0, missing: ['cdl', 'medical', 'mvr', 'registration', 'insurance', 'w9'], progress: 0 };

    if (application.userId) {
      const docs = await Document.findAll({
        where: { userId: application.userId },
        order: [['uploadedAt', 'DESC']]
      });

      documents = await Promise.all(
        docs.map(async (doc) => {
          let signedUrl = null;
          try {
            signedUrl = await s3Service.getSignedDownloadUrl(doc.s3Key);
          } catch (e) {}
          return {
            id: doc.id,
            type: doc.documentType,
            typeName: s3Service.DOCUMENT_TYPES[doc.documentType] || doc.documentType,
            key: doc.s3Key,
            originalName: doc.originalFilename,
            status: doc.status,
            uploadedAt: doc.uploadedAt,
            url: signedUrl
          };
        })
      );

      const requiredDocs = ['cdl', 'medical', 'mvr', 'registration', 'insurance', 'w9'];
      const uploadedTypes = docs.map(d => d.documentType);
      documentSummary = {
        total: docs.length,
        required: requiredDocs.length,
        uploaded: uploadedTypes.filter(t => requiredDocs.includes(t)).length,
        missing: requiredDocs.filter(d => !uploadedTypes.includes(d)),
        progress: Math.round((uploadedTypes.filter(t => requiredDocs.includes(t)).length / requiredDocs.length) * 100)
      };
    }

    // Calculate application progress
    const requiredFields = [
      'firstName', 'lastName', 'email', 'phone', 'dateOfBirth',
      'streetAddress', 'city', 'state', 'zipCode',
      'cdlNumber', 'cdlState', 'cdlClass', 'licenseExpiration',
      'yearsExperience',
      'employer1Name', 'employer1Phone'
    ];

    const optionalFields = [
      'ssn', 'startDate', 'endorsements', 'hasTWIC', 'twicExpiration',
      'hasAccidents', 'accidentDetails', 'hasViolations', 'violationDetails',
      'employer2Name', 'employer2Phone',
      'hasOwnTruck', 'truckYear', 'truckMake', 'truckModel', 'truckVIN',
      'hasTrailer', 'trailerType', 'trailerLength',
      'ref1Name', 'ref1Phone', 'ref2Name', 'ref2Phone'
    ];

    const appData = application.toJSON();
    const filledRequired = requiredFields.filter(f => appData[f] !== null && appData[f] !== '' && appData[f] !== undefined).length;
    const filledOptional = optionalFields.filter(f => appData[f] !== null && appData[f] !== '' && appData[f] !== undefined).length;
    const missingRequired = requiredFields.filter(f => appData[f] === null || appData[f] === '' || appData[f] === undefined);

    const applicationProgress = {
      requiredFields: requiredFields.length,
      filledRequired,
      optionalFields: optionalFields.length,
      filledOptional,
      missingRequired,
      progress: Math.round((filledRequired / requiredFields.length) * 100),
      totalProgress: Math.round(((filledRequired + filledOptional) / (requiredFields.length + optionalFields.length)) * 100)
    };

    res.json({
      success: true,
      data: {
        application,
        documents,
        documentSummary,
        applicationProgress
      }
    });
  } catch (error) {
    console.error('Get full application error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get application'
    });
  }
});

// PUT /api/admin/documents/:id/status - Update document verification status
router.put('/documents/:id/status', async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (!['pending', 'approved', 'rejected'].includes(status)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid status. Must be: pending, approved, or rejected'
      });
    }

    const document = await Document.findByPk(id);
    if (!document) {
      return res.status(404).json({
        success: false,
        message: 'Document not found'
      });
    }

    await document.update({ status });

    res.json({
      success: true,
      message: 'Document status updated',
      data: document
    });
  } catch (error) {
    console.error('Update document status error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update document status'
    });
  }
});

module.exports = router;
