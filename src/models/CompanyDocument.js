'use strict';

const { Model, DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  class CompanyDocument extends Model {
    static associate(models) {
      CompanyDocument.belongsTo(models.User, {
        foreignKey: 'uploadedBy',
        as: 'uploader'
      });
    }
  }

  CompanyDocument.init({
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true
    },
    name: {
      type: DataTypes.STRING(255),
      allowNull: false
    },
    description: {
      type: DataTypes.TEXT,
      allowNull: true
    },
    documentType: {
      type: DataTypes.STRING(50),
      allowNull: false,
      field: 'document_type'
    },
    s3Key: {
      type: DataTypes.STRING(500),
      allowNull: false,
      field: 's3_key'
    },
    originalFilename: {
      type: DataTypes.STRING(255),
      allowNull: false,
      field: 'original_filename'
    },
    mimeType: {
      type: DataTypes.STRING(100),
      allowNull: true,
      field: 'mime_type'
    },
    fileSize: {
      type: DataTypes.INTEGER,
      allowNull: true,
      field: 'file_size'
    },
    isActive: {
      type: DataTypes.BOOLEAN,
      defaultValue: true,
      field: 'is_active'
    },
    uploadedBy: {
      type: DataTypes.UUID,
      allowNull: true,
      field: 'uploaded_by'
    }
  }, {
    sequelize,
    modelName: 'CompanyDocument',
    tableName: 'company_documents',
    underscored: true,
    timestamps: true
  });

  return CompanyDocument;
};
